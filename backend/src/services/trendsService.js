/**
 * Trends & Session Fatigue Service
 * Conforms to Step 6 requirements:
 * - Per-match ACS and K/D line with 10-match moving average
 * - Habit trend for a key habit: older half vs newer half of matches, with Wilson CIs
 * - Empty state if < 20 matches
 * - Session fatigue: claim "decay" or "no decay" only after a test with CI (min 10 sessions of 3+ games), else "not enough data"
 */

const { computeWilsonCI, tallyPlayerMatch } = require('./habitAggregator');
const { getRoleForMatch } = require('./agentRoleService');

/**
 * Computes per-match ACS and K/D time series with 10-match moving averages.
 */
function computeMatchTrends(matches, targetRiotId, targetPuuid, keyHabitCell = null) {
  if (!matches || matches.length < 20) {
    return {
      has_sufficient_data: false,
      reason: 'Insufficient match sample (< 20 matches) to compute moving average trends.',
      matches_count: matches ? matches.length : 0
    };
  }

  const riotIdLower = (targetRiotId || '').toLowerCase().trim();

  // Sort chronological (oldest to newest)
  const sorted = [...matches].sort((a, b) => {
    const timeA = new Date(a.playedAt || a.metadata?.game_start || 0).getTime();
    const timeB = new Date(b.playedAt || b.metadata?.game_start || 0).getTime();
    return timeA - timeB;
  });

  const series = [];
  const acsHistory = [];
  const kdHistory = [];

  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    let acs = m.acs || 0;
    let kills = m.kills || 0;
    let deaths = m.deaths || 0;

    // If not on top-level match object, extract from all_players
    if (m.all_players) {
      const p = m.all_players.find(pl => 
        (targetPuuid && pl.puuid === targetPuuid) ||
        (`${pl.name}#${pl.tag}`.toLowerCase() === riotIdLower) ||
        (pl.name?.toLowerCase() === riotIdLower)
      );
      if (p) {
        // stats.score is the match total; ACS is per round
        const roundsPlayed = (m.rounds || []).length;
        if (p.stats?.score != null && roundsPlayed > 0) acs = Math.round(p.stats.score / roundsPlayed);
        kills = p.stats?.kills || kills;
        deaths = p.stats?.deaths || deaths;
      }
    }

    const kd = deaths > 0 ? Number((kills / deaths).toFixed(2)) : kills;
    acsHistory.push(acs);
    kdHistory.push(kd);

    // Compute 10-match moving average
    const startIdx = Math.max(0, i - 9);
    const windowAcs = acsHistory.slice(startIdx, i + 1);
    const windowKd = kdHistory.slice(startIdx, i + 1);

    const maAcs = Math.round(windowAcs.reduce((a, b) => a + b, 0) / windowAcs.length);
    const maKd = Number((windowKd.reduce((a, b) => a + b, 0) / windowKd.length).toFixed(2));

    series.push({
      match_index: i + 1,
      matchId: m.matchId || `match_${i + 1}`,
      map: m.map || 'Unknown',
      acs,
      kd,
      acs_ma10: maAcs,
      kd_ma10: maKd
    });
  }

  // Key Habit Trend (Older half vs Newer half of matches)
  const halfSize = Math.floor(sorted.length / 2);
  const olderMatches = sorted.slice(0, halfSize);
  const newerMatches = sorted.slice(halfSize);

  return {
    has_sufficient_data: true,
    matches_count: sorted.length,
    series,
    older_half_count: olderMatches.length,
    newer_half_count: newerMatches.length,
    habit_trend: keyHabitCell ? habitTrend(olderMatches, newerMatches, targetRiotId, targetPuuid, keyHabitCell) : null
  };
}

/**
 * One habit cell (role_side_TAG), older half vs newer half of matches. Says "changed" only when the 95% CI of
 * the difference in rates excludes 0 (two-proportion normal approximation); otherwise "no clear change".
 */
function habitTrend(older, newer, riotId, puuid, cell) {
  const sum = list => list.reduce((acc, m) => {
    const role = getRoleForMatch(m, riotId, puuid) || 'Flex';
    const c = tallyPlayerMatch(m, puuid, riotId, role).cells[cell];
    return c ? { k: acc.k + c.k, n: acc.n + c.n } : acc;
  }, { k: 0, n: 0 });
  const o = sum(older);
  const w = sum(newer);
  const half = (x, label) => ({ label, k: x.k, n: x.n, rate_pct: x.n ? Number((100 * x.k / x.n).toFixed(1)) : null, ci: computeWilsonCI(x.k, x.n) });
  const out = { cell, older: half(o, 'older half'), newer: half(w, 'newer half') };
  if (o.n < 15 || w.n < 15) return { ...out, verdict: 'not enough data', reason: 'Needs 15+ chances in each half.' };
  const p1 = o.k / o.n, p2 = w.k / w.n;
  const se = Math.sqrt(p1 * (1 - p1) / o.n + p2 * (1 - p2) / w.n);
  const diff = p2 - p1;
  const lo = diff - 1.96 * se, hi = diff + 1.96 * se;
  return {
    ...out,
    diff_pct: Number((100 * diff).toFixed(1)),
    diff_ci_pct: [Number((100 * lo).toFixed(1)), Number((100 * hi).toFixed(1))],
    verdict: lo > 0 ? 'went up' : (hi < 0 ? 'went down' : 'no clear change')
  };
}

/**
 * Evaluates session fatigue with rigorous statistical test and sample guard:
 * Minimum 10 sessions of 3+ games required, else "not enough data".
 */
function evaluateSessionFatigue(matches, targetRiotId, targetPuuid) {
  if (!matches || matches.length < 15) {
    return {
      status: 'not enough data',
      has_sufficient_data: false,
      reason: 'Requires at least 10 sessions of 3+ games (observed: < 15 total games).'
    };
  }

  const riotIdLower = (targetRiotId || '').toLowerCase().trim();

  // Sort chronological
  const sorted = [...matches].sort((a, b) => {
    const timeA = new Date(a.playedAt || a.metadata?.game_start || 0).getTime();
    const timeB = new Date(b.playedAt || b.metadata?.game_start || 0).getTime();
    return timeA - timeB;
  });

  // Group into sessions: gap <= 2 hours (120 mins)
  const sessions = [];
  let currentSession = [];
  let lastTime = null;

  for (const m of sorted) {
    const mTime = new Date(m.playedAt || m.metadata?.game_start || 0).getTime();
    if (lastTime && (mTime - lastTime) > 120 * 60 * 1000) {
      if (currentSession.length > 0) sessions.push(currentSession);
      currentSession = [m];
    } else {
      currentSession.push(m);
    }
    lastTime = mTime;
  }
  if (currentSession.length > 0) sessions.push(currentSession);

  // Filter to qualifying sessions of >= 3 games
  const qualifyingSessions = sessions.filter(s => s.length >= 3);

  // Requirement: Min 10 sessions of 3+ games, else "not enough data"
  if (qualifyingSessions.length < 10) {
    return {
      status: 'not enough data',
      has_sufficient_data: false,
      qualifying_sessions_count: qualifyingSessions.length,
      required_sessions: 10,
      reason: `Requires at least 10 multi-game sessions of 3+ games to test fatigue decay with confidence (observed: ${qualifyingSessions.length} sessions).`
    };
  }

  // Calculate paired differences: Game 1 ACS vs Game 3+ Average ACS for each session
  const diffs = [];
  const g1AcsList = [];
  const g3PlusAcsList = [];

  const getAcs = (m) => {
    if (m.acs) return m.acs;
    if (m.all_players) {
      const p = m.all_players.find(pl => 
        (targetPuuid && pl.puuid === targetPuuid) ||
        (`${pl.name}#${pl.tag}`.toLowerCase() === riotIdLower)
      );
      if (p?.stats?.score) return p.stats.score;
    }
    return 0;
  };

  for (const s of qualifyingSessions) {
    const g1Acs = getAcs(s[0]);
    const g3PlusGames = s.slice(2);
    const g3PlusAvg = g3PlusGames.reduce((acc, m) => acc + getAcs(m), 0) / g3PlusGames.length;

    g1AcsList.push(g1Acs);
    g3PlusAcsList.push(g3PlusAvg);
    diffs.push(g1Acs - g3PlusAvg); // Positive diff means Game 1 was higher (decay)
  }

  const n = diffs.length;
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = diffs.reduce((a, b) => a + Math.pow(b - meanDiff, 2), 0) / (n - 1);
  const stdError = Math.sqrt(variance / n);
  const z = 1.96; // 95% CI
  const ciLower = meanDiff - z * stdError;
  const ciUpper = meanDiff + z * stdError;

  const avgG1 = Math.round(g1AcsList.reduce((a, b) => a + b, 0) / n);
  const avgG3 = Math.round(g3PlusAcsList.reduce((a, b) => a + b, 0) / n);

  // Claim "decay" only if statistically significant decay (ciLower > 0 and meanDiff >= 15 ACS)
  const isDecay = ciLower > 0 && meanDiff >= 15;
  const status = isDecay ? 'decay' : 'no decay';

  return {
    status,
    has_sufficient_data: true,
    qualifying_sessions_count: n,
    game1_mean_acs: avgG1,
    game3_plus_mean_acs: avgG3,
    mean_drop_acs: Number(meanDiff.toFixed(1)),
    ci_95: [Number(ciLower.toFixed(1)), Number(ciUpper.toFixed(1))],
    finding: isDecay
      ? `Statistically significant performance decay detected: Game 3+ drops by an average of ${Math.round(meanDiff)} ACS (95% CI: [${ciLower.toFixed(1)}, ${ciUpper.toFixed(1)}]).`
      : `No significant performance decay detected across ${n} multi-game sessions (95% CI of ACS delta: [${ciLower.toFixed(1)}, ${ciUpper.toFixed(1)}]).`
  };
}

module.exports = {
  computeMatchTrends,
  evaluateSessionFatigue
};
