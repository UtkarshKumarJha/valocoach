/**
 * Habit Aggregator (Layer B)
 * 
 * Aggregates detected situations across up to 50 matches:
 * Computes: n opportunities, k events, rate, Wilson 95% CI, per-half rate, matchesSeen.
 * Classifies habit tier:
 * - n < 15 or matches < 5 -> "not enough data"
 * - occasional (<= 2 per half) -> "occasional" (never flagged in UI)
 * - pattern (>= 3 per half in >= 50% halves AND >= 40% matches) -> "pattern"
 * - strong habit (>= 5 per half in >= 70% halves AND >= 60% matches) -> "strong habit"
 * 
 * Generates soft-worded UI templates with hard labels internally.
 * Rebuilds Playstyle Archetype from behavior metrics relative to role baseline.
 */

const { HABIT_RULES, SPATIAL_CONFIG } = require('../config/telemetryConfig');
const { getRoleForMatch } = require('./agentRoleService');
const { detectRoundSituations } = require('./situationDetectors');

// Wilson CI wrapper with fallback
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

// Soft UI narrative templates mapped to internal detector tags
const HABIT_TEMPLATES = {
  // Flaws
  'LETS_TEAMMATES_ENTER_FIRST': {
    title: 'Deferred Entry Contact',
    polarity: 'flaw',
    template: (h) => `You've been observed to let teammates make first contact on attack, in about ${h.perHalf} rounds per half across your last ${h.matchesSeen} matches.`
  },
  'SOLO_HOLD_VS_STACK': {
    title: 'Isolated Anchor vs Site Push',
    polarity: 'flaw',
    template: (h) => `You frequently find yourself holding solo against 3+ enemy site rushes on defense, in about ${h.perHalf} rounds per half without rotation support.`
  },
  'DRY_PEEK': {
    title: 'Early Unassisted Duel',
    polarity: 'flaw',
    template: (h) => `You've been observed to contest early angles within 22s without utility or nearby ally support in about ${h.perHalf} rounds per half.`
  },
  'EARLY_DEATH_NO_ALLY': {
    title: 'Solo Utility Duel',
    polarity: 'flaw',
    template: (h) => `You took early opening duels without trade support in about ${h.perHalf} rounds per half, despite using abilities.`
  },
  'EARLY_DEATH_NO_UTILITY': {
    title: 'Dry Opening Contact',
    polarity: 'flaw',
    template: (h) => `You entered early combat with allies nearby but without deploying utility in about ${h.perHalf} rounds per half.`
  },
  'UNSUPPORTED_ENTRY': {
    title: 'Isolated Opening Entry',
    polarity: 'flaw',
    template: (h) => `On attack, you conceded first contact without an ally close enough to convert a trade in about ${h.perHalf} rounds per half.`
  },
  'DOESNT_TRADE': {
    title: 'Missed Revenge Trade',
    polarity: 'flaw',
    template: (h) => `You were unable to secure a revenge trade on nearby teammate casualties in about ${Math.round(h.rate * 100)}% of close-range opportunities (${h.k}/${h.n}).`
  },
  'BACKSTAB_DEATH': {
    title: 'Flank Angle Vulnerability',
    polarity: 'flaw',
    template: (h) => `You conceded deaths with your crosshair facing >85° away from your killer in ${h.k} rounds across your matches.`
  },
  'ISOLATED_PLAY': {
    title: 'Isolated Non-Duelist Spacing',
    polarity: 'flaw',
    template: (h) => `On attack, you engaged opponents >25m away from your nearest teammate in about ${h.perHalf} rounds per half.`
  },
  'REPEAT_DEATH_SPOT': {
    title: 'In-Match Chokepoint Recurrence',
    polarity: 'flaw',
    template: (h) => `You died 3 or more times in the exact same ~8m position in a single match across ${h.k} distinct halves.`
  },
  'OPENING_DUEL_LOSS': {
    title: 'First Death Conceded',
    polarity: 'flaw',
    template: (h) => `As duelist, you conceded first death in ${h.k} of ${h.n} opening combat rounds (${Math.round(h.rate * 100)}%).`
  },

  // Positive twins
  'TAKES_SPACE': {
    title: 'Proactive Site Pioneering',
    polarity: 'positive',
    template: (h) => `You actively lead opening pathfinding on attack, being among the first two players at contact in ${Math.round(h.rate * 100)}% of entry duels.`
  },
  'ANCHORED_WITH_SUPPORT': {
    title: 'Supported Site Defense',
    polarity: 'positive',
    template: (h) => `You anchor defense site hits with close teammate proximity, enabling effective site crossfires in ${Math.round(h.rate * 100)}% of pushes.`
  },
  'SUPPORTED_ENTRY': {
    title: 'High-Percentage Entry',
    polarity: 'positive',
    template: (h) => `You take entry fights with close ally support or direct trade conversion in ${Math.round(h.rate * 100)}% of opening attacks.`
  },
  'TRADES_WELL': {
    title: 'Sharp Revenge Trading',
    polarity: 'positive',
    template: (h) => `You converted ${h.k} of ${h.n} gated trade opportunities (${Math.round(h.rate * 100)}%, 95% CI: [${h.ci[0]}%, ${h.ci[1]}%]) when allies were eliminated near you.`
  },
  'CROSSHAIR_FACING_DUEL': {
    title: 'Disciplined Angle Anticipation',
    polarity: 'positive',
    template: (h) => `Your crosshair was aligned toward your attacker within 45° in ${Math.round(h.rate * 100)}% of combat engagements.`
  },
  'PACK_PLAY': {
    title: 'Coordinated Team Spacing',
    polarity: 'positive',
    template: (h) => `You maintained disciplined spacing (within 15m of an ally) in ${Math.round(h.rate * 100)}% of attack engagements.`
  },
  'OPENING_DUEL_WIN': {
    title: 'First-Blood Conversion',
    polarity: 'positive',
    template: (h) => `As duelist, you secured first blood in ${h.k} of ${h.n} opening combat rounds (${Math.round(h.rate * 100)}%).`
  }
};

/**
 * Aggregates detected situations across matches for a player.
 * @param {Array} matches - Up to 50 recent matches
 * @param {string} playerRiotId - Riot ID (Name#Tag)
 * @param {string} playerPuuid - Optional PUUID
 */
function aggregateHabits(matches, playerRiotId, playerPuuid) {
  if (!matches || !matches.length) {
    return {
      habits: [],
      archetype: { title: 'Unknown', confidence: 'not enough data', reason: 'No matches provided' },
      total_matches_analyzed: 0
    };
  }

  // Cap at 50 matches
  const sampleMatches = matches.slice(0, 50);
  const riotIdLower = (playerRiotId || '').toLowerCase().trim();

  // Registry for tracking occurrences across halves and matches
  // Structure: { [tag]: { k: number, n: number, halves: Map<halfKey, count>, matches: Set<matchId>, exampleRounds: [] } }
  const tagAggregates = {};

  const initTag = (tag) => {
    if (!tagAggregates[tag]) {
      const meta = HABIT_TEMPLATES[tag] || { title: tag, polarity: 'flaw', template: () => tag };
      tagAggregates[tag] = {
        id: tag,
        title: meta.title,
        polarity: meta.polarity,
        k: 0,
        n: 0,
        halvesCount: {}, // halfKey -> eventCount
        matchesSeen: new Set(),
        exampleRounds: []
      };
    }
  };

  // Pre-initialize known tags
  Object.keys(HABIT_TEMPLATES).forEach(initTag);

  let totalHalvesAnalyzed = 0;
  const matchRoles = [];

  // Track in-match repeat death spots: cell -> count per match per side
  for (const m of sampleMatches) {
    const matchId = m.matchId || `match_${Math.random()}`;
    const matchRole = getRoleForMatch(m, playerRiotId, playerPuuid);
    matchRoles.push(matchRole);

    const rounds = m.rounds || [];
    const killEvents = m.kill_events || [];

    // Group rounds into Halves: Half 1 (1-12), Half 2 (13-24), OT (25+)
    const halves = {
      half1: { side: 'attack', rounds: [] },
      half2: { side: 'defense', rounds: [] }
    };

    rounds.forEach((r, idx) => {
      const roundNum = idx + 1;
      const isFirstHalf = roundNum <= 12;
      const halfKey = isFirstHalf ? `${matchId}_H1` : `${matchId}_H2`;
      const side = isFirstHalf ? 'attack' : 'defense';

      if (!tagAggregates['LETS_TEAMMATES_ENTER_FIRST'].halvesCount[halfKey]) {
        // Initialize this half across all tags
        Object.keys(tagAggregates).forEach(tag => {
          tagAggregates[tag].halvesCount[halfKey] = 0;
        });
        totalHalvesAnalyzed += 1;
      }

      // Run pure situation detector for this round
      const roundKills = killEvents.filter(k => k.round === roundNum || (k.round == null && Math.floor(killEvents.indexOf(k) / 6) === idx));
      const situations = detectRoundSituations({
        matchId,
        roundNum,
        side,
        role: matchRole,
        killEvents: roundKills,
        roundStats: r.player_stats,
        playerRiotId,
        playerPuuid
      });

      // Track opportunities (n)
      if (side === 'attack' && (matchRole === 'Duelist' || matchRole === 'Initiator')) {
        tagAggregates['LETS_TEAMMATES_ENTER_FIRST'].n += 1;
        tagAggregates['TAKES_SPACE'].n += 1;
      }
      if (matchRole === 'Duelist') {
        tagAggregates['OPENING_DUEL_WIN'].n += 1;
        tagAggregates['OPENING_DUEL_LOSS'].n += 1;
      }
      if (side === 'defense') {
        tagAggregates['SOLO_HOLD_VS_STACK'].n += 1;
        tagAggregates['ANCHORED_WITH_SUPPORT'].n += 1;
      }
      if (side === 'attack') {
        tagAggregates['UNSUPPORTED_ENTRY'].n += 1;
        tagAggregates['SUPPORTED_ENTRY'].n += 1;
        tagAggregates['DRY_PEEK'].n += 1;
        tagAggregates['EARLY_DEATH_NO_ALLY'].n += 1;
        tagAggregates['EARLY_DEATH_NO_UTILITY'].n += 1;
      }
      if (side === 'attack' && matchRole !== 'Duelist') {
        tagAggregates['ISOLATED_PLAY'].n += 1;
        tagAggregates['PACK_PLAY'].n += 1;
      }

      // Record events (k)
      for (const sit of situations) {
        initTag(sit.tag);
        const agg = tagAggregates[sit.tag];
        agg.k += 1;
        agg.halvesCount[halfKey] = (agg.halvesCount[halfKey] || 0) + 1;
        agg.matchesSeen.add(matchId);

        // Record example rounds (up to 3)
        if (agg.exampleRounds.length < 3) {
          agg.exampleRounds.push({
            matchId,
            round: roundNum,
            side,
            clockTime: sit.clockDisplay,
            evidence: sit.evidence
          });
        }

        // Special handling for Gated Trade opportunities
        if (sit.tag === 'TRADES_WELL' || sit.tag === 'DOESNT_TRADE') {
          tagAggregates['TRADES_WELL'].n += 1;
          tagAggregates['DOESNT_TRADE'].n += 1;
        }

        // Special handling for Backstab opportunities
        if (sit.tag === 'BACKSTAB_DEATH' || sit.tag === 'CROSSHAIR_FACING_DUEL') {
          tagAggregates['BACKSTAB_DEATH'].n += 1;
          tagAggregates['CROSSHAIR_FACING_DUEL'].n += 1;
        }
      }
    });

    // Detect In-Match Repeat Death Spots (~8m cells: 800 units, >= 3 deaths in one cell in ONE match)
    const cellDeaths = {};
    for (const k of killEvents) {
      const isVictim = (playerPuuid && k.victim_puuid === playerPuuid) ||
                       (k.victim_display_name && k.victim_display_name.toLowerCase() === riotIdLower);
      if (isVictim && k.victim_death_location) {
        const roundNum = k.round || 1;
        const side = roundNum <= 12 ? 'attack' : 'defense';
        const cellX = Math.floor(k.victim_death_location.x / (SPATIAL_CONFIG.REPEAT_SPOT_CELL_SIZE_METERS * 100));
        const cellY = Math.floor(k.victim_death_location.y / (SPATIAL_CONFIG.REPEAT_SPOT_CELL_SIZE_METERS * 100));
        const cellKey = `${side}_${cellX}_${cellY}`;
        cellDeaths[cellKey] = (cellDeaths[cellKey] || 0) + 1;

        if (cellDeaths[cellKey] === 3) {
          // Reached repeat threshold in this match
          const agg = tagAggregates['REPEAT_DEATH_SPOT'];
          agg.k += 1;
          agg.matchesSeen.add(matchId);
          agg.exampleRounds.push({
            matchId,
            round: roundNum,
            side,
            clockTime: `Cell (${cellX}, ${cellY})`,
            evidence: { cellKey, repeatDeathsInMatch: 3 }
          });
        }
      }
    }
    tagAggregates['REPEAT_DEATH_SPOT'].n += (m.deaths || 1);
  }

  const numMatches = sampleMatches.length;
  const numHalves = Math.max(1, totalHalvesAnalyzed);

  // 3. Classify Habit Tiers
  const classifiedHabits = [];

  for (const [tag, agg] of Object.entries(tagAggregates)) {
    const k = agg.k;
    const n = Math.max(k, agg.n);
    const rate = n > 0 ? Number((k / n).toFixed(3)) : 0;
    const ci = computeWilsonCI(k, n);
    const matchesSeenCount = agg.matchesSeen.size;

    // Per half calculation
    const perHalf = Number((k / numHalves).toFixed(1));

    // Calculate percentage of halves that had >= 3 or >= 5 occurrences
    const halfCounts = Object.values(agg.halvesCount);
    const halvesWith3Plus = halfCounts.filter(c => c >= HABIT_RULES.PATTERN_MIN_PER_HALF).length;
    const halvesWith5Plus = halfCounts.filter(c => c >= HABIT_RULES.STRONG_MIN_PER_HALF).length;

    const halfPct3Plus = halvesWith3Plus / numHalves;
    const halfPct5Plus = halvesWith5Plus / numHalves;
    const matchSeenPct = matchesSeenCount / numMatches;

    let tier = 'occasional';

    if (n < HABIT_RULES.MIN_OPPORTUNITIES || numMatches < HABIT_RULES.MIN_MATCHES) {
      tier = 'not enough data';
    } else if (halfPct5Plus >= HABIT_RULES.STRONG_MIN_HALF_PCT && matchSeenPct >= HABIT_RULES.STRONG_MIN_MATCH_PCT) {
      tier = 'strong habit';
    } else if (halfPct3Plus >= HABIT_RULES.PATTERN_MIN_HALF_PCT && matchSeenPct >= HABIT_RULES.PATTERN_MIN_MATCH_PCT) {
      tier = 'pattern';
    } else if (perHalf <= HABIT_RULES.OCCASIONAL_MAX_PER_HALF) {
      tier = 'occasional';
    }

    const templateMeta = HABIT_TEMPLATES[tag] || {
      title: tag,
      polarity: agg.polarity,
      template: () => tag
    };

    const habitObj = {
      id: tag,
      title: templateMeta.title,
      polarity: templateMeta.polarity,
      tier,
      k,
      n,
      rate,
      ci,
      perHalf,
      matchesSeen: matchesSeenCount,
      exampleRounds: agg.exampleRounds,
      text: templateMeta.template({
        k,
        n,
        rate,
        ci,
        perHalf,
        matchesSeen: matchesSeenCount
      })
    };

    classifiedHabits.push(habitObj);
  }

  // 0b. Rebuild Playstyle Archetype from behavior metrics relative to role baseline
  const archetype = rebuildPlaystyleArchetype(classifiedHabits, matchRoles, numMatches);

  return {
    habits: classifiedHabits,
    archetype,
    total_matches_analyzed: numMatches,
    total_halves_analyzed: numHalves
  };
}

/**
 * 0b. Rebuilds Playstyle Archetype relative to role baseline from behavior metrics.
 * Requires >= 15 opportunities, else "not enough data".
 */
function rebuildPlaystyleArchetype(habits, matchRoles, numMatches) {
  // Aggregate total opportunities across all combat behavior tags
  const totalOpportunities = habits.reduce((acc, h) => acc + (h.n || 0), 0);

  if (totalOpportunities < 15 || numMatches < 1) {
    return {
      title: 'Developing Operative',
      confidence: 'not enough data',
      reason: 'Requires >= 15 evaluated combat opportunities across competitive matches',
      traits: ['Sample building']
    };
  }

  // Determine predominant role played across matches
  const roleFreq = {};
  matchRoles.forEach(r => { roleFreq[r] = (roleFreq[r] || 0) + 1; });
  const dominantRole = Object.keys(roleFreq).sort((a, b) => roleFreq[b] - roleFreq[a])[0] || 'Duelist';

  // Find key habit metrics
  const takesSpace = habits.find(h => h.id === 'TAKES_SPACE')?.rate || 0;
  const letsEnter = habits.find(h => h.id === 'LETS_TEAMMATES_ENTER_FIRST')?.rate || 0;
  const dryPeek = habits.find(h => h.id === 'DRY_PEEK')?.rate || 0;
  const tradesWell = habits.find(h => h.id === 'TRADES_WELL')?.rate || 0;
  const doesntTrade = habits.find(h => h.id === 'DOESNT_TRADE')?.rate || 0;
  const isolated = habits.find(h => h.id === 'ISOLATED_PLAY')?.rate || 0;
  const anchored = habits.find(h => h.id === 'ANCHORED_WITH_SUPPORT')?.rate || 0;
  const openingWin = habits.find(h => h.id === 'OPENING_DUEL_WIN')?.rate || 0;

  let title = 'Disciplined Tactical Operative';
  let traits = [];
  let description = '';

  if (dominantRole === 'Duelist') {
    if (takesSpace >= 0.45 || dryPeek >= 0.25) {
      title = 'Hyper-Aggressive Entry Duelist';
      traits = ['Forward Space Pioneer', 'Fast First Contact', 'Site Penetration'];
      description = 'Consistently pioneers opening site entry, demanding rapid teammate follow-up to trade.';
    } else if (tradesWell >= 0.35 || openingWin >= 0.50) {
      title = 'Calculated Re-Frag Duelist';
      traits = ['High-Percentage Duelist', 'Trade Converter', 'Late Round Anchor'];
      description = 'Takes disciplined second-contact duels, capitalizing on teammate entry with lethal precision.';
    } else {
      title = 'Tactical Duelist';
      traits = ['Space Creator', 'Opening Pressure', 'Adaptive Pacing'];
      description = 'Maintains balanced combat entry pacing across offensive and defensive halves.';
    }
  } else if (dominantRole === 'Initiator') {
    if (tradesWell >= 0.30 || takesSpace >= 0.30) {
      title = 'Forward Flash & Trade Enabler';
      traits = ['Aggressive Info Gathering', 'Revenge Fragger', 'Site Breaker'];
      description = 'Drives offensive momentum by pairing utility flashes with immediate high-percentage trades.';
    } else {
      title = 'Backline Recon & Utility Orchestrator';
      traits = ['Zone Clearance', 'Disruption Utility', 'Support Spacing'];
      description = 'Maximizes round win expectancy through disciplined backline recon utility and structured trades.';
    }
  } else if (dominantRole === 'Controller') {
    if (anchored >= 0.35 && isolated <= 0.20) {
      title = 'Tactical Site Anchor & Smokesmith';
      traits = ['Zone Denial', 'Crossfire Anchoring', 'Post-Plant Specialist'];
      description = 'Controls bombsite choke points with high longevity, holding crossfires with teammate support.';
    } else {
      title = 'Aggressive Space-Denial Controller';
      traits = ['Forward Smokes', 'Close-Range Contestation', 'Dynamic Rotation'];
      description = 'Deploys vision denial proactively to force favorable isolated gunfights.';
    }
  } else if (dominantRole === 'Sentinel') {
    if (isolated >= 0.25) {
      title = 'Lurk & Flank Control Sentinel';
      traits = ['Flank Security', 'Passive Map Control', 'Split Pressure'];
      description = 'Exerts heavy macro pressure through disciplined lurk timings and isolated flank denial.';
    } else {
      title = 'Site Lockdown & Trap Architect';
      traits = ['Site Stalling', 'Anchor Setup', 'Crossfire Coordinator'];
      description = 'Anchors defensive bombsites by pairing static utility traps with defensive crossfires.';
    }
  }

  return {
    title,
    traits,
    description,
    confidence: numMatches >= 5 ? 'High (Behavioral Telemetry Evaluated)' : 'Preliminary (Sample building)',
    dominant_role: dominantRole
  };
}

module.exports = {
  aggregateHabits,
  rebuildPlaystyleArchetype,
  computeWilsonCI,
  HABIT_TEMPLATES
};
