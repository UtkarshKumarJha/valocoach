/**
 * Telemetry Configuration & Constants
 */

const FEATURE_VERSION = '2.0.0';

// 0a. Supported Queues: competitive, unrated, premier
const SUPPORTED_QUEUES = ['competitive', 'unrated', 'premier'];

const UNSUPPORTED_MODES = [
  'deathmatch',
  'ffa',
  'spikerush',
  'spike rush',
  'escalation',
  'swiftplay',
  'snowball',
  'replication',
  'custom'
];

/**
 * Checks whether a match queue or mode is supported for deep telemetry.
 * Inspects all possible queue/mode properties from Henrik / Riot payloads.
 */
function isSupportedQueue(match) {
  if (!match) return { supported: false, reason: 'missing_payload' };

  const rawQueue = (
    match.queue || 
    match.metadata?.queue || 
    match.mode || 
    match.metadata?.mode || 
    match.metadata?.mode_id || 
    ''
  ).toLowerCase().trim();

  // Explicit check for supported queues
  for (const q of SUPPORTED_QUEUES) {
    if (rawQueue === q || rawQueue.includes(q)) {
      return { supported: true, queue: q };
    }
  }

  // Check if it's explicitly an unsupported mode
  for (const unsup of UNSUPPORTED_MODES) {
    if (rawQueue.includes(unsup)) {
      return { supported: false, reason: `unsupported_mode: ${unsup}`, rawQueue };
    }
  }

  // Fallback: Check round count. Real 5v5 competitive/unrated matches have >= 13 rounds played
  const roundCount = match.rounds?.length || match.metadata?.rounds_played || 0;
  if (roundCount <= 1) {
    return { supported: false, reason: 'unsupported_mode: deathmatch_or_single_round', rawQueue };
  }

  // Default to supported if competitive structure with 12+ rounds
  return { supported: true, queue: 'competitive' };
}

/**
 * 0g. Provisional Tier Targets: 4 collapsed bands
 * Iron-Bronze, Silver-Gold, Plat-Diamond, Ascendant+
 */
const PROVISIONAL_TIER_TARGETS = {
  'Iron-Bronze': {
    targetUntradeableMax: 0.50,
    targetFlankMax: 0.28,
    targetDryPeekMax: 0.32,
    tradeConversionBenchmark: 0.20
  },
  'Silver-Gold': {
    targetUntradeableMax: 0.40,
    targetFlankMax: 0.22,
    targetDryPeekMax: 0.24,
    tradeConversionBenchmark: 0.28
  },
  'Plat-Diamond': {
    targetUntradeableMax: 0.30,
    targetFlankMax: 0.16,
    targetDryPeekMax: 0.16,
    tradeConversionBenchmark: 0.36
  },
  'Ascendant+': {
    targetUntradeableMax: 0.22,
    targetFlankMax: 0.11,
    targetDryPeekMax: 0.11,
    tradeConversionBenchmark: 0.45
  }
};

/**
 * Maps any rank tier string to one of the 4 collapsed provisional bands
 */
function getTierBand(rankStr = '') {
  const r = (rankStr || '').toLowerCase().trim();
  if (r.includes('iron') || r.includes('bronze')) return 'Iron-Bronze';
  if (r.includes('silver') || r.includes('gold')) return 'Silver-Gold';
  if (r.includes('plat') || r.includes('diamond')) return 'Plat-Diamond';
  if (r.includes('ascendant') || r.includes('immortal') || r.includes('radiant')) return 'Ascendant+';
  return 'Silver-Gold'; // Default
}

/**
 * Stub loader for cohort death-density baselines.
 * No percentile or benchmark claims in the UI until cohortBaselines.json exists.
 */
function loadCohortBaselines() {
  const fs = require('fs');
  const path = require('path');
  const baselinePath = path.join(__dirname, 'cohortBaselines.json');
  if (fs.existsSync(baselinePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      return { loaded: true, data };
    } catch {
      return { loaded: false, data: null, reason: 'error_reading_cohortBaselines.json' };
    }
  }
  return { loaded: false, data: null, reason: 'cohortBaselines.json not yet available' };
}

// Coordinate & Distance Conversions (1 unit = 1cm, 100 units = 1m)
const COORDS_PER_METER = 100;

const SPATIAL_CONFIG = {
  COORDS_PER_METER,
  // 0f. Gated Trade Opportunity parameters:
  ALLY_TRADE_MAX_DIST_METERS: 15,       // Ally within 15m (1500 units)
  KILLER_TRADE_MAX_DIST_METERS: 25,     // Killer within 25m of player (2500 units)
  KILLER_TRADE_MAX_VIEW_ANGLE_DEG: 60,  // Killer within +/- 60 deg view cone
  TRADE_TIME_WINDOW_MS: 5000,           // Revenge kill within 5s

  // 0c. Dry-Peek Parameters:
  DRY_PEEK_WINDOW_SEC: 22,              // Opening combat window < 22s
  DRY_PEEK_NO_ALLY_DIST_METERS: 15,     // No ally within 15m (1500 units)

  // 2. Solo Hold vs Stack:
  SOLO_HOLD_ENEMY_COUNT: 3,             // >= 3 enemies
  SOLO_HOLD_ENEMY_DIST_METERS: 20,      // Within 20m (2000 units)
  SOLO_HOLD_NO_ALLY_DIST_METERS: 25,    // 0 teammates within 25m (2500 units)

  // 2. In-Match Repeat Death Spot:
  REPEAT_SPOT_CELL_SIZE_METERS: 8,      // ~8m cells (800 units)
  REPEAT_SPOT_MIN_DEATHS_PER_MATCH: 3,  // >= 3 deaths in one cell in ONE match

  // 2. Isolated play (non-duelist):
  ISOLATED_ALLY_DIST_METERS: 25         // Distance to nearest ally > 25m
};

// 3. Habit Tier Rules
const HABIT_RULES = {
  MIN_OPPORTUNITIES: 15,
  MIN_MATCHES: 5,
  OCCASIONAL_MAX_PER_HALF: 2,           // <= 2 per half: never flag
  PATTERN_MIN_PER_HALF: 3,              // >= 3 per half in >= 50% halves AND >= 40% matches
  PATTERN_MIN_HALF_PCT: 0.50,
  PATTERN_MIN_MATCH_PCT: 0.40,
  STRONG_MIN_PER_HALF: 5,               // >= 5 per half in >= 70% halves AND >= 60% matches
  STRONG_MIN_HALF_PCT: 0.70,
  STRONG_MIN_MATCH_PCT: 0.60
};

module.exports = {
  FEATURE_VERSION,
  SUPPORTED_QUEUES,
  UNSUPPORTED_MODES,
  isSupportedQueue,
  PROVISIONAL_TIER_TARGETS,
  getTierBand,
  loadCohortBaselines,
  COORDS_PER_METER,
  SPATIAL_CONFIG,
  HABIT_RULES
};
