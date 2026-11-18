/**
 * Label Pool: background crawler + stratified round server for the dev Round Labeler.
 *
 * Variety: crawls Henrik v4 match lists for seed accounts (owner, friends, pros) and snowballs through
 * every player met (owner's teammates, opponents, their opponents...). The next account to crawl is the
 * one whose source and rank band are least represented, so labels spread across ranks, roles and maps.
 *
 * Supply follows demand: the crawler only runs while someone has asked for a round in the last
 * ACTIVE_WINDOW_MS, one list call (10 full matches) at a time through the shared token bucket.
 * Never runs inside a request. Everything lives under data/label_pool (gitignored: real names/PUUIDs).
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const valorantApiService = require('./valorantApiService');
const { globalTokenBucket } = require('./ingestionQueue');
const { normalizeV4Match } = require('../adapters/v4PayloadAdapter');
const { isSupportedQueue, getTierBand } = require('../config/telemetryConfig');
const { getCandidateSituations, buildRadarSnapshot, getLabels } = require('./devTelemetryService');
const { groupKillsByRound } = require('./situationDetectors');

const POOL_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'label_pool');
const MATCH_DIR = path.join(POOL_DIR, 'matches');
const STATE_FILE = path.join(POOL_DIR, 'state.json');
const INDEX_FILE = path.join(POOL_DIR, 'candidates.jsonl');
const STORE_CACHE_FILE = path.resolve(__dirname, '..', '..', 'data', 'store_cache.json');

const CRAWL_COST = 6;                  // token units per list call: 1 request + Henrik's background Riot fetches
const MIN_CRAWL_GAP_MS = 20 * 1000;    // at most ~3 list calls/min, leaving budget for real user syncs
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;       // a served round is held for its rater so friends don't get duplicates
const MAX_POOL_MATCHES = 5000;
const FRONTIER_CAP = 8000;
const SEED_RECRAWL_MS = 24 * 60 * 60 * 1000; // seeds (pros, friends) get re-crawled daily for new games
const SOURCES = ['owner', 'friend', 'pro', 'teammate', 'scraped', 'snowball'];
const DEFAULT_REGION = process.env.LABEL_POOL_REGION || 'ap';

let state = null;        // { seeds, frontier, crawled, matchSources, lastError, lastFetchAt }
let candidateById = new Map();
let candidates = null;   // [{ id, sid, matchId, puuid, riotId, bucket, category, tag, role, side, map, rankBand, source, round }]
let labeledIds = null;   // Set of candidate ids already labeled
let bucketLabelCounts = null;
let matchLabelCounts = null;
const leases = new Map();
let lastActivityAt = 0;
let crawling = false;
let lastCrawlAt = 0;
const matchCache = new Map();

const keyOf = e => (e.puuid || e.riotId || '').toLowerCase();

function ensureDirs() {
  fs.mkdirSync(MATCH_DIR, { recursive: true });
}

function saveState() {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

function readMatch(matchId) {
  if (matchCache.has(matchId)) return matchCache.get(matchId);
  const file = path.join(MATCH_DIR, `${matchId}.json`);
  if (!fs.existsSync(file)) return null;
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (matchCache.size > 50) matchCache.delete(matchCache.keys().next().value);
  matchCache.set(matchId, rec);
  return rec;
}

function refreshLabelIndex() {
  labeledIds = new Set();
  bucketLabelCounts = {};
  matchLabelCounts = {};
  for (const l of getLabels()) {
    if (!l.candidate_id) continue;
    labeledIds.add(l.candidate_id);
    const c = candidateById.get(l.candidate_id);
    if (c) {
      bucketLabelCounts[c.bucket] = (bucketLabelCounts[c.bucket] || 0) + 1;
      matchLabelCounts[c.matchId] = (matchLabelCounts[c.matchId] || 0) + 1;
    }
  }
}

/** Adds a player met in a match to the frontier (deduped, capped; snowball entries are dropped first). */
function addToFrontier(entry) {
  const k = keyOf(entry);
  if (!k || state.crawled[k] || state.frontier.some(f => keyOf(f) === k)) return;
  state.frontier.push(entry);
  if (state.frontier.length > FRONTIER_CAP) {
    const idx = state.frontier.findIndex(f => f.source === 'snowball');
    state.frontier.splice(idx >= 0 ? idx : 0, 1);
  }
}

/** Builds labeling candidates for all 10 players of a match and appends them to the index. */
function indexMatch(rec) {
  const m = rec.match;
  const lines = [];
  for (const p of m.all_players || []) {
    const riotId = `${p.name}#${p.tag}`;
    let data;
    try {
      data = getCandidateSituations({ matchData: m, matchId: m.matchId, playerRiotId: riotId });
    } catch {
      continue;
    }
    if (data.subject.toLowerCase() !== riotId.toLowerCase()) continue;
    for (const s of data.situations) {
      const c = {
        id: crypto.createHash('sha1').update(`${m.matchId}|${p.puuid}|${s.id}`).digest('hex').slice(0, 16), // opaque: no PUUID reaches the browser
        sid: s.id,
        matchId: m.matchId,
        puuid: p.puuid,
        riotId,
        bucket: s.category === 'flagged' ? s.detector_tag : s.category.toUpperCase(),
        category: s.category,
        tag: s.detector_tag || null,
        role: data.role || 'Unknown',
        side: s.side,
        map: m.map,
        rankBand: getTierBand(p.tier) || 'Unranked',
        source: rec.source,
        round: s.round
      };
      candidates.push(c);
      candidateById.set(c.id, c);
      lines.push(JSON.stringify(c));
    }
  }
  if (lines.length) fs.appendFileSync(INDEX_FILE, lines.join('\n') + '\n', 'utf8');
}

/** Stores one normalized match in the pool and grows the frontier from its players. */
function addMatch(normalized, source, region, fetchedFor) {
  const matchId = normalized.matchId;
  if (!matchId || state.matchSources[matchId]) return false;
  const rec = { source, region, fetchedFor, fetchedAt: new Date().toISOString(), match: normalized };
  ensureDirs();
  fs.writeFileSync(path.join(MATCH_DIR, `${matchId}.json`), JSON.stringify(rec), 'utf8');
  state.matchSources[matchId] = source;
  indexMatch(rec);

  const ownerTeam = source === 'owner'
    ? (normalized.all_players || []).find(p => p.puuid === normalized.player_puuid)?.team
    : null;
  for (const p of normalized.all_players || []) {
    if (!p.puuid || p.puuid === normalized.player_puuid) continue;
    const s = ownerTeam && p.team === ownerTeam ? 'teammate' : 'snowball';
    addToFrontier({ puuid: p.puuid, region, source: s, tier: p.tier || 'Unranked', addedAt: Date.now() });
  }
  return true;
}

/** Imports the owner's already-synced matches (zero API cost) on first run. */
function bootstrapFromStoreCache() {
  if (!fs.existsSync(STORE_CACHE_FILE)) return;
  try {
    const cache = JSON.parse(fs.readFileSync(STORE_CACHE_FILE, 'utf8'));
    for (const [riotId, list] of Object.entries(cache.matches || {})) {
      const region = cache.players?.[riotId]?.region || DEFAULT_REGION;
      for (const m of Object.values(list || {})) {
        if (isSupportedQueue(m).supported) addMatch(m, 'owner', region, riotId);
      }
    }
  } catch (err) {
    console.warn('[labelPool] Could not import store cache:', err.message);
  }
}

function init() {
  if (state) return;
  ensureDirs();
  state = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { seeds: [], frontier: [], crawled: {}, matchSources: {}, lastError: null, lastFetchAt: null };
  candidates = fs.existsSync(INDEX_FILE)
    ? fs.readFileSync(INDEX_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  candidateById = new Map(candidates.map(c => [c.id, c]));
  if (Object.keys(state.matchSources).length === 0) {
    bootstrapFromStoreCache();
    saveState();
  }
  refreshLabelIndex();
}

/** Picks the next account: least-represented source first, then least-represented rank band. */
function pickNextAccount() {
  const now = Date.now();
  const dueSeeds = state.seeds.filter(s => now - (state.crawled[keyOf(s)] || 0) > SEED_RECRAWL_MS);
  const pool = [...dueSeeds, ...state.frontier];
  if (!pool.length) return null;

  const roundsBySource = {};
  const roundsByBand = {};
  for (const c of candidates) {
    roundsBySource[c.source] = (roundsBySource[c.source] || 0) + 1;
    roundsByBand[c.rankBand] = (roundsByBand[c.rankBand] || 0) + 1;
  }
  const sourceOrder = SOURCES.filter(s => pool.some(e => e.source === s))
    .sort((a, b) => (roundsBySource[a] || 0) - (roundsBySource[b] || 0));
  const fromSource = pool.filter(e => e.source === sourceOrder[0]);
  const band = e => getTierBand(e.tier) || 'Unranked';
  fromSource.sort((a, b) => (roundsByBand[band(a)] || 0) - (roundsByBand[band(b)] || 0));
  return fromSource[0];
}

async function fetchMatchList(acct) {
  if (acct.puuid) return valorantApiService.fetchPlayerMatchesByPuuidV4(acct.region, acct.puuid, 0, 10);
  const [name, tag] = acct.riotId.split('#');
  return valorantApiService.fetchPlayerMatchesV4(acct.region, name, tag, 0, 10);
}

/** One crawl step: fetch 10 recent matches of the next account and add the supported ones. */
async function crawlOnce() {
  const acct = pickNextAccount();
  if (!acct) {
    state.lastError = 'Nothing to crawl: add a seed account';
    return;
  }
  const k = keyOf(acct);
  state.frontier = state.frontier.filter(f => keyOf(f) !== k);
  state.crawled[k] = Date.now();

  await globalTokenBucket.acquire(CRAWL_COST);
  let res;
  try {
    res = await fetchMatchList(acct);
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      await globalTokenBucket.handle429(err.response?.headers?.['retry-after'] || 30);
      delete state.crawled[k];
      state.frontier.push(acct); // retry later
    }
    state.lastError = `Fetch failed${status ? ` (HTTP ${status})` : ''} for a ${acct.source} account`;
    return;
  }

  let added = 0;
  let skipped = 0;
  for (const raw of res?.data || []) {
    if (!raw?.metadata) continue;
    if (!isSupportedQueue(raw).supported) { skipped++; continue; }
    try {
      const normalized = normalizeV4Match(raw, acct.puuid || acct.riotId);
      if (addMatch(normalized, acct.source, raw.metadata.region || acct.region, k)) added++;
    } catch {
      skipped++;
    }
  }
  state.lastFetchAt = new Date().toISOString();
  state.lastError = null;
  state.lastResult = { source: acct.source, added, skipped };
}

/** Starts the background loop if someone is labeling. Safe to call on every request. */
function ensureCrawler() {
  if (crawling || process.env.LABEL_POOL_CRAWL === 'off') return;
  crawling = true;
  (async () => {
    try {
      while (Date.now() - lastActivityAt < ACTIVE_WINDOW_MS && Object.keys(state.matchSources).length < MAX_POOL_MATCHES) {
        const wait = MIN_CRAWL_GAP_MS - (Date.now() - lastCrawlAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastCrawlAt = Date.now();
        await crawlOnce();
        saveState();
      }
    } catch (err) {
      state.lastError = 'Crawler stopped unexpectedly';
      console.error('[labelPool] crawler error:', err.message);
    } finally {
      crawling = false;
    }
  })();
}

function addSeed({ riotId, region, source }) {
  init();
  if (!/^[^#]{1,32}#[^#]{1,8}$/.test(riotId || '')) throw new Error('Riot ID must look like Name#Tag');
  if (!['owner', 'friend', 'pro'].includes(source)) throw new Error('source must be owner, friend or pro');
  const r = String(region || DEFAULT_REGION).toLowerCase();
  if (!['ap', 'eu', 'na', 'kr', 'latam', 'br'].includes(r)) throw new Error('region must be ap, eu, na, kr, latam or br');
  const entry = { riotId: riotId.trim(), region: r, source };
  if (!state.seeds.some(s => keyOf(s) === keyOf(entry))) state.seeds.push(entry);
  saveState();
  return state.seeds;
}

// Strips names/PUUIDs: labelers see agents and teams only.
function anonymizeSnapshot(snap) {
  if (!snap) return null;
  const strip = p => ({
    character: p.character, team: p.team, location: p.location, view_radians: p.view_radians,
    isSubject: p.isSubject, isKiller: p.isKiller, isVictim: p.isVictim, isAlly: p.isAlly
  });
  const agentOf = name => snap.allPlayers.find(p => p.name === name)?.character || 'Unknown';
  return {
    map: snap.map,
    allPlayers: snap.allPlayers.map(strip),
    combatDistanceMeters: snap.combatDistanceMeters,
    minAllyDistanceMeters: snap.minAllyDistanceMeters,
    killer: { agent: agentOf(snap.killer?.name), team: snap.killer?.team, weapon: snap.killer?.weapon },
    victim: { agent: agentOf(snap.victim?.name), team: snap.victim?.team, location: snap.victim?.location }
  };
}

// Evidence fields like killer/victim/allyVictim hold Riot IDs: show the agent instead.
function anonymizeEvidence(evidence, m) {
  const agentById = new Map((m.all_players || []).map(p => [`${p.name}#${p.tag}`.toLowerCase(), p.character]));
  const out = {};
  for (const [k, v] of Object.entries(evidence || {})) {
    out[k] = typeof v === 'string' && agentById.has(v.toLowerCase()) ? agentById.get(v.toLowerCase()) : v;
  }
  return out;
}

/** Full card for the UI: the situation plus every kill of that round as a scrubbable timeline. */
function hydrate(c) {
  const rec = readMatch(c.matchId);
  if (!rec) return null;
  const m = rec.match;
  const data = getCandidateSituations({ matchData: m, matchId: m.matchId, playerRiotId: c.riotId });
  const s = data.situations.find(x => x.id === c.sid);
  if (!s) return null;

  const roundKills = groupKillsByRound(m.kill_events || []).get(c.round) || [];
  const r = (m.rounds || []).find((x, i) => (x.round_num || i + 1) === c.round) || {};
  const plantMs = (r.plant_events || [])[0]?.round_time_in_ms ?? null;
  const timeline = roundKills.map(k => ({
    timeMs: Number(k.kill_time_in_round || 0),
    postPlant: plantMs != null && Number(k.kill_time_in_round || 0) >= plantMs,
    snapshot: anonymizeSnapshot(buildRadarSnapshot(k, m, c.riotId, c.puuid))
  }));
  // Situation ids end in the kill's index (borderline/unflagged) or its floored ms (flagged): pin the exact kill
  const idxMatch = c.sid.match(/_(?:borderline|unflagged|unflagged_frag)_(\d+)$/);
  const msMatch = c.sid.match(/_(\d+)$/);
  let focusIndex = idxMatch ? Number(idxMatch[1]) : timeline.findIndex(t => Math.floor(t.timeMs) === Number(msMatch?.[1]));
  if (focusIndex < 0 || focusIndex >= timeline.length) {
    focusIndex = Math.max(0, timeline.findIndex(t => Math.abs(t.timeMs / 1000 - s.elapsedSec) < 0.05));
  }

  return {
    candidate_id: c.id,
    matchId: c.matchId,
    category: c.category,
    detector_tag: c.tag,
    polarity: s.polarity,
    map: m.map,
    round: c.round,
    side: c.side,
    agent: s.agent,
    role: c.role,
    rank_band: c.rankBand,
    source: c.source,
    elapsed: s.elapsed,
    clockDisplay: s.clockDisplay,
    plantTimeMs: plantMs,
    evidence: anonymizeEvidence(s.evidence, m),
    timeline,
    focusIndex
  };
}

/**
 * Next round for a rater. Bucket (detector tag / UNFLAGGED / BORDERLINE) with the fewest labels first,
 * so rare detectors get labeled too; within it, the match with the fewest labels; random among ties.
 */
function nextRound({ rater, focus }) {
  init();
  lastActivityAt = Date.now();
  ensureCrawler();

  const now = Date.now();
  const leased = id => {
    const l = leases.get(id);
    return l && now - l.at < LEASE_MS && l.rater !== rater;
  };
  let avail = candidates.filter(c => !labeledIds.has(c.id) && !leased(c.id));
  if (focus) avail = avail.filter(c => c.bucket === focus);
  if (!avail.length) return null;

  const byBucket = {};
  for (const c of avail) (byBucket[c.bucket] = byBucket[c.bucket] || []).push(c);
  const buckets = Object.keys(byBucket);
  const minB = Math.min(...buckets.map(b => bucketLabelCounts[b] || 0));
  const bucketChoices = buckets.filter(b => (bucketLabelCounts[b] || 0) === minB);
  const inBucket = byBucket[bucketChoices[Math.floor(Math.random() * bucketChoices.length)]];
  const minM = Math.min(...inBucket.map(c => matchLabelCounts[c.matchId] || 0));
  const choices = inBucket.filter(c => (matchLabelCounts[c.matchId] || 0) === minM);

  for (let tries = 0; tries < 5 && choices.length; tries++) {
    const i = Math.floor(Math.random() * choices.length);
    const card = hydrate(choices[i]);
    if (card) {
      leases.set(card.candidate_id, { rater, at: now });
      return card;
    }
    choices.splice(i, 1);
  }
  return null;
}

/** Call after a verdict is saved so the same round is never served again. */
function markLabeled(candidateId) {
  init();
  if (!candidateId || labeledIds.has(candidateId)) return;
  labeledIds.add(candidateId);
  leases.delete(candidateId);
  const c = candidateById.get(candidateId);
  if (c) {
    bucketLabelCounts[c.bucket] = (bucketLabelCounts[c.bucket] || 0) + 1;
    matchLabelCounts[c.matchId] = (matchLabelCounts[c.matchId] || 0) + 1;
  }
}

function countBy(list, key) {
  const out = {};
  for (const x of list) out[x[key]] = (out[x[key]] || 0) + 1;
  return out;
}

function getStatus() {
  init();
  const labels = getLabels().filter(l => l.candidate_id);
  const unlabeled = candidates.filter(c => !labeledIds.has(c.id));
  return {
    crawler: {
      running: crawling,
      active: Date.now() - lastActivityAt < ACTIVE_WINDOW_MS,
      lastFetchAt: state.lastFetchAt,
      lastResult: state.lastResult || null,
      lastError: state.lastError,
      frontierBySource: countBy(state.frontier, 'source'),
      seeds: state.seeds
    },
    pool: {
      matches: Object.keys(state.matchSources).length,
      matchesBySource: countBy(Object.entries(state.matchSources).map(([, s]) => ({ s })), 's'),
      roundsReady: unlabeled.length,
      readyByBucket: countBy(unlabeled, 'bucket'),
      readyByRankBand: countBy(unlabeled, 'rankBand')
    },
    labels: {
      total: labels.length,
      byRater: countBy(labels, 'rater'),
      byBucket: bucketLabelCounts,
      unsure: labels.filter(l => l.human_label === 'UNSURE').length
    }
  };
}

/** Bulk-add accounts (e.g. a scraped player list) to the frontier; returns how many were new. */
function addAccounts(entries, source) {
  init();
  const before = state.frontier.length;
  for (const e of entries) addToFrontier({ riotId: e.riotId, region: e.region || DEFAULT_REGION, source, tier: e.tier || 'Unranked', addedAt: Date.now() });
  saveState();
  return state.frontier.length - before;
}

/** Rebuild the labeled-set after labels arrive from Mongo (no-op before the pool is loaded). */
function refreshLabels() {
  if (candidates) refreshLabelIndex();
}

module.exports = { init, addAccounts, refreshLabels, nextRound, markLabeled, addSeed, getStatus, ensureCrawler, _internals: { addMatch, pickNextAccount } };
