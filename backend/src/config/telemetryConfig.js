/**
 * Telemetry Configuration & Constants
 */

const FEATURE_VERSION = '2.0.0';

// 0a. Supported Queues: competitive, unrated, premier
const SUPPORTED_QUEUES = ['competitive', 'unrated', 'premier'];


/**
 * Allowlist gate: a match is analyzed only if its queue id is competitive, unrated or premier.
 * Queue id is preferred over the mode name because Riot labels some non-5v5 queues (e.g. skirmish_2v2)
 * with mode "Competitive". Anything else, including new modes, is skipped with a recorded reason.
 */
function isSupportedQueue(match) {
  if (!match) return { supported: false, reason: 'missing_payload' };
  const str = v => (typeof v === 'string' ? v : (v?.id || v?.name || null));
  const queueId = str(match.queue) || str(match.metadata?.queue) ||
    (typeof match.metadata?.mode_id === 'string' ? match.metadata.mode_id : null);
  const modeName = str(match.mode) || str(match.metadata?.mode);
  const rawQueue = String(queueId || modeName || '').toLowerCase().trim();

  if (!rawQueue) return { supported: false, reason: 'missing_queue', rawQueue };
  if (SUPPORTED_QUEUES.includes(rawQueue)) return { supported: true, queue: rawQueue };
  return { supported: false, reason: `unsupported_mode: ${rawQueue}`, rawQueue };
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
  if (!rankStr || typeof rankStr !== 'string') return null;
  const r = rankStr.toLowerCase().trim();
  if (r === 'unranked' || r === 'rank unavailable' || r === 'unknown' || r === '') return null;
  if (r.includes('iron') || r.includes('bronze')) return 'Iron-Bronze';
  if (r.includes('silver') || r.includes('gold')) return 'Silver-Gold';
  if (r.includes('plat') || r.includes('diamond')) return 'Plat-Diamond';
  if (r.includes('ascendant') || r.includes('immortal') || r.includes('radiant')) return 'Ascendant+';
  return null; // Never fallback to hardcoded Silver-Gold
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

// 3. Role Expectations & Flaw Filter (Single Source of Truth)
const ROLE_EXPECTATIONS = {
  Duelist: {
    attack: {
      positioning: 'Front of team, entry',
      flaws: ['LETS_TEAMMATES_ENTER_FIRST', 'DRY_PEEK', 'OPENING_DUEL_LOSS'],
      positives: ['TAKES_SPACE', 'OPENING_DUEL_WIN']
    },
    defense: {
      positioning: 'Contests opening space, trades early',
      flaws: ['DRY_PEEK', 'DOESNT_TRADE'],
      positives: ['TRADES_WELL']
    }
  },
  Initiator: {
    attack: {
      positioning: 'Mid-pack with duelists, supports entries',
      flaws: ['ISOLATED_PLAY', 'DRY_PEEK', 'DOESNT_TRADE'],
      positives: ['STAYS_WITH_TEAM', 'TRADES_WELL']
    },
    defense: {
      positioning: 'Info recon & retake support',
      flaws: ['DRY_PEEK', 'DOESNT_TRADE'],
      positives: ['TRADES_WELL']
    }
  },
  Controller: {
    attack: {
      positioning: 'With team, executes smoke line',
      flaws: ['ISOLATED_PLAY', 'DRY_PEEK', 'DOESNT_TRADE'],
      positives: ['STAYS_WITH_TEAM', 'TRADES_WELL']
    },
    defense: {
      positioning: 'Smoke delay and site anchor',
      flaws: ['DRY_PEEK', 'DOESNT_TRADE'],
      positives: ['TRADES_WELL']
    }
  },
  Sentinel: {
    attack: {
      positioning: 'Flank/lurk is expected. Never flag isolation or untradeable deaths.',
      flaws: ['UNSYNCED_LURK_DEATH', 'DRY_PEEK'],
      positives: ['SYNCED_LURK_KILL', 'TRADES_WELL']
    },
    defense: {
      positioning: 'Anchor site hold. SOLO_HOLD_VS_STACK applies.',
      flaws: ['SOLO_HOLD_VS_STACK', 'DRY_PEEK', 'DOESNT_TRADE'],
      positives: ['ANCHORED_WITH_SUPPORT', 'TRADES_WELL']
    }
  }
};

/**
 * Checks if a situation detector tag represents a flaw for a given role and side.
 * Single source of truth across flaws, header stats, and replay cues.
 */
function isFlawForRole(tag, role, side = 'attack') {
  const normRole = (role || 'Flex').trim();
  const normSide = (side || 'attack').toLowerCase();

  // Sentinel Attack: flank/lurk is EXPECTED. Never flag isolation or untradeable deaths.
  if (normRole === 'Sentinel') {
    if (normSide === 'attack') {
      if (tag === 'ISOLATED_PLAY' || tag === 'UNTRADEABLE_DEATH' || tag === 'DOESNT_TRADE') {
        return false;
      }
      return tag === 'UNSYNCED_LURK_DEATH' || tag === 'DRY_PEEK';
    }
    if (normSide === 'defense') {
      return tag === 'SOLO_HOLD_VS_STACK' || tag === 'DRY_PEEK' || tag === 'DOESNT_TRADE';
    }
  }

  // Duelist Attack: entry & space creation
  if (normRole === 'Duelist') {
    if (normSide === 'attack') {
      if (tag === 'ISOLATED_PLAY') return false;
      return tag === 'LETS_TEAMMATES_ENTER_FIRST' || tag === 'DRY_PEEK' || tag === 'OPENING_DUEL_LOSS';
    }
    return tag === 'DRY_PEEK' || tag === 'DOESNT_TRADE';
  }

  // Initiator & Controller Attack: ISOLATED_PLAY applies!
  if (normRole === 'Initiator' || normRole === 'Controller') {
    if (normSide === 'attack') {
      return tag === 'ISOLATED_PLAY' || tag === 'DRY_PEEK' || tag === 'DOESNT_TRADE';
    }
    return tag === 'DRY_PEEK' || tag === 'DOESNT_TRADE';
  }

  const exp = ROLE_EXPECTATIONS[normRole]?.[normSide];
  return exp?.flaws ? exp.flaws.includes(tag) : false;
}

// 3. Habit Tier Rules (PROVISIONAL until labeled rounds + cohort baselines exist)
// Evaluated per detector x role x side cell. "Matches" = matches where that cell had >= 1 opportunity.
const HABIT_RULES = {
  MIN_OPPORTUNITIES: 15,        // n >= 15
  MIN_MATCHES: 5,               // >= 5 matches with an opportunity
  MIN_EVENTS: 8,                // k >= 8
  MIN_MATCH_PCT: 0.40,          // events in >= 40% of those matches
  PATTERN_MIN_DIFF: 0.10,       // pattern: Wilson lower > p0 AND rate - p0 >= 10pp
  STRONG_LOWER_MARGIN: 0.10,    // strong: Wilson lower > p0 + 10pp ...
  STRONG_MIN_DIFF: 0.20,        // ... AND rate - p0 >= 20pp
  MIN_PEER_OPPORTUNITIES: 100   // pooled peer opps per cell, else "no baseline"
};

module.exports = {
  FEATURE_VERSION,
  SUPPORTED_QUEUES,
  isSupportedQueue,
  PROVISIONAL_TIER_TARGETS,
  getTierBand,
  loadCohortBaselines,
  COORDS_PER_METER,
  SPATIAL_CONFIG,
  ROLE_EXPECTATIONS,
  isFlawForRole,
  HABIT_RULES
};
