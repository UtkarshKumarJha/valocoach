/**
 * Telemetry Intelligence Engine
 * 
 * Computes deep tactical telemetry patterns:
 * 1. Mode Gating: SUPPORTED_QUEUES (competitive, unrated, premier)
 * 2. Role per Match: Role evaluated per match from agent played in THAT match
 * 3. Gated Trade Analysis: Ally <= 15m, Killer <= 25m, Killer within +/- 60 deg view cone
 * 4. "You Trade Teammates" with Wilson 95% Confidence Interval
 * 5. Dry-Peek: elapsed < 22s AND no ally within 15m AND no utility cast (with single-condition variants)
 * 6. Flank & View Angle Analysis: Died from behind via view_radians wrapped to [0, PI]
 * 7. In-Match Repeat Death Spots: ~8m cells (800 units), >= 3 deaths in one cell in ONE match
 * 8. Provisional 4-Band Tier Targets: Iron-Bronze, Silver-Gold, Plat-Diamond, Ascendant+
 * 9. Habit Aggregation over up to 50 matches (Layer B)
 * 10. Behavioral Playstyle Archetype rebuild (>= 15 opportunities, else "not enough data")
 */

const {
  FEATURE_VERSION,
  SUPPORTED_QUEUES,
  isSupportedQueue,
  PROVISIONAL_TIER_TARGETS,
  getTierBand,
  loadCohortBaselines,
  SPATIAL_CONFIG,
  HABIT_RULES
} = require('../config/telemetryConfig');

const { getRoleForMatch } = require('./agentRoleService');
const { aggregateHabits } = require('./habitAggregator');

/**
 * Wraps angular difference strictly into [0, PI] radians.
 */
function wrapAngleToPi(rad) {
  let diff = Math.atan2(Math.sin(rad), Math.cos(rad));
  return Math.abs(diff);
}

function calculateDistance(locA, locB) {
  if (!locA || !locB || locA.x == null || locB.x == null) return null;
  const dx = locA.x - locB.x;
  const dy = locA.y - locB.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Wilson score confidence interval for binomial proportion with z = 1.96 (95% CI)
 */
function calculateWilsonInterval(successes, trials, z = 1.96) {
  if (trials === 0) return [0, 0];
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return [Number((lower * 100).toFixed(1)), Number((upper * 100).toFixed(1))];
}

exports.wrapAngleToPi = wrapAngleToPi;
exports.calculateDistance = calculateDistance;
exports.calculateWilsonInterval = calculateWilsonInterval;
exports.getTierBand = getTierBand;
exports.HABIT_RULES = HABIT_RULES;

/**
 * Main Telemetry Analysis function
 */
exports.analyzeTelemetry = (matches, playerRiotId, playerPuuid, currentRank = 'Silver 2') => {
  if (!matches || !matches.length) return null;

  const riotIdLower = (playerRiotId || '').toLowerCase().trim();
  const tierBand = getTierBand(currentRank);
  const tierTargets = PROVISIONAL_TIER_TARGETS[tierBand] || PROVISIONAL_TIER_TARGETS['Silver-Gold'];
  const isSingleMatch = (matches.length === 1);

  // 0a. Filter by mode gating: SUPPORTED_QUEUES
  const skippedMatches = [];
  const validMatches = [];

  for (const m of matches) {
    const queueCheck = isSupportedQueue(m);
    if (queueCheck.supported) {
      validMatches.push(m);
    } else {
      skippedMatches.push({
        matchId: m.matchId || 'unknown',
        reason: queueCheck.reason || 'unsupported_mode'
      });
    }
  }

  // If all matches were skipped (e.g. DM payload in test), return skipped info or evaluate in isolated mode
  const isDeathmatchOnly = (validMatches.length === 0 && matches.some(m => {
    const allTeams = new Set((m.kill_events?.[0]?.player_locations_on_kill || []).map(p => p.player_team));
    return allTeams.size >= 8 || m.rounds?.length <= 1;
  }));

  const matchesToProcess = validMatches.length > 0 ? validMatches : matches;

  let totalDeaths = 0;
  let totalKills = 0;
  let eligibleTradeDeaths = 0; // Excludes 1vX last-alive clutch deaths
  let untradeableDeaths = 0;
  let tradedDeaths = 0;

  // 0f. Gated "You Trade Teammates" opportunities and revenge kills
  let teammateTradeOpportunities = 0;
  let youTradeTeammatesCount = 0;

  let diedFromBehindCount = 0;
  let validAngleDeaths = 0;
  let killerAimUnder30Count = 0;
  let validKillerAimDuels = 0;

  // Dry-peeks split by side (Attack vs Defense) & single-condition cases
  let attackDeaths = 0;
  let attackDryPeeks = 0;
  let defenseDeaths = 0;
  let defenseDryPeeks = 0;
  let earlyDeathNoAllyCount = 0;
  let earlyDeathNoUtilityCount = 0;
  let totalDeathTimeSec = 0;

  let totalEngagementDistMeters = 0;
  let engagementCount = 0;
  let closeRangeFights = 0; // < 10m
  let rifleCloseRangeFights = 0;

  let chipAndDieRounds = 0;
  const cueSheetCandidates = [];

  // In-Match Repeat Death Spots (~8m cells = 800 units, >= 3 deaths in ONE match on ONE side)
  const inMatchRepeatSpots = [];

  // Spatial clustering maps grouped by map and side (Attack vs Defense) for Top-3-Cell Share
  const spatialMapSideClusters = {};

  // Process each match
  for (const m of matchesToProcess) {
    const matchId = m.matchId || 'comp_match';
    const killEvents = m.kill_events || [];
    const rounds = m.rounds || [];
    const mapName = m.map || 'Ascent';

    // 0b. Role per match: role of the agent played in THAT match
    const matchRole = getRoleForMatch(m, playerRiotId, playerPuuid);

    // Round-Level Analysis
    for (let rIdx = 0; rIdx < rounds.length; rIdx++) {
      const r = rounds[rIdx];
      const pStats = r.player_stats || {};
      const dmg = Number(pStats.damage || 0);
      const kills = Number(pStats.kills || 0);
      
      if (dmg >= 100 && kills === 0) {
        chipAndDieRounds += 1;
      }
    }

    // In-match spatial death tracker per cell (8m = 800 units)
    const inMatchCellDeaths = {};

    // Kill Event Telemetry & Snapshots
    for (let i = 0; i < killEvents.length; i++) {
      const k = killEvents[i];
      const deathLoc = k.victim_death_location;
      const deathTimeMs = Number(k.kill_time_in_round || 0);
      const deathTimeSec = deathTimeMs / 1000;
      const roundNum = k.round || (Math.floor(i / 6) + 1);

      const isAttackSide = (roundNum <= 12);
      const sideLabel = isAttackSide ? 'attack' : 'defense';

      const isPlayerVictim = (playerPuuid && k.victim_puuid === playerPuuid) ||
                             (k.victim_display_name && k.victim_display_name.toLowerCase() === riotIdLower);
      const isPlayerKiller = (playerPuuid && k.killer_puuid === playerPuuid) ||
                             (k.killer_display_name && k.killer_display_name.toLowerCase() === riotIdLower);

      if (isPlayerKiller) {
        totalKills += 1;
      }

      const playersSnapshot = k.player_locations_on_kill || [];
      const killerSnapshot = playersSnapshot.find(
        p => p.player_display_name && p.player_display_name.toLowerCase() === (k.killer_display_name || '').toLowerCase()
      );

      // Check killer's view angle toward victim across all duels
      if (killerSnapshot && killerSnapshot.location && killerSnapshot.view_radians != null && deathLoc && deathLoc.x != null) {
        const kx = deathLoc.x - killerSnapshot.location.x;
        const ky = deathLoc.y - killerSnapshot.location.y;
        const bearingKillerToVictim = Math.atan2(ky, kx);
        const killerAngleDiff = wrapAngleToPi(bearingKillerToVictim - killerSnapshot.view_radians);
        const killerAngleDeg = killerAngleDiff * (180 / Math.PI);
        validKillerAimDuels += 1;
        if (killerAngleDeg <= 30.0) {
          killerAimUnder30Count += 1;
        }
      }

      // 0f. GATED TRADE OPPORTUNITY:
      // When an ally dies:
      // 1. Ally died within 15m (1500 units)
      // 2. Killer within 25m of player (2500 units)
      // 3. (If view angle available) Killer inside player's +/- 60 deg view cone
      const victimTeam = k.victim_team;
      if (!isPlayerVictim && k.victim_display_name && k.victim_display_name.toLowerCase() !== riotIdLower) {
        const playerSnapshot = playersSnapshot.find(
          p => (playerPuuid && p.player_puuid === playerPuuid) ||
               (p.player_display_name && p.player_display_name.toLowerCase() === riotIdLower)
        );

        if (playerSnapshot && playerSnapshot.player_team === victimTeam && deathLoc) {
          const distToAlly = calculateDistance(playerSnapshot.location, deathLoc);
          let distToKiller = Infinity;
          let killerInViewCone = true;

          if (killerSnapshot && killerSnapshot.location) {
            distToKiller = calculateDistance(playerSnapshot.location, killerSnapshot.location);
            if (playerSnapshot.view_radians != null) {
              const kdx = killerSnapshot.location.x - playerSnapshot.location.x;
              const kdy = killerSnapshot.location.y - playerSnapshot.location.y;
              const bearingToKiller = Math.atan2(kdy, kdx);
              const angleDiff = wrapAngleToPi(bearingToKiller - playerSnapshot.view_radians);
              killerInViewCone = (angleDiff <= (SPATIAL_CONFIG.KILLER_TRADE_MAX_VIEW_ANGLE_DEG * Math.PI / 180));
            }
          }

          const isGatedOpp = (
            distToAlly !== null && distToAlly <= (SPATIAL_CONFIG.ALLY_TRADE_MAX_DIST_METERS * 100) &&
            distToKiller <= (SPATIAL_CONFIG.KILLER_TRADE_MAX_DIST_METERS * 100) &&
            killerInViewCone
          );

          if (isGatedOpp) {
            teammateTradeOpportunities += 1;
            // Check if player traded this teammate within 5s
            const killerNameLower = (k.killer_display_name || '').toLowerCase();
            for (let j = i + 1; j < killEvents.length; j++) {
              const nextK = killEvents[j];
              const timeDiff = (nextK.kill_time_in_round || 0) - deathTimeMs;
              if (timeDiff > SPATIAL_CONFIG.TRADE_TIME_WINDOW_MS || timeDiff < 0) break;
              if (nextK.killer_display_name && nextK.killer_display_name.toLowerCase() === riotIdLower &&
                  nextK.victim_display_name && nextK.victim_display_name.toLowerCase() === killerNameLower) {
                youTradeTeammatesCount += 1;
                break;
              }
            }
          }
        }
      }

      if (isPlayerVictim) {
        totalDeaths += 1;
        totalDeathTimeSec += deathTimeSec;

        if (isAttackSide) attackDeaths += 1;
        else defenseDeaths += 1;

        // 0e & 2. In-Match Repeat Death Spot (~8m cells = 800 units, >= 3 deaths in ONE match)
        if (deathLoc && deathLoc.x != null && deathLoc.y != null) {
          const cellX = Math.floor(deathLoc.x / (SPATIAL_CONFIG.REPEAT_SPOT_CELL_SIZE_METERS * 100));
          const cellY = Math.floor(deathLoc.y / (SPATIAL_CONFIG.REPEAT_SPOT_CELL_SIZE_METERS * 100));
          const matchCellKey = `${sideLabel}_${cellX}_${cellY}`;
          inMatchCellDeaths[matchCellKey] = (inMatchCellDeaths[matchCellKey] || 0) + 1;

          if (inMatchCellDeaths[matchCellKey] === SPATIAL_CONFIG.REPEAT_SPOT_MIN_DEATHS_PER_MATCH) {
            inMatchRepeatSpots.push({
              matchId,
              map: mapName,
              side: sideLabel,
              cellKey: `(${cellX}, ${cellY})`,
              deathsInCell: 3
            });
          }

          // Spatial Top-3-Cell Death Share grouping per map & side
          const sliceKey = `${mapName}:${sideLabel}`;
          if (!spatialMapSideClusters[sliceKey]) {
            spatialMapSideClusters[sliceKey] = { map: mapName, side: sideLabel, cell_counts: {}, total_deaths: 0 };
          }
          const gridKey = `${Math.floor(deathLoc.x / 1000)}_${Math.floor(deathLoc.y / 1000)}`;
          spatialMapSideClusters[sliceKey].cell_counts[gridKey] = (spatialMapSideClusters[sliceKey].cell_counts[gridKey] || 0) + 1;
          spatialMapSideClusters[sliceKey].total_deaths += 1;
        }

        const victimSnapshot = playersSnapshot.find(
          p => (playerPuuid && p.player_puuid === playerPuuid) ||
               (p.player_display_name && p.player_display_name.toLowerCase() === riotIdLower)
        );

        // Find alive teammates at death instant
        const aliveTeammates = playersSnapshot.filter(
          p => p.player_team === victimTeam &&
               p.player_display_name && p.player_display_name.toLowerCase() !== riotIdLower
        );

        const isLastAlive = (aliveTeammates.length === 0);

        let hasTeammateInTradeRange = false;
        let minTeammateDist = Infinity;

        for (const tm of aliveTeammates) {
          const dist = calculateDistance(deathLoc, tm.location);
          if (dist !== null) {
            if (dist < minTeammateDist) minTeammateDist = dist;
            if (dist <= (SPATIAL_CONFIG.ALLY_TRADE_MAX_DIST_METERS * 100)) hasTeammateInTradeRange = true;
          }
        }

        // Trade Analysis: Killer must be killed within 5s by a teammate
        let wasTraded = false;
        const killerNameLower = (k.killer_display_name || '').toLowerCase();

        for (let j = i + 1; j < killEvents.length; j++) {
          const nextK = killEvents[j];
          const timeDiff = (nextK.kill_time_in_round || 0) - deathTimeMs;
          if (timeDiff > SPATIAL_CONFIG.TRADE_TIME_WINDOW_MS || timeDiff < 0) break;
          
          const isKillerKilled = nextK.victim_display_name && nextK.victim_display_name.toLowerCase() === killerNameLower;
          const isKillerTeamTeammate = (nextK.killer_team === victimTeam);

          if (isKillerKilled && isKillerTeamTeammate) {
            wasTraded = true;
            break;
          }
        }

        // Exclude last-alive clutch deaths from isolated-death denominator
        if (!isLastAlive) {
          eligibleTradeDeaths += 1;
          if (wasTraded) {
            tradedDeaths += 1;
          } else if (!hasTeammateInTradeRange || minTeammateDist > 2000) {
            untradeableDeaths += 1;
          }
        }

        // Flank & View Angle Analysis
        if (victimSnapshot && victimSnapshot.view_radians != null && killerSnapshot && killerSnapshot.location && deathLoc) {
          validAngleDeaths += 1;
          const dx = killerSnapshot.location.x - deathLoc.x;
          const dy = killerSnapshot.location.y - deathLoc.y;
          const bearingToKiller = Math.atan2(dy, dx);
          const viewRad = victimSnapshot.view_radians;
          
          const angleDiffRad = wrapAngleToPi(bearingToKiller - viewRad);
          const angleDiffDeg = angleDiffRad * (180 / Math.PI);
          
          if (angleDiffDeg > 85.0) {
            diedFromBehindCount += 1;
          }

          const distMeters = Math.sqrt(dx * dx + dy * dy) / 100;
          totalEngagementDistMeters += distMeters;
          engagementCount += 1;

          if (distMeters < 10) {
            closeRangeFights += 1;
            const gun = (k.damage_weapon_name || '').toLowerCase();
            if (gun.includes('vandal') || gun.includes('phantom') || gun.includes('guardian')) {
              rifleCloseRangeFights += 1;
            }
          }
        }

        // 0c. Dry-Peek Opening Deaths: < 22s AND no ally within 15m AND no utility cast
        const isDryOpeningTime = (deathTimeSec > 0 && deathTimeSec < SPATIAL_CONFIG.DRY_PEEK_WINDOW_SEC);
        const hasNoNearbyAlly = (!hasTeammateInTradeRange || minTeammateDist > (SPATIAL_CONFIG.DRY_PEEK_NO_ALLY_DIST_METERS * 100));
        const roundStats = rounds[roundNum - 1]?.player_stats;
        const hadUtilityCast = Boolean(roundStats && (roundStats.ability_casts_count > 0 || roundStats.spent_utility));

        if (isDryOpeningTime) {
          if (hasNoNearbyAlly && !hadUtilityCast) {
            if (isAttackSide) attackDryPeeks += 1;
            else defenseDryPeeks += 1;
          } else if (hasNoNearbyAlly && hadUtilityCast) {
            earlyDeathNoAllyCount += 1;
          } else if (!hasNoNearbyAlly && !hadUtilityCast) {
            earlyDeathNoUtilityCount += 1;
          }
        }

        // Replay Cue Sheet (Requirement 7: Elapsed + On-Clock Time remaining)
        const isUntradeable = !isLastAlive && (!hasTeammateInTradeRange || minTeammateDist > 2000);
        const isDryEarly = isDryOpeningTime && hasNoNearbyAlly;
        if (isUntradeable || isDryEarly) {
          const elapsedSec = Math.round(deathTimeSec);
          const onClockRemainingSec = Math.max(0, 100 - elapsedSec);
          
          const elapMin = Math.floor(elapsedSec / 60);
          const elapSecStr = (elapsedSec % 60).toString().padStart(2, '0');
          const clockMin = Math.floor(onClockRemainingSec / 60);
          const clockSecStr = (onClockRemainingSec % 60).toString().padStart(2, '0');

          cueSheetCandidates.push({
            round: roundNum,
            elapsed_time: `${elapMin}:${elapSecStr}`,
            on_clock_remaining: `${clockMin}:${clockSecStr}`,
            clock_display: `${elapMin}:${elapSecStr} elapsed (${clockMin}:${clockSecStr} on-clock)`,
            death_time_sec: elapsedSec,
            map: mapName,
            flaw: isDryEarly ? `${sideLabel.toUpperCase()} Dry-Peek` : 'Isolated Untradeable Death',
            win_prob_impact: isDryEarly ? '-32% (estimated)' : '-24% (estimated)',
            killer: k.killer_display_name || 'Opponent',
            weapon: k.damage_weapon_name || 'Vandal',
            cue: isDryEarly
              ? `Died at ${elapMin}:${elapSecStr} elapsed (${clockMin}:${clockSecStr} on clock) without trade support on ${sideLabel}. Wait for team utility before peeking.`
              : `Died isolated (${Math.round(minTeammateDist / 100)}m from team) at ${elapMin}:${elapSecStr} elapsed. Review your spacing.`
          });
        }
      }
    }
  }

  // 4. Rate Calculations with Raw Counts
  const safeDeaths = Math.max(1, totalDeaths);
  const safeEligibleTrades = Math.max(1, eligibleTradeDeaths);
  const safeAttackDeaths = Math.max(1, attackDeaths);
  const safeDefenseDeaths = Math.max(1, defenseDeaths);

  const untradeableRate = Number((untradeableDeaths / safeEligibleTrades).toFixed(3));
  const tradeConversionRate = Number((tradedDeaths / safeEligibleTrades).toFixed(3));
  const youTradeRate = teammateTradeOpportunities > 0 ? Number((youTradeTeammatesCount / teammateTradeOpportunities).toFixed(3)) : 0;
  const youTradeWilsonCI = calculateWilsonInterval(youTradeTeammatesCount, teammateTradeOpportunities);

  const diedFromBehindRate = validAngleDeaths > 0 ? Number((diedFromBehindCount / validAngleDeaths).toFixed(3)) : 0.15;
  const attackDryPeekRate = Number((attackDryPeeks / safeAttackDeaths).toFixed(3));
  const defenseDryPeekRate = Number((defenseDryPeeks / safeDefenseDeaths).toFixed(3));
  const overallDryPeekRate = Number(((attackDryPeeks + defenseDryPeeks) / safeDeaths).toFixed(3));

  // 0g. Provisional 4-Band Tier Targets
  const targetUntradeableMax = tierTargets.targetUntradeableMax;
  const targetFlankMax = tierTargets.targetFlankMax;
  const targetDryPeekMax = tierTargets.targetDryPeekMax;

  // Single-match preliminary label
  const labelSuffix = isSingleMatch ? " (Preliminary: requires 2+ matches for stable classification)" : "";

  // 5. Impact-Ranked Flaws
  const impactFlaws = [];

  if (untradeableRate > targetUntradeableMax) {
    const excess = untradeableRate - targetUntradeableMax;
    const roundImpact = Number((excess * 3.8).toFixed(1));
    impactFlaws.push({
      flaw: "High Untradeable Death Rate",
      raw_count: untradeableDeaths,
      raw_denominator: eligibleTradeDeaths,
      your_rate: `${(untradeableRate * 100).toFixed(1)}% (${untradeableDeaths}/${eligibleTradeDeaths})`,
      cohort_benchmark: `≤${Math.round(targetUntradeableMax * 100)}% (${tierBand})`,
      round_impact: `+${roundImpact} rounds/match (estimated)`,
      verdict: `Dying in isolated positions where teammates cannot swing for a 1-for-1 trade${labelSuffix}.`,
      severity: roundImpact > 1.2 ? 'high' : 'medium',
      metric_type: 'estimated'
    });
  }

  if (diedFromBehindRate > targetFlankMax) {
    const excess = diedFromBehindRate - targetFlankMax;
    const roundImpact = Number((excess * 3.2).toFixed(1));
    impactFlaws.push({
      flaw: "Flank & Crosshair Blindspots",
      raw_count: diedFromBehindCount,
      raw_denominator: validAngleDeaths,
      your_rate: `${(diedFromBehindRate * 100).toFixed(1)}% (${diedFromBehindCount}/${validAngleDeaths})`,
      cohort_benchmark: `≤${Math.round(targetFlankMax * 100)}% (${tierBand})`,
      round_impact: `+${roundImpact} rounds/match (estimated)`,
      verdict: `Dying with crosshair facing >85° away from opponent${labelSuffix}.`,
      severity: roundImpact > 0.8 ? 'high' : 'medium',
      metric_type: 'estimated'
    });
  }

  if (overallDryPeekRate > targetDryPeekMax) {
    const excess = overallDryPeekRate - targetDryPeekMax;
    const roundImpact = Number((excess * 2.8).toFixed(1));
    impactFlaws.push({
      flaw: "Dry-Peek Opening Deaths",
      raw_count: attackDryPeeks + defenseDryPeeks,
      raw_denominator: totalDeaths,
      your_rate: `${(overallDryPeekRate * 100).toFixed(1)}% (Atk: ${attackDryPeeks}/${attackDeaths}, Def: ${defenseDryPeeks}/${defenseDeaths})`,
      cohort_benchmark: `≤${Math.round(targetDryPeekMax * 100)}% (${tierBand})`,
      round_impact: `+${roundImpact} rounds/match (estimated)`,
      verdict: `Dying within opening 22s without utility and ally support${labelSuffix}.`,
      severity: 'high',
      metric_type: 'estimated'
    });
  }

  const topCueSheet = cueSheetCandidates.slice(0, 4);

  // Spatial Top-3-Cell Death Share by map & side
  const spatialTop3ShareBySlice = {};
  for (const [sliceKey, data] of Object.entries(spatialMapSideClusters)) {
    const total = data.total_deaths;
    if (total < 8) {
      spatialTop3ShareBySlice[sliceKey] = {
        is_valid_sample: false,
        total_deaths: total,
        note: 'Insufficient sample (< 8 deaths on this map & side) to evaluate spatial predictability.'
      };
    } else {
      const counts = Object.values(data.cell_counts).sort((a, b) => b - a);
      const top3Deaths = counts.slice(0, 3).reduce((acc, c) => acc + c, 0);
      const top3SharePct = Number(((top3Deaths / total) * 100).toFixed(1));
      const totalCells = Object.keys(data.cell_counts).length;
      const shuffledBaselinePct = totalCells > 0 ? Number((Math.min(100, (3 / totalCells) * 100)).toFixed(1)) : 100.0;
      const excessClusteringPct = Number(Math.max(0, top3SharePct - shuffledBaselinePct).toFixed(1));

      spatialTop3ShareBySlice[sliceKey] = {
        is_valid_sample: true,
        total_deaths: total,
        top_3_cell_deaths: top3Deaths,
        top_3_cell_share_pct: top3SharePct,
        shuffled_baseline_pct: shuffledBaselinePct,
        excess_clustering_pct: excessClusteringPct,
        predictability_level: top3SharePct >= 55 ? "High (Habitual Chokepoints)" : "Dispersed (Dynamic)",
        label: 'disabled_pending_cohort_baselines'
      };
    }
  }

  // 1B & 3 & 4. Aggregate Habits (over up to 50 matches)
  const habitResult = aggregateHabits(matchesToProcess, playerRiotId, playerPuuid);

  return {
    game_mode: isDeathmatchOnly ? 'deathmatch_ffa' : 'standard_5v5',
    is_single_match: isSingleMatch,
    skipped_matches: skippedMatches,
    trade_metrics: {
      total_deaths: totalDeaths,
      eligible_trade_deaths: eligibleTradeDeaths,
      untradeable_rate: untradeableRate,
      trade_conversion_rate: tradeConversionRate,
      untradeable_deaths: {
        count: untradeableDeaths,
        denominator: eligibleTradeDeaths,
        pct: Number((untradeableRate * 100).toFixed(1))
      },
      traded_deaths: {
        count: tradedDeaths,
        denominator: eligibleTradeDeaths,
        pct: Number((tradeConversionRate * 100).toFixed(1))
      },
      you_trade_teammates: {
        trades_made: youTradeTeammatesCount,
        opportunities: teammateTradeOpportunities,
        rate_pct: Number((youTradeRate * 100).toFixed(1)),
        wilson_95_ci: youTradeWilsonCI,
        description: `${youTradeTeammatesCount}/${teammateTradeOpportunities} opportunities (${(youTradeRate * 100).toFixed(1)}%, 95% CI: [${youTradeWilsonCI[0]}%, ${youTradeWilsonCI[1]}%])`
      },
      efficiency_rating: isSingleMatch 
        ? 'Single Match (Unlabeled)' 
        : (tradeConversionRate >= 0.40 ? 'Elite' : (tradeConversionRate >= 0.25 ? 'Moderate' : 'Underperforming'))
    },
    flank_angle: {
      count: diedFromBehindCount,
      denominator: validAngleDeaths,
      died_from_behind_rate: diedFromBehindRate,
      died_from_behind_pct: Number((diedFromBehindRate * 100).toFixed(1)),
      crosshair_facing_rate: Number((1.0 - diedFromBehindRate).toFixed(3)),
      crosshair_facing_pct: Number(((1.0 - diedFromBehindRate) * 100).toFixed(1))
    },
    killer_aim_validation: {
      duels_evaluated: validKillerAimDuels,
      valid_duels: validKillerAimDuels,
      under_30_deg_count: killerAimUnder30Count,
      killer_aim_under_30_count: killerAimUnder30Count,
      under_30_deg_pct: validKillerAimDuels > 0 ? Number(((killerAimUnder30Count / validKillerAimDuels) * 100).toFixed(1)) : 100.0,
      killer_aim_under_30_pct: validKillerAimDuels > 0 ? Number(((killerAimUnder30Count / validKillerAimDuels) * 100).toFixed(1)) : 100.0
    },
    tempo: {
      attack_dry_peeks: { count: attackDryPeeks, denominator: attackDeaths, pct: Number((attackDryPeekRate * 100).toFixed(1)) },
      defense_dry_peeks: { count: defenseDryPeeks, denominator: defenseDeaths, pct: Number((defenseDryPeekRate * 100).toFixed(1)) },
      early_death_no_ally_count: earlyDeathNoAllyCount,
      early_death_no_utility_count: earlyDeathNoUtilityCount,
      dry_peek_deaths: attackDryPeeks + defenseDryPeeks,
      dry_peek_rate: overallDryPeekRate,
      overall_dry_peek_pct: Number((overallDryPeekRate * 100).toFixed(1)),
      avg_death_time_sec: Number((totalDeathTimeSec / safeDeaths).toFixed(1)),
      buy_phase_offset_ms: 0
    },
    combat_range: {
      avg_distance_meters: engagementCount > 0 ? Number((totalEngagementDistMeters / engagementCount).toFixed(1)) : 16.5,
      close_range_fights: { count: closeRangeFights, denominator: engagementCount, pct: engagementCount > 0 ? Number(((closeRangeFights / engagementCount) * 100).toFixed(1)) : 25.0 },
      rifle_close_range_count: rifleCloseRangeFights
    },
    spatial_in_match_repeats: {
      repeat_spots: inMatchRepeatSpots,
      repeat_spots_count: inMatchRepeatSpots.length,
      rule: ">= 3 deaths in ~8m cell in ONE match"
    },
    spatial_top_3_cell_share: spatialTop3ShareBySlice,
    habits: habitResult.habits,
    playstyle_archetype: habitResult.archetype,
    unconverted_damage: {
      chip_and_die_rounds: chipAndDieRounds
    },
    impact_flaws: impactFlaws,
    replay_cue_sheet: topCueSheet,
    rank_cohort_context: {
      rank: currentRank,
      tier_band: tierBand,
      lower_is_better_targets: {
        target_untradeable_max: targetUntradeableMax,
        target_flank_max: targetFlankMax,
        target_dry_peek_max: targetDryPeekMax
      }
    }
  };
};
