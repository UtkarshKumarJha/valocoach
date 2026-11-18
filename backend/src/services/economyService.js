/**
 * Economy Discipline & Buy Habits Analysis Service
 * Conforms to Step 5 requirements:
 * - Map per-round economy (loadout_value, remaining, armor, weapon)
 * - Classify team round type from team average loadout value: pistol, eco, force, full
 * - 4 Metrics with n, rate, Wilson CI and peer baseline:
 *     1. hero buy (full-buying when team is eco/force)
 *     2. bank hoard (under-buying when team full-buys while holding credits)
 *     3. forced-buy-after-loss rate
 *     4. pistol-round buy (armor+utility vs save)
 * - If data is missing or n < 15 rounds: render "No economy data"
 * - NEVER a grade or praise (removed letter grade & static copy)
 */

const { computeWilsonCI, computeWilsonBoundsNumeric } = require('./habitAggregator');

const LOADOUT_THRESHOLDS = {
  ECO_MAX: 2500,
  FORCE_MAX: 3900,
  FULL_MIN: 3900
};

/**
 * Classifies team buy round type based on team average loadout value.
 */
function classifyTeamRound(roundNum, teamAvgLoadout) {
  if (roundNum === 1 || roundNum === 13) {
    return 'pistol';
  }
  if (teamAvgLoadout < LOADOUT_THRESHOLDS.ECO_MAX) {
    return 'eco';
  }
  if (teamAvgLoadout < LOADOUT_THRESHOLDS.FORCE_MAX) {
    return 'force';
  }
  return 'full';
}

/**
 * Analyzes economy across matches for target player and all peers.
 */
function analyzeEconomy(matches, targetRiotId, targetPuuid) {
  if (!matches || !matches.length) {
    return {
      has_data: false,
      reason: 'No economy data'
    };
  }

  const riotIdLower = (targetRiotId || '').toLowerCase().trim();

  let totalRoundsAnalyzed = 0;

  // Player metric tallies
  const playerMetrics = {
    hero_buy: { k: 0, n: 0 },
    bank_hoard: { k: 0, n: 0 },
    forced_buy_after_loss: { k: 0, n: 0 },
    pistol_round_buy: { k: 0, n: 0 }
  };

  // Peer metric tallies (pooled across the other 9 players)
  const peerMetrics = {
    hero_buy: { k: 0, n: 0 },
    bank_hoard: { k: 0, n: 0 },
    forced_buy_after_loss: { k: 0, n: 0 },
    pistol_round_buy: { k: 0, n: 0 }
  };

  for (const m of matches) {
    const rounds = m.rounds || [];
    if (!rounds.length) continue;

    // Track previous round outcomes per team for forced-buy-after-loss
    let prevRoundWinner = null;

    for (let rIdx = 0; rIdx < rounds.length; rIdx++) {
      const r = rounds[rIdx];
      const roundNum = r.round_num || (rIdx + 1);
      const rawStats = Array.isArray(r.player_stats) ? r.player_stats : (Array.isArray(r.all_player_stats) ? r.all_player_stats : []);

      if (!rawStats.length) continue;

      // Group player stats by team
      const teamStats = {};
      rawStats.forEach(ps => {
        const team = ps.player_team || ps.team || (ps.player ? ps.player.team : 'Unknown');
        if (!teamStats[team]) teamStats[team] = [];
        teamStats[team].push(ps);
      });

      // Calculate team average loadout value
      const teamAverages = {};
      for (const [team, pList] of Object.entries(teamStats)) {
        const sum = pList.reduce((acc, p) => acc + Number(p.economy?.loadout_value || p.loadout_value || 0), 0);
        teamAverages[team] = pList.length > 0 ? (sum / pList.length) : 0;
      }

      // Check each player in this round
      for (const ps of rawStats) {
        const isTarget = (targetPuuid && ps.player_puuid === targetPuuid) ||
                         (ps.player_display_name && ps.player_display_name.toLowerCase() === riotIdLower);
        
        const metricsObj = isTarget ? playerMetrics : peerMetrics;
        if (isTarget) totalRoundsAnalyzed += 1;

        const pTeam = ps.player_team || ps.team || (ps.player ? ps.player.team : 'Unknown');
        const teamAvgLoadout = teamAverages[pTeam] || 0;
        const teamRoundType = classifyTeamRound(roundNum, teamAvgLoadout);

        const eco = ps.economy || {};
        const loadoutVal = Number(eco.loadout_value || 0);
        const remainingCredits = Number(eco.remaining || 0);
        const weaponName = eco.weapon?.name || (typeof eco.weapon === 'string' ? eco.weapon : '');
        const hasArmor = Boolean(eco.armor);

        // 1. Hero Buy: full-buying (loadout >= 3900) when team is eco or force (teamAvg < 3900, not pistol)
        if (teamRoundType === 'eco' || teamRoundType === 'force') {
          metricsObj.hero_buy.n += 1;
          if (loadoutVal >= LOADOUT_THRESHOLDS.FULL_MIN) {
            metricsObj.hero_buy.k += 1;
          }
        }

        // 2. Bank Hoard: under-buying (< 2900) when team full-buys (teamAvg >= 3900) while holding credits (remaining >= 2000)
        if (teamRoundType === 'full') {
          metricsObj.bank_hoard.n += 1;
          if (loadoutVal < 2900 && remainingCredits >= 2000) {
            metricsObj.bank_hoard.k += 1;
          }
        }

        // 3. Forced-Buy-After-Loss:
        // Round following a round loss (not pistol rounds 1 or 13, and must have a previous round)
        if (roundNum !== 1 && roundNum !== 13 && prevRoundWinner !== null) {
          const teamLostPrevRound = prevRoundWinner !== pTeam;
          if (teamLostPrevRound) {
            metricsObj.forced_buy_after_loss.n += 1;
            if (loadoutVal >= LOADOUT_THRESHOLDS.ECO_MAX) {
              metricsObj.forced_buy_after_loss.k += 1;
            }
          }
        }

        // 4. Pistol-Round Buy:
        // Pistol rounds 1 and 13: did player buy (armor or secondary/utility) vs save
        if (teamRoundType === 'pistol') {
          metricsObj.pistol_round_buy.n += 1;
          const boughtSomething = hasArmor || (weaponName && weaponName.toLowerCase() !== 'classic') || (remainingCredits < 800) || (loadoutVal > 800);
          if (boughtSomething) {
            metricsObj.pistol_round_buy.k += 1;
          }
        }
      }

      // Update prevRoundWinner for next round
      prevRoundWinner = r.winning_team || null;
    }
  }

  // Guard: if data is missing or n < 15 rounds: render "No economy data"
  if (totalRoundsAnalyzed < 15) {
    return {
      has_data: false,
      total_rounds_analyzed: totalRoundsAnalyzed,
      reason: 'No economy data (minimum 15 rounds required)'
    };
  }

  // Build metric objects with n, rate, Wilson CI and peer baseline
  const formatMetric = (pMet, peerMet) => {
    const rate = pMet.n > 0 ? Number((pMet.k / pMet.n).toFixed(4)) : 0;
    const ratePct = Number((rate * 100).toFixed(1));
    const ci = computeWilsonCI(pMet.k, pMet.n);

    const peerRate = peerMet.n > 0 ? Number((peerMet.k / peerMet.n).toFixed(4)) : null;
    const peerRatePct = peerRate !== null ? Number((peerRate * 100).toFixed(1)) : null;
    const peerCi = peerMet.n > 0 ? computeWilsonCI(peerMet.k, peerMet.n) : null;

    return {
      k: pMet.k,
      n: pMet.n,
      rate,
      rate_pct: ratePct,
      ci,
      peer_baseline: {
        k: peerMet.k,
        n: peerMet.n,
        p0: peerRate,
        p0_pct: peerRatePct,
        ci: peerCi
      }
    };
  };

  const heroBuy = formatMetric(playerMetrics.hero_buy, peerMetrics.hero_buy);
  const bankHoard = formatMetric(playerMetrics.bank_hoard, peerMetrics.bank_hoard);
  const forcedBuyAfterLoss = formatMetric(playerMetrics.forced_buy_after_loss, peerMetrics.forced_buy_after_loss);
  const pistolBuy = formatMetric(playerMetrics.pistol_round_buy, peerMetrics.pistol_round_buy);

  // Plain-language text built ONLY from computed values; a metric under 15 rounds says so instead of a rate
  const MIN_N = 15;
  const describe = (m, label, what) => {
    m.label = label;
    m.enough_data = m.n >= MIN_N;
    m.plain = m.enough_data
      ? `${what}: ${m.k} of ${m.n} rounds (${m.rate_pct}%)${m.peer_baseline.p0_pct != null ? `, players in your lobbies ${m.peer_baseline.p0_pct}%` : ''}.`
      : `${what}: not enough rounds yet (${m.n} of ${MIN_N}).`;
    return m.plain;
  };
  const findings = [
    describe(heroBuy, 'Full buy while team saves', 'You bought a full loadout while your team was on an eco or force'),
    describe(bankHoard, 'Under-buy on team full buy', 'You under-bought while holding credits when your team full-bought'),
    describe(forcedBuyAfterLoss, 'Buy after a lost round', 'You bought (force or better) right after a lost round'),
    describe(pistolBuy, 'Pistol round buy', 'You bought armor or utility on pistol rounds')
  ];

  return {
    has_data: true,
    total_rounds_analyzed: totalRoundsAnalyzed,
    metrics: {
      hero_buy: heroBuy,
      bank_hoard: bankHoard,
      forced_buy_after_loss: forcedBuyAfterLoss,
      pistol_round_buy: pistolBuy
    },
    factual_summary: findings.join(' ')
  };
}

module.exports = {
  classifyTeamRound,
  analyzeEconomy
};
