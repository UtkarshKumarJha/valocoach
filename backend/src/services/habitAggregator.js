/**
 * Habit Aggregator (Layer B) with Peer Baselines v2 & Twin-Pair Invariants
 * 
 * Invariants:
 * - For every twin pair: flaw + positive + neutral === opportunities (in unit tests and runtime warning).
 * - Peer Baselines v2: Conditioned on role x side x detector.
 *   Only counts peers with >= 1 opportunity (never treats 0 opps as 0%).
 *   p0 = sum(events) / sum(opportunities) with Wilson CI (requires >= 100 peer opps per cell).
 *   Peer median is display context only.
 * - Tiers v2: Rate-based with Wilson lower bound and minimum frequency guards.
 *   Requires >= 8 events AND >= 5 matches AND events in >= 40% of matches.
 *   pattern: w_lower > p0 AND rate - p0 >= 10pp (0.10).
 *   strong habit: w_lower > p0 + 10pp AND rate - p0 >= 20pp (0.20).
 * - Output Honesty:
 *   Name archetype ONLY if at least one habit clears pattern rule vs peers; else "No distinct archetype yet (N matches)".
 *   Confidence computed from N and CI width.
 *   Max 1 replay cue per habit, diversified across rounds and matches.
 */

const { HABIT_RULES, SPATIAL_CONFIG, isFlawForRole } = require('../config/telemetryConfig');
const { getRoleForMatch, getRoleForAgent } = require('./agentRoleService');
const { detectRoundSituations, getSideForRound, groupKillsByRound, getPlayerTeam, getRoundUtilityCasts } = require('./situationDetectors');

// Wilson Score 95% Confidence Interval (returns [lowerPct, upperPct] and numeric bounds)
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

function computeWilsonBoundsNumeric(k, n, z = 1.96) {
  if (!n || n <= 0) return { lower: 0, upper: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin)
  };
}

// Twin-Pair Definitions
// oppFromSituations: the opportunity IS one of the twins firing (else opportunities are counted separately).
const TWIN_PAIRS = {
  SPACING: {
    flaw: 'ISOLATED_PLAY',
    positive: 'STAYS_WITH_TEAM',
    hasNeutral: true
  },
  TRADING: {
    flaw: 'DOESNT_TRADE',
    positive: 'TRADES_WELL',
    hasNeutral: false,
    oppFromSituations: true
  },
  ENTRY_SUPPORT: {
    flaw: 'UNSUPPORTED_ENTRY',
    positive: 'SUPPORTED_ENTRY',
    hasNeutral: false,
    oppFromSituations: true
  },
  ENTRY: {
    flaw: 'LETS_TEAMMATES_ENTER_FIRST',
    positive: 'TAKES_SPACE',
    hasNeutral: true
  },
  DEFENSE_ANCHOR: {
    flaw: 'SOLO_HOLD_VS_STACK',
    positive: 'ANCHORED_WITH_SUPPORT',
    hasNeutral: false,
    oppFromSituations: true
  },
  OPENING_DUEL: {
    flaw: 'OPENING_DUEL_LOSS',
    positive: 'OPENING_DUEL_WIN',
    hasNeutral: false,
    oppFromSituations: true
  },
  CROSSHAIR: {
    flaw: 'BACKSTAB_DEATH',
    positive: 'CROSSHAIR_FACING_DUEL',
    hasNeutral: true,
    oppFromSituations: true
  },
  LURK_TIMING: {
    flaw: 'UNSYNCED_LURK_DEATH',
    positive: 'SYNCED_LURK_KILL',
    hasNeutral: false,
    oppFromSituations: true
  }
};

// Soft UI narrative templates mapped to internal detector tags
const HABIT_TEMPLATES = {
  // Flaws
  'LETS_TEAMMATES_ENTER_FIRST': {
    title: 'Letting others go first',
    polarity: 'flaw',
    template: (h) => `You've been observed to let teammates make first contact on attack, in about ${h.perHalf} rounds per half across your last ${h.matchesSeen} matches${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'SOLO_HOLD_VS_STACK': {
    title: 'Holding alone vs a stack',
    polarity: 'flaw',
    template: (h) => `You frequently find yourself holding solo against 3+ enemy site rushes on defense, in about ${h.perHalf} rounds per half without rotation support${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'DRY_PEEK': {
    title: 'Dry peeks',
    polarity: 'flaw',
    template: (h) => `You've been observed to contest early angles within 22s without utility or nearby ally support in about ${h.perHalf} rounds per half${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'EARLY_DEATH_NO_ALLY': {
    title: 'Early deaths alone',
    polarity: 'flaw',
    template: (h) => `You died in the first 22 s with no teammate within 15 m in about ${h.perHalf} rounds per half${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'EARLY_DEATH_NO_UTILITY': {
    title: 'Early deaths without utility',
    polarity: 'flaw',
    template: (h) => `You entered early combat with allies nearby but without deploying utility in about ${h.perHalf} rounds per half${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'UNSUPPORTED_ENTRY': {
    title: 'Solo entries',
    polarity: 'flaw',
    template: (h) => `On attack, you conceded first contact without an ally close enough to convert a trade in about ${h.perHalf} rounds per half${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'DOESNT_TRADE': {
    title: 'Missed trades',
    polarity: 'flaw',
    template: (h) => `You were unable to secure a revenge trade on nearby teammate casualties in about ${Math.round(h.rate * 100)}% of close-range opportunities (${h.k}/${h.n})${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'BACKSTAB_DEATH': {
    title: 'Killed from behind',
    polarity: 'flaw',
    template: (h) => `You conceded deaths with your crosshair facing >85° away from your killer in ${h.k} rounds across your matches${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'ISOLATED_PLAY': {
    title: 'Fighting far from your team',
    polarity: 'flaw',
    template: (h) => `On attack, you engaged opponents >25m away from your nearest teammate in about ${Math.round(h.rate * 100)}% of duels (${h.k}/${h.n})${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'REPEAT_DEATH_SPOT': {
    title: 'Repeat death spot',
    polarity: 'flaw',
    template: (h) => `You died 3 or more times in the exact same ~8m position in a single match across ${h.k} distinct halves (in-match repeat).`
  },
  'OPENING_DUEL_LOSS': {
    title: 'Losing first duels',
    polarity: 'flaw',
    template: (h) => `You conceded first death in ${h.k} of ${h.n} opening combat rounds (${Math.round(h.rate * 100)}%)${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },

  // Positive twins
  'TAKES_SPACE': {
    title: 'Taking space',
    polarity: 'positive',
    template: (h) => `You actively lead opening pathfinding on attack, being among the first two players at contact in ${Math.round(h.rate * 100)}% of entry duels${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'ANCHORED_WITH_SUPPORT': {
    title: 'Holding with support',
    polarity: 'positive',
    template: (h) => `You anchor defense site hits with close teammate proximity, enabling effective site crossfires in ${Math.round(h.rate * 100)}% of pushes${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'SUPPORTED_ENTRY': {
    title: 'Supported entries',
    polarity: 'positive',
    template: (h) => `You take entry fights with close ally support or direct trade conversion in ${Math.round(h.rate * 100)}% of opening attacks${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'TRADES_WELL': {
    title: 'Trading teammates',
    polarity: 'positive',
    template: (h) => `You converted ${h.k} of ${h.n} gated trade opportunities (${Math.round(h.rate * 100)}%, 95% CI: [${h.ci[0]}%, ${h.ci[1]}%]) when allies were eliminated near you${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'CROSSHAIR_FACING_DUEL': {
    title: 'Facing your killer',
    polarity: 'positive',
    template: (h) => `Your crosshair was aligned toward your attacker within 45° in ${Math.round(h.rate * 100)}% of combat engagements${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'STAYS_WITH_TEAM': {
    title: 'Staying in trade range',
    polarity: 'positive',
    template: (h) => `You maintained disciplined spacing (within 15m of an ally) in ${Math.round(h.rate * 100)}% of attack engagements (${h.k}/${h.n})${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'DYNAMIC_POSITIONING': {
    title: 'Varied positions',
    polarity: 'positive',
    template: (h) => `You vary your defensive angles and entry vectors, rarely dying in repeat positions.`
  },
  'OPENING_DUEL_WIN': {
    title: 'Winning first duels',
    polarity: 'positive',
    template: (h) => `You secured first blood in ${h.k} of ${h.n} opening combat rounds (${Math.round(h.rate * 100)}%)${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'UNSYNCED_LURK_DEATH': {
    title: 'Early lurk deaths',
    polarity: 'flaw',
    template: (h) => `On attack, you died isolated while lurking (>30m from team) before your team initiated site contact in about ${Math.round(h.rate * 100)}% of lurk attempts (${h.k}/${h.n})${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },
  'SYNCED_LURK_KILL': {
    title: 'Well-timed lurk kills',
    polarity: 'positive',
    template: (h) => `On attack, you secured flank kills synchronized within ±10s of your team's site hit in ${Math.round(h.rate * 100)}% of lurk positions (${h.k}/${h.n})${h.peerComparison ? ` (${h.peerComparison})` : ''}.`
  },

  // Info tags
  'POST_PLANT_ISOLATION': {
    title: 'Far from team after plant',
    polarity: 'info',
    template: (h) => `You held extended positions (>25m from nearest ally) during post-plant countdowns in ${h.k} rounds (informational context).`
  }
};

/**
 * Calculates percentile value from a sorted array of numbers using nearest-rank.
 */
function getPercentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(sortedArr.length * p)));
  return sortedArr[idx];
}

const SPACING_ROLES = ['Initiator', 'Controller'];
const MAX_CUES_PER_HABIT = 3;

/** What a player needs to find a match in their in-game replay list: date, map, agent, score from their side. */
function getMatchMeta(m, puuid, riotId, team) {
  const idLower = (riotId || '').toLowerCase();
  const me = (m.all_players || []).find(p => (puuid && p.puuid === puuid) || `${p.name}#${p.tag}`.toLowerCase() === idLower);
  const t = String(team || '').toLowerCase();
  const won = (m.rounds || []).filter(r => t && String(r.winning_team || '').toLowerCase() === t).length;
  const lost = (m.rounds || []).filter(r => t && r.winning_team && String(r.winning_team).toLowerCase() !== t).length;
  return {
    matchId: m.matchId || m.metadata?.matchid || null,
    map: m.map || null,
    playedAt: m.playedAt || null,
    agent: me?.character || m.agent || null,
    score: t ? `${won}-${lost}` : null
  };
}
// Tags whose opportunity is "a round played" (single-condition / info tags without a twin).
const PER_ROUND_TAGS = ['DRY_PEEK', 'EARLY_DEATH_NO_ALLY', 'EARLY_DEATH_NO_UTILITY', 'POST_PLANT_ISOLATION'];

function emptyTwinCounters() {
  const out = {};
  for (const name of Object.keys(TWIN_PAIRS)) out[name] = { flaw: 0, positive: 0, neutral: 0, opportunities: 0 };
  return out;
}

function getRoundPlayerStats(r) {
  if (Array.isArray(r.all_player_stats)) return r.all_player_stats;
  if (Array.isArray(r.player_stats)) return r.player_stats;
  return r.player_stats && typeof r.player_stats === 'object' ? Object.values(r.player_stats) : [];
}

/**
 * Runs Layer A for ONE player in ONE match and tallies opportunities (n) and events (k)
 * per `${role}_${side}_${tag}` cell. Single source of truth for the target AND for peers,
 * so the target's rate and the peer baseline always share one opportunity definition.
 */
function tallyPlayerMatch(m, puuid, riotId, role) {
  const matchId = m.matchId || m.metadata?.matchid || 'comp_match';
  const idLower = (riotId || '').toLowerCase().trim();
  const isMe = (pu, name) => Boolean((puuid && pu === puuid) || (name && name.toLowerCase() === idLower));
  const team = getPlayerTeam(m, puuid, riotId);
  const killsByRound = groupKillsByRound(m.kill_events || m.kills || []);

  const cells = {};
  const twin = emptyTwinCounters();
  const hits = [];
  const halves = new Set();

  const cell = (side, tag) => {
    const key = `${role}_${side}_${tag}`;
    return cells[key] || (cells[key] = { role, side, tag, n: 0, k: 0 });
  };
  // Adds opportunities to both twin cells. neutral = opps - flaw - positive; flaw+positive > opps
  // means a detector fired twice for one opportunity and surfaces as an invariant violation.
  const tallyPair = (name, side, opps, f, p) => {
    const def = TWIN_PAIRS[name];
    cell(side, def.flaw).n += opps;
    cell(side, def.positive).n += opps;
    const c = twin[name];
    c.opportunities += opps;
    c.flaw += f;
    c.positive += p;
    c.neutral += Math.max(0, opps - f - p);
  };

  (m.rounds || []).forEach((r, idx) => {
    const roundNum = r.round_num || (idx + 1);
    const side = getSideForRound(team, roundNum);
    const halfKey = `${matchId}_${roundNum <= 12 ? 'H1' : (roundNum <= 24 ? 'H2' : 'OT')}`;
    halves.add(halfKey);

    const roundKills = killsByRound.get(roundNum) || [];
    const roundStats = getRoundPlayerStats(r).find(ps => isMe(ps.player_puuid, ps.player_display_name));
    const plantEvents = r.plant_events || (r.plant ? [r.plant] : []);
    const plantTimeMs = plantEvents[0]?.round_time_in_ms;

    const situations = detectRoundSituations({
      matchId, roundNum, side, role,
      killEvents: roundKills, roundStats,
      playerRiotId: riotId, playerPuuid: puuid, plantEvents
    });
    const count = tag => situations.filter(s => s.tag === tag).length;

    // DRY_PEEK / EARLY_DEATH_NO_UTILITY need known utility; v4 rounds have none, so they get no opportunity
    const utilityKnown = getRoundUtilityCasts(roundStats) != null;
    PER_ROUND_TAGS.forEach(tag => {
      if (!utilityKnown && (tag === 'DRY_PEEK' || tag === 'EARLY_DEATH_NO_UTILITY')) return;
      cell(side, tag).n += 1;
    });

    // ENTRY: one opportunity per attack round with a first contact (Duelist / Initiator)
    if (side === 'attack' && (role === 'Duelist' || role === 'Initiator') && roundKills.length > 0) {
      tallyPair('ENTRY', side, 1, count('LETS_TEAMMATES_ENTER_FIRST'), count('TAKES_SPACE'));
    }

    // SPACING: each pre-plant kill/death of an Initiator/Controller on attack (never Sentinel/Duelist)
    if (side === 'attack' && SPACING_ROLES.includes(role)) {
      const engagements = roundKills.filter(k =>
        (isMe(k.killer_puuid, k.killer_display_name) || isMe(k.victim_puuid, k.victim_display_name)) &&
        (plantTimeMs == null || Number(k.kill_time_in_round || 0) < plantTimeMs)
      ).length;
      if (engagements > 0) tallyPair('SPACING', side, engagements, count('ISOLATED_PLAY'), count('STAYS_WITH_TEAM'));
    }

    // Pairs whose opportunity IS the detector firing one of the twins
    for (const [name, def] of Object.entries(TWIN_PAIRS)) {
      if (!def.oppFromSituations) continue;
      const f = count(def.flaw);
      const p = count(def.positive);
      if (f + p > 0) tallyPair(name, side, f + p, f, p);
    }

    for (const sit of situations) {
      cell(side, sit.tag).k += 1;
      hits.push({ sit, roundNum, side, halfKey });
    }
  });

  return { matchId, team, cells, twin, hits, halves };
}

/**
 * Computes empirical Peer Baselines v2 conditioned on role x side x detector.
 * Peers = the other players in the same matches, each with the role of the agent they played THAT match.
 * Only includes peers with >= 1 opportunity (never treats 0 opportunities as 0%).
 * p0 = sum(events) / sum(opportunities) with Wilson CI.
 * Requires >= HABIT_RULES.MIN_PEER_OPPORTUNITIES pooled opportunities per cell, else has_baseline = false.
 */
function computePeerBaselinesV2(sampleMatches, targetPuuid, targetRiotId) {
  const targetIdLower = (targetRiotId || '').toLowerCase().trim();
  const cells = {};

  for (const m of sampleMatches) {
    const allPlayers = m.all_players || m.players?.all_players || [];
    const peers = allPlayers.filter(p => !(
      (targetPuuid && p.puuid === targetPuuid) ||
      (`${p.name}#${p.tag}`.toLowerCase() === targetIdLower)
    ));

    for (const peer of peers) {
      const peerRole = getRoleForAgent(peer.character || peer.agent) || 'Flex';
      const { cells: peerCells } = tallyPlayerMatch(m, peer.puuid, `${peer.name}#${peer.tag}`, peerRole);
      for (const [cellKey, c] of Object.entries(peerCells)) {
        if (c.n < 1) continue;
        const pooled = cells[cellKey] || (cells[cellKey] = { events: 0, opps: 0, peerRates: [] });
        pooled.events += c.k;
        pooled.opps += c.n;
        pooled.peerRates.push(c.k / c.n);
      }
    }
  }

  const baselineResults = {};
  for (const [cellKey, data] of Object.entries(cells)) {
    const { opps, events } = data;
    if (opps >= HABIT_RULES.MIN_PEER_OPPORTUNITIES) {
      const p0 = events / opps;
      const ci = computeWilsonBoundsNumeric(events, opps);
      const medianRate = getPercentile([...data.peerRates].sort((a, b) => a - b), 0.50);
      baselineResults[cellKey] = {
        has_baseline: true,
        p0: Number(p0.toFixed(4)),
        p0_pct: Number((p0 * 100).toFixed(1)),
        ci: [Number((ci.lower * 100).toFixed(1)), Number((ci.upper * 100).toFixed(1))],
        peer_median_pct: Number((medianRate * 100).toFixed(1)),
        pooled_opportunities: opps,
        pooled_events: events,
        eligible_peers_count: data.peerRates.length
      };
    } else {
      baselineResults[cellKey] = {
        has_baseline: false,
        p0: null,
        p0_pct: null,
        ci: null,
        peer_median_pct: null,
        pooled_opportunities: opps,
        pooled_events: events,
        reason: `Insufficient peer sample (${opps} / ${HABIT_RULES.MIN_PEER_OPPORTUNITIES} opportunities)`
      };
    }
  }

  return baselineResults;
}

function classifyTier({ tag, polarity, role, side, k, n, cellMatches, matchesSeen, peerInfo, bounds }) {
  const R = HABIT_RULES;
  if (side === 'unknown' || n < R.MIN_OPPORTUNITIES || cellMatches < R.MIN_MATCHES) return 'not enough data';
  if (polarity === 'flaw' && !isFlawForRole(tag, role, side)) return 'not applicable for role';
  const consistent = k >= R.MIN_EVENTS && (matchesSeen / cellMatches) >= R.MIN_MATCH_PCT;
  if (!consistent || !peerInfo.has_baseline || peerInfo.p0 == null) return 'occasional';
  const p0 = peerInfo.p0;
  const diff = k / n - p0;
  if (bounds.lower > p0 + R.STRONG_LOWER_MARGIN && diff >= R.STRONG_MIN_DIFF) return 'strong habit';
  if (bounds.lower > p0 && diff >= R.PATTERN_MIN_DIFF) return 'pattern';
  return 'occasional';
}

/**
 * Aggregates detected situations across matches per detector x role x side,
 * with Twin-Pair Invariants and Tiers v2 against same-cell peer baselines.
 * @param {Array} matches - Up to 50 recent matches
 * @param {string} playerRiotId - Riot ID (Name#Tag)
 * @param {string} playerPuuid - Optional PUUID
 */
function aggregateHabits(matches, playerRiotId, playerPuuid) {
  if (!matches || !matches.length) {
    return {
      habits: [],
      peer_baselines: {},
      twin_invariants: {},
      archetype: { title: 'Unknown', confidence: 'not enough data', reason: 'No matches provided' },
      total_matches_analyzed: 0
    };
  }

  const sampleMatches = matches.slice(0, 50);
  const peerBaselines = computePeerBaselinesV2(sampleMatches, playerPuuid, playerRiotId);

  const agg = {}; // cellKey -> { role, side, tag, n, k, oppMatches:Set, matchesSeen:Set, exampleRounds:[] }
  const twinCounters = emptyTwinCounters();
  const allHalves = new Set();
  const usedCueRoundsByMatch = new Map();

  for (const m of sampleMatches) {
    // Role of the agent played in THAT match; unknown agent -> 'Flex' (role-conditioned detectors skip)
    const role = getRoleForMatch(m, playerRiotId, playerPuuid) || 'Flex';
    const res = tallyPlayerMatch(m, playerPuuid, playerRiotId, role);
    const meta = getMatchMeta(m, playerPuuid, playerRiotId, res.team);
    res.halves.forEach(h => allHalves.add(h));

    for (const [name, c] of Object.entries(res.twin)) {
      for (const f of Object.keys(c)) twinCounters[name][f] += c[f];
    }

    for (const [cellKey, c] of Object.entries(res.cells)) {
      const a = agg[cellKey] || (agg[cellKey] = { role: c.role, side: c.side, tag: c.tag, n: 0, k: 0, oppMatches: new Set(), matchesSeen: new Set(), exampleRounds: [] });
      a.n += c.n;
      a.k += c.k;
      if (c.n > 0) a.oppMatches.add(res.matchId);
      if (c.k > 0) a.matchesSeen.add(res.matchId);
    }

    // Replay cues: up to MAX_CUES_PER_HABIT per cell, each from a different match and an unused round,
    // never a flaw the role doesn't own. Match meta lets the player find the game in their replay list.
    if (!usedCueRoundsByMatch.has(res.matchId)) usedCueRoundsByMatch.set(res.matchId, new Set());
    const usedRounds = usedCueRoundsByMatch.get(res.matchId);
    for (const { sit, roundNum, side } of res.hits) {
      const a = agg[`${role}_${side}_${sit.tag}`];
      const eligible = sit.polarity !== 'flaw' || isFlawForRole(sit.tag, role, side);
      const matchUsed = a.exampleRounds.some(c => c.matchId === res.matchId);
      if (eligible && a.exampleRounds.length < MAX_CUES_PER_HABIT && !matchUsed && !usedRounds.has(roundNum)) {
        a.exampleRounds.push({ ...meta, round: roundNum, side, role, tag: sit.tag, polarity: sit.polarity, clockTime: sit.clockDisplay, evidence: sit.evidence });
        usedRounds.add(roundNum);
      }
    }
  }

  for (const [pairName, counts] of Object.entries(twinCounters)) {
    const sum = counts.flaw + counts.positive + counts.neutral;
    if (sum !== counts.opportunities) {
      console.warn(`[TWIN-PAIR INVARIANT VIOLATION] ${pairName}: flaw (${counts.flaw}) + positive (${counts.positive}) + neutral (${counts.neutral}) = ${sum} !== opportunities (${counts.opportunities})`);
    }
  }

  const numMatches = sampleMatches.length;
  const classifiedHabits = [];

  for (const [cellKey, a] of Object.entries(agg)) {
    const { tag, role, side, k, n } = a;
    if (n === 0 && k === 0) continue;
    const meta = HABIT_TEMPLATES[tag] || { title: tag, polarity: 'flaw', template: () => tag };
    const rate = n > 0 ? Number((k / n).toFixed(4)) : 0;
    const ci = computeWilsonCI(k, n);
    const bounds = computeWilsonBoundsNumeric(k, n);
    const cellMatches = a.oppMatches.size;
    const peerInfo = peerBaselines[cellKey] || { has_baseline: false };

    const tier = classifyTier({
      tag, polarity: meta.polarity, role, side, k, n,
      cellMatches, matchesSeen: a.matchesSeen.size, peerInfo, bounds
    });

    const peerP0Pct = peerInfo.has_baseline ? peerInfo.p0_pct : null;
    const habitObj = {
      id: tag,
      cell: cellKey,
      role,
      side,
      title: meta.title,
      polarity: meta.polarity,
      tier,
      k,
      n,
      rate,
      ratePct: Number((rate * 100).toFixed(1)),
      ci,
      // display only: each side is played in one regulation half per match
      perHalf: cellMatches > 0 ? Number((k / cellMatches).toFixed(1)) : 0,
      matchesSeen: a.matchesSeen.size,
      matchesWithOpportunity: cellMatches,
      halvesEvaluated: cellMatches,
      peer_baseline: {
        has_baseline: Boolean(peerInfo.has_baseline),
        p0: peerInfo.p0 ?? null,
        p0_pct: peerP0Pct,
        p0_ci: peerInfo.ci ?? null,
        peer_median_pct: peerInfo.peer_median_pct ?? null, // display context only
        pooled_opportunities: peerInfo.pooled_opportunities ?? 0,
        comparison: peerInfo.has_baseline
          ? `vs pooled peer p0: ${peerP0Pct}%`
          : (peerInfo.reason || `no baseline (<${HABIT_RULES.MIN_PEER_OPPORTUNITIES} peer opps)`)
      },
      peerComparison: peerInfo.has_baseline ? `vs ${role} ${side} peers: ${peerP0Pct}%` : '',
      narrative: '',
      exampleCues: a.exampleRounds
    };
    habitObj.narrative = meta.template(habitObj);
    classifiedHabits.push(habitObj);
  }

  // "Closest to a problem": the applicable flaw furthest above same-role peers that did NOT clear the pattern bar.
  // Shown as "worth watching, not proven", never as a flaw.
  const watchItem = classifiedHabits
    .filter(h => h.polarity === 'flaw' && h.tier === 'occasional' && h.k > 0 && h.peer_baseline.has_baseline && h.rate > h.peer_baseline.p0)
    .sort((a, b) => (b.rate - b.peer_baseline.p0) - (a.rate - a.peer_baseline.p0))[0] || null;

  const tierWeight = { 'strong habit': 3, 'pattern': 2, 'occasional': 1, 'not enough data': 0 };
  classifiedHabits.sort((a, b) => ((tierWeight[b.tier] || 0) - (tierWeight[a.tier] || 0)) || (b.n - a.n));

  return {
    habits: classifiedHabits,
    peer_baselines: peerBaselines,
    twin_invariants: twinCounters,
    watch_item: watchItem ? { cell: watchItem.cell, id: watchItem.id } : null,
    archetype: rebuildArchetypeHonest(classifiedHabits, numMatches),
    total_matches_analyzed: numMatches,
    total_halves_analyzed: allHalves.size
  };
}

/**
 * Rebuilds the Playstyle Archetype with Output Honesty (Requirement 6):
 * Name an archetype ONLY if at least one behavior clears the pattern rule vs peers.
 * Else "No distinct archetype yet (N matches)". Confidence computed from N and CI width.
 */
function rebuildArchetypeHonest(habits, numMatches) {
  const patternHabits = habits.filter(h => h.tier === 'pattern' || h.tier === 'strong habit');

  // Compute confidence from N and CI width
  const avgCiWidth = habits.length > 0
    ? habits.reduce((acc, h) => acc + ((h.ci[1] - h.ci[0]) / 100), 0) / habits.length
    : 0.25;
  const sampleFactor = Math.min(1.0, numMatches / 30);
  const confidenceScore = Number((sampleFactor * (1.0 - Math.min(0.8, avgCiWidth))).toFixed(2));
  const confidenceLabel = confidenceScore >= 0.70 ? 'High' : (confidenceScore >= 0.40 ? 'Moderate' : 'Preliminary');

  if (patternHabits.length === 0) {
    return {
      title: `No distinct archetype yet (${numMatches} matches)`,
      traits: ['Balanced Pacing', 'Baseline Habits', 'Sample Building'],
      description: 'Tactical habits are currently balanced within peer baseline distributions across analyzed matches.',
      confidence: `${confidenceLabel} (Score: ${confidenceScore})`,
      confidence_score: confidenceScore,
      pattern_habits_count: 0
    };
  }

  // Identify leading pattern habit
  const topHabit = patternHabits[0];

  let title = 'Disciplined Tactical Flex';
  let traits = ['Balanced Spacing', 'Adaptive Engagement', 'Flexible Pace'];
  let description = 'Balances team pack spacing with measured individual duels, adapting engagement tempo across match halves.';

  if (topHabit.id === 'LETS_TEAMMATES_ENTER_FIRST') {
    title = 'Second-Contact Followup Duelist';
    traits = ['Bait-and-Switch Entry', 'Late-Round Cleaner', 'Deferred Opening Risk'];
    description = 'Frequently allows initiating teammates to make first contact, positioning to trade secondary duels rather than leading initial entries.';
  } else if (topHabit.id === 'TAKES_SPACE') {
    title = 'Pioneering Space Creator';
    traits = ['Aggressive Entry', 'High First-Contact Priority', 'Site Opening Speed'];
    description = 'Consistently pioneers opening site pathfinding on attack, drawing defense crosshairs and creating deep site territory.';
  } else if (topHabit.id === 'DRY_PEEK') {
    title = 'Hyper-Aggressive Opening Duelist';
    traits = ['High First-Contact Tempo', 'Unassisted Angle Peeks', 'Fast Combat Pace'];
    description = 'Rushes opening combat angles within the initial 22 seconds, accepting high variance in early round engagements.';
  } else if (topHabit.id === 'SOLO_HOLD_VS_STACK') {
    title = 'Isolated Site Anchor';
    traits = ['High-Risk Solo Holds', 'Delayed Retake Call', 'Hero Setup Hold'];
    description = 'Holds aggressive solo angles against multi-man site pushes, frequently isolated without rotation assistance.';
  } else if (topHabit.id === 'ANCHORED_WITH_SUPPORT') {
    title = 'Fortified Site Crossfire Anchor';
    traits = ['Crossfire Discipline', 'Pack Site Defense', 'Retake Symmetry'];
    description = 'Maintains high team proximity during defensive site contestation, forcing attackers into crossfires.';
  } else if (topHabit.id === 'TRADES_WELL') {
    title = 'Lethal Re-Frag Specialist';
    traits = ['Instant Revenge Trading', 'High Trading Conversion', 'Pack Spacing'];
    description = 'Capitalizes on teammate contact with high trade conversion rates, consistently re-fragging enemy players within 5 seconds.';
  } else if (topHabit.id === 'ISOLATED_PLAY') {
    title = 'Lurk & Space Isolator';
    traits = ['Solo Flank Route', 'Distant Spacing', 'High-Risk Macro Control'];
    description = 'Takes wide flank angles separated from the main team push, forcing defense rotators to clear wide angles.';
  } else if (topHabit.id === 'STAYS_WITH_TEAM') {
    title = 'Coordinated Pack Player';
    traits = ['Tight Pack Spacing', 'Trade Discipline', 'Team Synergy'];
    description = 'Consistently maintains disciplined team pack spacing (<15m) on attack hits, ensuring tradeability.';
  } else if (topHabit.id === 'UNSYNCED_LURK_DEATH') {
    title = 'Desynchronized Flank Lurker';
    traits = ['Isolated Lurking', 'Early Flank Contact', 'Unsynced Site Timing'];
    description = 'Takes deep solo lurk angles on attack, but frequently dies before the main team initiates site contact.';
  } else if (topHabit.id === 'SYNCED_LURK_KILL') {
    title = 'Synchronized Flank Lurker';
    traits = ['High-Timing Lurk', 'Pincer Flank Frags', 'Macro Space Control'];
    description = 'Executes disciplined flank pathing on attack, converting kills timed within 10 seconds of team site hits.';
  }

  return {
    title,
    traits,
    description,
    confidence: `${confidenceLabel} (Score: ${confidenceScore})`,
    confidence_score: confidenceScore,
    pattern_habits_count: patternHabits.length,
    dominant_pattern: topHabit.title
  };
}

module.exports = {
  aggregateHabits,
  tallyPlayerMatch,
  computeWilsonCI,
  computeWilsonBoundsNumeric,
  computePeerBaselines: computePeerBaselinesV2,
  computePeerBaselinesV2,
  rebuildArchetypeHonest,
  TWIN_PAIRS,
  HABIT_TEMPLATES
};
