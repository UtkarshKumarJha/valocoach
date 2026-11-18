const fs = require('fs');
const mongoose = require('mongoose');
const Label = require('../models/Label');
const isMongoLive = () => mongoose.connection.readyState === 1;
const path = require('path');
const { detectRoundSituations, getSideForRound, groupKillsByRound, getPlayerTeam } = require('./situationDetectors');
const { getRoleForMatch, getRoleForAgent } = require('./agentRoleService');
const { SPATIAL_CONFIG } = require('../config/telemetryConfig');

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'tests', 'fixtures');
const LABELS_FILE = path.resolve(__dirname, '..', '..', '..', 'data', 'labels.jsonl');

/**
 * Wilson Score 95% Confidence Interval
 */
function computeWilsonCI(k, n, z = 1.96) {
  if (!n || n <= 0) return [0, 0];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return [Number((lower * 100).toFixed(1)), Number((upper * 100).toFixed(1))];
}

/**
 * Simple pseudo-random Mulberry32 seeded RNG for deterministic 70/30 splitting
 */
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lists available match fixtures and metadata
 */
function getAvailableMatches() {
  const matches = [];
  if (fs.existsSync(FIXTURES_DIR)) {
    const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json') && !f.includes('deathmatch'));
    files.forEach(file => {
      try {
        const filePath = path.join(FIXTURES_DIR, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const allPlayers = data.all_players || data.players?.all_players || [];
        const rounds = data.rounds || [];
        const kills = data.kill_events || data.kills || [];

        const id = file.replace('.json', '');
        const map = data.map || data.metadata?.map || 'Ascent';
        const mode = data.metadata?.mode || 'Competitive';
        const subject = allPlayers.find(p => p.name === 'Player_Subject') || allPlayers[0] || {};
        const subjectRiotId = subject.name ? `${subject.name}#${subject.tag}` : 'Subject#0001';

        matches.push({
          id,
          filename: file,
          name: `${id.toUpperCase()} - ${map} (${rounds.length} Rounds)`,
          map,
          mode,
          roundsCount: rounds.length,
          killsCount: kills.length,
          defaultSubject: subjectRiotId,
          players: allPlayers.map(p => ({
            name: `${p.name}#${p.tag}`,
            puuid: p.puuid,
            character: p.character || p.agent || 'Unknown',
            team: p.team
          }))
        });
      } catch (err) {
        console.warn(`[devTelemetryService] Error reading fixture ${file}:`, err.message);
      }
    });
  }
  return matches;
}

/**
 * Loads a match by ID from fixtures
 */
function loadMatchData(matchId) {
  const targetFile = matchId.endsWith('.json') ? matchId : `${matchId}.json`;
  const filePath = path.join(FIXTURES_DIR, targetFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Match fixture "${matchId}" not found in ${FIXTURES_DIR}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Builds 10-player radar snapshot for a kill event
 */
function buildRadarSnapshot(killEvent, matchData, subjectRiotId, subjectPuuid) {
  if (!killEvent) return null;

  const riotIdLower = (subjectRiotId || '').toLowerCase().trim();
  const allPlayers = matchData.all_players || matchData.players?.all_players || [];
  const charMap = {};
  const teamMap = {};

  allPlayers.forEach(p => {
    const fullId = `${p.name}#${p.tag}`.toLowerCase();
    charMap[p.puuid] = p.character || p.agent;
    charMap[fullId] = p.character || p.agent;
    teamMap[p.puuid] = p.team;
    teamMap[fullId] = p.team;
  });

  // The v4 adapter already appends the victim to the snapshot; the victim is re-added below as the 10th player
  const victimNameLower = (killEvent.victim_display_name || '').toLowerCase();
  const survivors = (killEvent.player_locations_on_kill || []).filter(p =>
    !((killEvent.victim_puuid && p.player_puuid === killEvent.victim_puuid) ||
      (victimNameLower && (p.player_display_name || '').toLowerCase() === victimNameLower))
  ).map(p => {
    const pName = p.player_display_name || '';
    const pLower = pName.toLowerCase();
    const isSubject = (subjectPuuid && p.player_puuid === subjectPuuid) || (pLower === riotIdLower);
    const isKiller = (killEvent.killer_puuid && p.player_puuid === killEvent.killer_puuid) ||
                     (killEvent.killer_display_name && pLower === killEvent.killer_display_name.toLowerCase());
    const character = charMap[p.player_puuid] || charMap[pLower] || 'Agent';

    return {
      puuid: p.player_puuid,
      name: pName,
      character,
      team: p.player_team || teamMap[p.player_puuid] || teamMap[pLower] || 'Blue',
      location: p.location || { x: 0, y: 0 },
      view_radians: p.view_radians != null ? Number(p.view_radians) : null,
      view_degrees: p.view_radians != null ? Number((p.view_radians * (180 / Math.PI)).toFixed(1)) : null,
      isSubject,
      isKiller,
      isVictim: false
    };
  });

  // Synthesize victim as the 10th player (since victim is dead at snapshot instant)
  const vName = killEvent.victim_display_name || 'Victim';
  const vLower = vName.toLowerCase();
  const isSubjectVictim = (subjectPuuid && killEvent.victim_puuid === subjectPuuid) || (vLower === riotIdLower);
  const victim = {
    puuid: killEvent.victim_puuid,
    name: vName,
    character: charMap[killEvent.victim_puuid] || charMap[vLower] || 'Agent',
    team: killEvent.victim_team || teamMap[killEvent.victim_puuid] || teamMap[vLower] || 'Red',
    location: killEvent.victim_death_location || { x: 0, y: 0 },
    view_radians: null,
    view_degrees: null,
    isSubject: isSubjectVictim,
    isKiller: false,
    isVictim: true
  };

  const all10 = [...survivors, victim];

  // Determine subject team
  const subjectObj = all10.find(p => p.isSubject);
  const subjectTeam = subjectObj ? subjectObj.team : (killEvent.victim_team === 'Red' ? 'Red' : 'Blue');

  // Tag ally status
  all10.forEach(p => {
    p.isAlly = (p.team === subjectTeam);
  });

  // Calculate combat and ally distances
  let combatDistMeters = 0;
  if (killEvent.victim_death_location && killEvent.player_locations_on_kill) {
    const killerSnap = killEvent.player_locations_on_kill.find(
      p => (killEvent.killer_puuid && p.player_puuid === killEvent.killer_puuid) ||
           (killEvent.killer_display_name && p.player_display_name === killEvent.killer_display_name)
    );
    if (killerSnap && killerSnap.location) {
      combatDistMeters = Number((Math.hypot(
        killerSnap.location.x - killEvent.victim_death_location.x,
        killerSnap.location.y - killEvent.victim_death_location.y
      ) / 100).toFixed(1));
    }
  }

  let minAllyDistMeters = Infinity;
  if (subjectObj && subjectObj.location) {
    const allies = all10.filter(p => p.isAlly && !p.isSubject && p.location);
    allies.forEach(a => {
      const d = Math.hypot(a.location.x - subjectObj.location.x, a.location.y - subjectObj.location.y) / 100;
      if (d < minAllyDistMeters) minAllyDistMeters = d;
    });
  }

  return {
    map: matchData.map || matchData.metadata?.map || 'Ascent',
    allPlayers: all10,
    combatDistanceMeters: combatDistMeters,
    minAllyDistanceMeters: minAllyDistMeters === Infinity ? null : Number(minAllyDistMeters.toFixed(1)),
    killer: {
      name: killEvent.killer_display_name,
      team: killEvent.killer_team,
      weapon: killEvent.damage_weapon_name || 'Vandal'
    },
    victim: {
      name: killEvent.victim_display_name,
      team: killEvent.victim_team,
      location: killEvent.victim_death_location
    }
  };
}

/**
 * Extracts candidate situations for labeling (Flagged, Unflagged, Borderline)
 */
function getCandidateSituations(options = {}) {
  const {
    matchId = 'match1',
    playerRiotId = null,
    samplingMode = 'all', // 'flagged' | 'unflagged' | 'borderline' | 'all'
    shuffle = false
  } = options;

  // Label pool passes an in-memory normalized match; the legacy dev view loads fixtures by id
  const matchData = options.matchData || loadMatchData(matchId);
  const allPlayers = matchData.all_players || matchData.players?.all_players || [];
  
  // Resolve subject player
  let subject = null;
  if (playerRiotId) {
    subject = allPlayers.find(p => `${p.name}#${p.tag}`.toLowerCase() === playerRiotId.toLowerCase().trim());
  }
  if (!subject) {
    subject = allPlayers.find(p => p.name === 'Player_Subject') || allPlayers[0];
  }
  if (!subject) {
    throw new Error('No players found in match data');
  }

  const subjectRiotId = `${subject.name}#${subject.tag}`;
  const subjectPuuid = subject.puuid;
  const role = getRoleForMatch(matchData, subjectRiotId, subjectPuuid);
  const agent = subject.character || subject.agent || 'Jett';
  const rounds = matchData.rounds || [];
  const allKills = matchData.kill_events || matchData.kills || [];

  const situations = [];
  const subjectTeam = subject.team || getPlayerTeam(matchData, subjectPuuid, subjectRiotId);
  const killsByRound = groupKillsByRound(allKills);

  rounds.forEach((r, idx) => {
    const roundNum = r.round_num || (idx + 1);
    const side = getSideForRound(subjectTeam, roundNum);
    const roundKills = killsByRound.get(roundNum) || [];

    // 1. Run situation detectors (Layer A)
    const detectedSits = detectRoundSituations({
      matchId,
      roundNum,
      side,
      role,
      killEvents: roundKills,
      roundStats: r.player_stats || (r.all_player_stats || []).find(ps => ps.player_display_name?.toLowerCase() === subjectRiotId.toLowerCase()) || {},
      playerRiotId: subjectRiotId,
      playerPuuid: subjectPuuid,
      plantEvents: r.plant_events || (r.plant ? [r.plant] : [])
    });

    // Process Flagged Situations
    detectedSits.forEach(sit => {
      // Find matching kill event
      let matchKill = null;
      if (sit.tag === 'TRADES_WELL' || sit.tag === 'DOESNT_TRADE') {
        matchKill = roundKills.find(k => k.victim_display_name === sit.evidence.allyVictim) || roundKills[0];
      } else if (sit.tag === 'OPENING_DUEL_WIN') {
        matchKill = roundKills[0];
      } else {
        matchKill = roundKills.find(k => k.victim_display_name?.toLowerCase() === subjectRiotId.toLowerCase()) || roundKills[0];
      }

      if (matchKill) {
        const deathTimeMs = Number(matchKill.kill_time_in_round || 0);
        const elapsedSec = deathTimeMs / 1000;
        const onClockSec = Math.max(0, 100 - elapsedSec);
        const formatSec = (s) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

        const snapshot = buildRadarSnapshot(matchKill, matchData, subjectRiotId, subjectPuuid);

        situations.push({
          id: `${matchId}_r${roundNum}_${sit.tag}_${Math.floor(deathTimeMs)}`,
          matchId,
          round: roundNum,
          side,
          agent,
          role,
          elapsed: formatSec(elapsedSec),
          elapsedSec: Number(elapsedSec.toFixed(1)),
          onClock: formatSec(onClockSec),
          clockDisplay: `${formatSec(elapsedSec)} elapsed (${formatSec(onClockSec)} on-clock)`,
          category: 'flagged',
          detector_tag: sit.tag,
          polarity: sit.polarity,
          cue: `Round ${roundNum} [${side.toUpperCase()}]: ${sit.tag.replace(/_/g, ' ')} detected at ${formatSec(elapsedSec)} elapsed.`,
          evidence: sit.evidence,
          snapshot
        });
      }
    });

    // 2. Scan kills for Borderline & Unflagged candidates
    roundKills.forEach((k, kIdx) => {
      const isVictim = k.victim_display_name?.toLowerCase() === subjectRiotId.toLowerCase();
      const isKiller = k.killer_display_name?.toLowerCase() === subjectRiotId.toLowerCase();
      const elapsedSec = (Number(k.kill_time_in_round || 0)) / 1000;
      const onClockSec = Math.max(0, 100 - elapsedSec);
      const formatSec = (s) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

      if (isVictim) {
        const snap = k.player_locations_on_kill || [];
        const allies = snap.filter(p => p.player_team === k.victim_team);
        let minAllyDist = Infinity;
        allies.forEach(a => {
          if (a.location && k.victim_death_location) {
            const d = Math.hypot(a.location.x - k.victim_death_location.x, a.location.y - k.victim_death_location.y) / 100;
            if (d < minAllyDist) minAllyDist = d;
          }
        });

        const isBorderlineTime = (elapsedSec >= 19 && elapsedSec <= 26);
        const isBorderlineDist = (minAllyDist >= 12 && minAllyDist <= 18);

        // Borderline candidate
        if ((isBorderlineTime || isBorderlineDist) && !detectedSits.some(s => s.tag === 'DRY_PEEK')) {
          const snapshot = buildRadarSnapshot(k, matchData, subjectRiotId, subjectPuuid);
          situations.push({
            id: `${matchId}_r${roundNum}_borderline_${kIdx}`,
            matchId,
            round: roundNum,
            side,
            agent,
            role,
            elapsed: formatSec(elapsedSec),
            elapsedSec: Number(elapsedSec.toFixed(1)),
            onClock: formatSec(onClockSec),
            clockDisplay: `${formatSec(elapsedSec)} elapsed (${formatSec(onClockSec)} on-clock)`,
            category: 'borderline',
            detector_tag: null,
            polarity: 'neutral',
            cue: `Borderline threshold case: elapsed ${formatSec(elapsedSec)}, nearest ally at ${minAllyDist.toFixed(1)}m.`,
            evidence: { elapsedSec, nearestAllyDistMeters: Number(minAllyDist.toFixed(1)) },
            snapshot
          });
        }
        // Unflagged candidate (Standard supported late engagement)
        else if (elapsedSec > 25 && minAllyDist < 12 && detectedSits.length === 0) {
          const snapshot = buildRadarSnapshot(k, matchData, subjectRiotId, subjectPuuid);
          situations.push({
            id: `${matchId}_r${roundNum}_unflagged_${kIdx}`,
            matchId,
            round: roundNum,
            side,
            agent,
            role,
            elapsed: formatSec(elapsedSec),
            elapsedSec: Number(elapsedSec.toFixed(1)),
            onClock: formatSec(onClockSec),
            clockDisplay: `${formatSec(elapsedSec)} elapsed (${formatSec(onClockSec)} on-clock)`,
            category: 'unflagged',
            detector_tag: null,
            polarity: 'positive',
            cue: `Standard engagement with good ally spacing (${minAllyDist.toFixed(1)}m) and trade readiness.`,
            evidence: { elapsedSec, nearestAllyDistMeters: Number(minAllyDist.toFixed(1)) },
            snapshot
          });
        }
      } else if (isKiller && detectedSits.length === 0) {
        // Successful frag duel
        const snapshot = buildRadarSnapshot(k, matchData, subjectRiotId, subjectPuuid);
        situations.push({
          id: `${matchId}_r${roundNum}_unflagged_frag_${kIdx}`,
          matchId,
          round: roundNum,
          side,
          agent,
          role,
          elapsed: formatSec(elapsedSec),
          elapsedSec: Number(elapsedSec.toFixed(1)),
          onClock: formatSec(onClockSec),
          clockDisplay: `${formatSec(elapsedSec)} elapsed (${formatSec(onClockSec)} on-clock)`,
          category: 'unflagged',
          detector_tag: null,
          polarity: 'positive',
          cue: `Clean combat frag secured at ${formatSec(elapsedSec)} elapsed.`,
          evidence: { elapsedSec, fragSecured: true },
          snapshot
        });
      }
    });
  });

  // Filter by sampling mode
  let filtered = situations;
  if (samplingMode === 'flagged') {
    filtered = situations.filter(s => s.category === 'flagged');
  } else if (samplingMode === 'unflagged') {
    filtered = situations.filter(s => s.category === 'unflagged');
  } else if (samplingMode === 'borderline') {
    filtered = situations.filter(s => s.category === 'borderline');
  }

  // Shuffle if requested (using deterministic or random shuffle)
  if (shuffle) {
    for (let i = filtered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
    }
  }

  return {
    matchId,
    subject: subjectRiotId,
    agent,
    role,
    samplingMode,
    totalAvailable: situations.length,
    counts: {
      flagged: situations.filter(s => s.category === 'flagged').length,
      borderline: situations.filter(s => s.category === 'borderline').length,
      unflagged: situations.filter(s => s.category === 'unflagged').length
    },
    situations: filtered
  };
}

/**
 * Appends a verified verdict to data/labels.jsonl
 * Format: {matchId, round, elapsed, agent, side, detector_tag, human_label, justified, confidence, why, rater}
 */
async function appendVerdict(verdict) {
  if (!verdict) throw new Error('Verdict data is required');

  const {
    matchId,
    round,
    elapsed,
    agent,
    side,
    detector_tag,
    human_label,
    justified,
    confidence,
    why = '',
    rater = 'dev',
    candidate_id,
    category,
    role,
    map,
    rank_band,
    source
  } = verdict;

  if (!matchId) throw new Error('matchId is required');
  if (round == null) throw new Error('round is required');
  if (!human_label) throw new Error('human_label is required');
  if (justified !== 'Y' && justified !== 'N') throw new Error('justified must be "Y" or "N"');
  if (![1, 2, 3].includes(Number(confidence))) throw new Error('confidence must be 1, 2, or 3');
  if (typeof why !== 'string') throw new Error('why must be a string');

  const record = {
    matchId: String(matchId),
    round: Number(round),
    elapsed: String(elapsed || '0:00'),
    agent: String(agent || 'Unknown'),
    side: String(side || 'attack'),
    detector_tag: detector_tag ? String(detector_tag) : 'UNFLAGGED',
    human_label: String(human_label),
    justified: String(justified),
    confidence: Number(confidence),
    why: String(why).trim(),
    rater: String(rater).trim(),
    created_at: new Date().toISOString()
  };
  // Label-pool provenance (optional): lets us stratify precision/recall by source, rank band, map, role
  const extras = { candidate_id, category, role, map, rank_band, source };
  for (const [k, v] of Object.entries(extras)) if (v != null && v !== '') record[k] = String(v);

  // Ensure data directory exists
  const dataDir = path.dirname(LABELS_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Mongo is the durable store when connected (hosted); a failed write is an error so the labeler retries
  if (isMongoLive()) {
    try {
      await Label.create(record);
    } catch (err) {
      console.error('[labels] Mongo write failed:', err.message);
      const e = new Error('STORAGE_FAILED');
      e.code = 'STORAGE_FAILED';
      throw e;
    }
  }
  fs.appendFileSync(LABELS_FILE, JSON.stringify(record) + '\n', 'utf8');
  if (labelCache) labelCache.push(record);

  // Count total labels
  const allLabels = getLabels();
  return {
    success: true,
    totalCount: allLabels.length,
    saved: record
  };
}

/**
 * Reads all labels from data/labels.jsonl
 */
let labelCache = null; // in-memory view: file labels merged with Mongo labels once Mongo connects

function readLabelFile() {
  if (!fs.existsSync(LABELS_FILE)) return [];
  const labels = [];
  fs.readFileSync(LABELS_FILE, 'utf8').split('\n').filter(l => l.trim()).forEach((line, i) => {
    try {
      labels.push(JSON.parse(line));
    } catch {
      console.warn(`[devTelemetryService] Bad JSON at labels.jsonl line ${i + 1}`);
    }
  });
  return labels;
}

function getLabels() {
  if (!labelCache) labelCache = readLabelFile();
  return labelCache;
}

/** Called once Mongo is up: union of Mongo and local-file labels (deduped), so neither store loses rows. */
async function loadLabelsFromMongo() {
  const key = l => `${l.candidate_id}|${l.rater}|${l.created_at}`;
  const merged = new Map(readLabelFile().map(l => [key(l), l]));
  const docs = await Label.find({}, { _id: 0, __v: 0 }).lean();
  docs.forEach(d => merged.set(key(d), d));
  // Push local-only labels (made while offline) up to Mongo
  const remote = new Set(docs.map(key));
  const localOnly = [...merged.values()].filter(l => !remote.has(key(l)));
  if (localOnly.length) await Label.insertMany(localOnly, { ordered: false }).catch(err => console.warn('[labels] upload of local labels partly failed:', err.message));
  labelCache = [...merged.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return labelCache.length;
}

/**
 * Computes per-detector precision/recall with a 70/30 split and Wilson 95% CIs
 */
function evaluateLabels(splitRatio = 0.70, seed = 42) {
  // UNSURE = "can't tell from this data": recorded for review, excluded from precision/recall
  const allLabels = getLabels().filter(l => l.human_label !== 'UNSURE');
  if (allLabels.length === 0) {
    return {
      totalSamples: 0,
      trainCount: 0,
      testCount: 0,
      detectors: {},
      macroF1: 0,
      microF1: 0,
      message: 'No labels recorded yet in data/labels.jsonl'
    };
  }

  // Reproducible seeded shuffle
  const rng = mulberry32(seed);
  const shuffled = [...allLabels];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const splitIdx = Math.max(1, Math.floor(shuffled.length * splitRatio));
  const trainSet = shuffled.slice(0, splitIdx);
  const testSet = shuffled.slice(splitIdx);

  // Set to evaluate (if testSet is empty e.g. < 2 samples, evaluate full set)
  const evalSet = testSet.length > 0 ? testSet : shuffled;

  // Collect all unique detector tags and human labels
  const allTags = new Set();
  shuffled.forEach(l => {
    if (l.detector_tag && l.detector_tag !== 'UNFLAGGED') allTags.add(l.detector_tag);
    if (l.human_label && l.human_label !== 'UNFLAGGED' && l.human_label !== 'CLEAN_ENGAGEMENT' && l.human_label !== 'NORMAL_TEAM_FIGHT') {
      allTags.add(l.human_label);
    }
  });

  const perDetector = {};
  let totalTP = 0;
  let totalFP = 0;
  let totalFN = 0;
  let totalTN = 0;

  allTags.forEach(tag => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    evalSet.forEach(l => {
      const pred = (l.detector_tag === tag);
      // Ground truth is positive if human gave this tag OR if human marked detector's tag as justified
      const groundTruth = (l.human_label === tag) || (pred && l.justified === 'Y');

      if (pred && groundTruth) tp += 1;
      else if (pred && !groundTruth) fp += 1;
      else if (!pred && groundTruth) fn += 1;
      else tn += 1;
    });

    const precDenom = tp + fp;
    const recDenom = tp + fn;
    const precision = precDenom > 0 ? Number((tp / precDenom).toFixed(3)) : null;
    const recall = recDenom > 0 ? Number((tp / recDenom).toFixed(3)) : null;
    const f1 = (precision != null && recall != null && (precision + recall) > 0)
      ? Number(((2 * precision * recall) / (precision + recall)).toFixed(3))
      : 0;

    const precisionCI = computeWilsonCI(tp, precDenom);
    const recallCI = computeWilsonCI(tp, recDenom);

    perDetector[tag] = {
      tag,
      tp,
      fp,
      fn,
      tn,
      testSamples: precDenom + fn,
      precision: precision != null ? Number((precision * 100).toFixed(1)) : null,
      precisionCI,
      recall: recall != null ? Number((recall * 100).toFixed(1)) : null,
      recallCI,
      f1Score: f1
    };

    totalTP += tp;
    totalFP += fp;
    totalFN += fn;
    totalTN += tn;
  });

  // Micro and Macro Metrics
  const detectorList = Object.values(perDetector);
  const validPrecisions = detectorList.filter(d => d.precision != null).map(d => d.precision);
  const validRecalls = detectorList.filter(d => d.recall != null).map(d => d.recall);
  const validF1s = detectorList.map(d => d.f1Score);

  const macroPrecision = validPrecisions.length > 0 ? Number((validPrecisions.reduce((a, b) => a + b, 0) / validPrecisions.length).toFixed(1)) : 0;
  const macroRecall = validRecalls.length > 0 ? Number((validRecalls.reduce((a, b) => a + b, 0) / validRecalls.length).toFixed(1)) : 0;
  const macroF1 = validF1s.length > 0 ? Number((validF1s.reduce((a, b) => a + b, 0) / validF1s.length).toFixed(3)) : 0;

  const microPrecDenom = totalTP + totalFP;
  const microRecDenom = totalTP + totalFN;
  const microPrecision = microPrecDenom > 0 ? Number(((totalTP / microPrecDenom) * 100).toFixed(1)) : 0;
  const microRecall = microRecDenom > 0 ? Number(((totalTP / microRecDenom) * 100).toFixed(1)) : 0;
  const microF1 = (microPrecision + microRecall > 0)
    ? Number(((2 * (microPrecision / 100) * (microRecall / 100)) / ((microPrecision + microRecall) / 100)).toFixed(3))
    : 0;

  const justifiedCount = evalSet.filter(l => l.justified === 'Y').length;
  const justifiedRatePct = evalSet.length > 0 ? Number(((justifiedCount / evalSet.length) * 100).toFixed(1)) : 0;

  return {
    totalSamples: allLabels.length,
    trainCount: trainSet.length,
    testCount: evalSet.length,
    splitRatio: `${Math.round(splitRatio * 100)}/${Math.round((1 - splitRatio) * 100)}`,
    justifiedRatePct,
    macro: {
      precision: macroPrecision,
      recall: macroRecall,
      f1: macroF1
    },
    micro: {
      precision: microPrecision,
      recall: microRecall,
      f1: microF1
    },
    perDetector
  };
}

module.exports = {
  buildRadarSnapshot,
  getAvailableMatches,
  loadMatchData,
  buildRadarSnapshot,
  getCandidateSituations,
  appendVerdict,
  loadLabelsFromMongo,
  getLabels,
  evaluateLabels,
  computeWilsonCI,
  LABELS_FILE
};
