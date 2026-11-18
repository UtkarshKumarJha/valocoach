// Regression tests for: kills double-counted across rounds, side ignoring team, habits not keyed by role x side.
const { getSideForRound, groupKillsByRound } = require('../src/services/situationDetectors');
const { aggregateHabits } = require('../src/services/habitAggregator');
const fixtures = ['match1', 'match2', 'match3'].map(f => require(`./fixtures/${f}.json`));

describe('getSideForRound', () => {
  test('Red attacks 1-12 and odd OT rounds; Blue is the mirror', () => {
    expect(getSideForRound('Red', 1)).toBe('attack');
    expect(getSideForRound('Red', 12)).toBe('attack');
    expect(getSideForRound('Red', 13)).toBe('defense');
    expect(getSideForRound('Red', 24)).toBe('defense');
    expect(getSideForRound('Red', 25)).toBe('attack');
    expect(getSideForRound('Red', 26)).toBe('defense');
    expect(getSideForRound('Blue', 1)).toBe('defense');
    expect(getSideForRound('Blue', 13)).toBe('attack');
    expect(getSideForRound('Blue', 25)).toBe('defense');
    expect(getSideForRound('blue', 26)).toBe('attack');
  });
  test('Unknown team never guesses a side', () => {
    expect(getSideForRound(null, 3)).toBe('unknown');
    expect(getSideForRound('Neutral', 3)).toBe('unknown');
  });
});

describe('groupKillsByRound', () => {
  test.each(fixtures.map((f, i) => [i + 1, f]))('fixture match%i: every kill lands in exactly one round', (_, f) => {
    const byRound = groupKillsByRound(f.kill_events);
    const total = [...byRound.values()].reduce((a, l) => a + l.length, 0);
    expect(total).toBe(f.kill_events.length);
    expect(Math.min(...byRound.keys())).toBe(1);
    expect(Math.max(...byRound.keys())).toBeLessThanOrEqual(f.rounds.length);
  });
  test('0-based and 1-based payloads map to the same 1-based rounds, sorted by time', () => {
    const zero = [{ round: 0, kill_time_in_round: 9 }, { round: 0, kill_time_in_round: 3 }, { round: 1, kill_time_in_round: 1 }];
    const one = zero.map(k => ({ ...k, round: k.round + 1 }));
    for (const ks of [zero, one]) {
      const g = groupKillsByRound(ks);
      expect([...g.keys()].sort()).toEqual([1, 2]);
      expect(g.get(1).map(k => k.kill_time_in_round)).toEqual([3, 9]);
      expect(g.get(1).every(k => k.round === 1)).toBe(true);
    }
  });
});

describe('aggregateHabits is keyed by role x side and keeps twin invariants', () => {
  const f = fixtures[0];
  const res = aggregateHabits(fixtures, f.player_riot_id, f.player_puuid);

  test('every habit is one detector x role x side cell, with k <= n for twin tags', () => {
    expect(res.habits.length).toBeGreaterThan(0);
    for (const h of res.habits) {
      expect(['attack', 'defense', 'unknown']).toContain(h.side);
      expect(h.cell).toBe(`${h.role}_${h.side}_${h.id}`);
      if (h.n > 0) expect(h.k).toBeLessThanOrEqual(h.n);
    }
    expect(new Set(res.habits.map(h => h.cell)).size).toBe(res.habits.length);
  });

  test('flaw + positive + neutral === opportunities for every twin pair', () => {
    for (const c of Object.values(res.twin_invariants)) {
      expect(c.flaw + c.positive + c.neutral).toBe(c.opportunities);
    }
  });

  test('peer baseline cells use the same role_side_tag key space as the target', () => {
    for (const key of Object.keys(res.peer_baselines)) {
      expect(key).toMatch(/^(Duelist|Initiator|Controller|Sentinel|Flex)_(attack|defense|unknown)_[A-Z_]+$/);
    }
  });

  test('ENTRY opportunities = attack rounds with a kill, played as Duelist/Initiator (bounded by real round count)', () => {
    const attackRounds = res.habits.filter(h => h.id === 'EARLY_DEATH_NO_ALLY' && h.side === 'attack').reduce((a, h) => a + h.n, 0);
    expect(res.twin_invariants.ENTRY.opportunities).toBeLessThanOrEqual(attackRounds);
  });
});

describe('isSupportedQueue allowlist', () => {
  const { isSupportedQueue } = require('../src/config/telemetryConfig');
  test('non-5v5 queues seen in real data are skipped even when the mode name says Competitive', () => {
    expect(isSupportedQueue({ queue: 'skirmish_2v2', mode: 'Competitive', rounds: Array(9) })).toMatchObject({ supported: false, reason: 'unsupported_mode: skirmish_2v2' });
    expect(isSupportedQueue({ queue: 'abilitydraftarena', mode: 'Gauntlet: Glitched', rounds: Array(14) }).supported).toBe(false);
  });
  test('unknown or missing queue is never assumed competitive', () => {
    expect(isSupportedQueue({ rounds: Array(24) })).toMatchObject({ supported: false, reason: 'missing_queue' });
    expect(isSupportedQueue({ queue: 'some_new_mode', rounds: Array(24) }).supported).toBe(false);
  });
});

describe('Detectors never infer from missing data', () => {
  const { detectRoundSituations } = require('../src/services/situationDetectors');
  const earlyDeath = (snapshot) => ({
    round: 1, kill_time_in_round: 14000,
    victim_display_name: 'Me#001', victim_team: 'Red', victim_death_location: { x: 4000, y: 4000 },
    killer_display_name: 'Enemy#001', killer_team: 'Blue', player_locations_on_kill: snapshot
  });
  const far = [{ player_display_name: 'Ally#001', player_team: 'Red', location: { x: 0, y: 0 } }];

  test('v4 rounds (ability_casts all null) never produce DRY_PEEK; no-ally death is EARLY_DEATH_NO_ALLY with utility unknown', () => {
    const sits = detectRoundSituations({
      matchId: 'm', roundNum: 1, side: 'attack', role: 'Duelist', killEvents: [earlyDeath(far)],
      roundStats: { ability_casts: { grenade: null, ability_1: null, ability_2: null, ultimate: null } }, playerRiotId: 'Me#001'
    });
    expect(sits.some(s => s.tag === 'DRY_PEEK' || s.tag === 'EARLY_DEATH_NO_UTILITY')).toBe(false);
    expect(sits.find(s => s.tag === 'EARLY_DEATH_NO_ALLY').evidence.hadUtilityCast).toBeNull();
  });

  test('last alive (no teammate in snapshot): no spacing-based flaw or positive fires', () => {
    const spacingTags = ['ISOLATED_PLAY', 'STAYS_WITH_TEAM', 'SOLO_HOLD_VS_STACK', 'ANCHORED_WITH_SUPPORT', 'DRY_PEEK',
      'EARLY_DEATH_NO_ALLY', 'UNSUPPORTED_ENTRY', 'SUPPORTED_ENTRY', 'UNSYNCED_LURK_DEATH'];
    const enemies = [1, 2, 3].map(i => ({ player_display_name: `E${i}#0`, player_team: 'Blue', location: { x: 4100, y: 4000 + i } }));
    for (const [side, role] of [['attack', 'Initiator'], ['attack', 'Duelist'], ['attack', 'Sentinel'], ['defense', 'Sentinel']]) {
      const sits = detectRoundSituations({ matchId: 'm', roundNum: 1, side, role, killEvents: [earlyDeath(enemies)], roundStats: { ability_casts: 0 }, playerRiotId: 'Me#001' });
      expect(sits.filter(s => spacingTags.includes(s.tag))).toEqual([]);
    }
  });

  test('a planted round without a plant timestamp is not given an invented one', () => {
    const sits = detectRoundSituations({
      matchId: 'm', roundNum: 1, side: 'attack', role: 'Duelist', killEvents: [{ ...earlyDeath(far), kill_time_in_round: 50000 }],
      roundStats: { bomb_planted: true, ability_casts: 0 }, playerRiotId: 'Me#001'
    });
    expect(sits.length).toBeGreaterThan(0); // the 50 s opening-duel loss
    expect(sits.every(s => !/spike/.test(s.clockDisplay))).toBe(true); // old code invented a 45 s plant -> "spike remaining"
  });
});

describe('Narrator validation (evidence-bound)', () => {
  const { _test } = require('../src/services/coachingService');
  const blob = {
    context: { map: 'Corrode' }, total_matches_analyzed: 46,
    habits: [{ id: 'TRADES_WELL', cell: 'Sentinel_attack_TRADES_WELL', title: 'Sharp Revenge Trading', role: 'Sentinel', side: 'attack',
      polarity: 'positive', tier: 'pattern', k: 16, n: 44, ratePct: 36.4, peer_baseline: { p0_pct: 23.6 } }],
    telemetry_intelligence: { replay_cue_sheet: [{ cell: 'Sentinel_attack_TRADES_WELL', round: 3, map: 'Haven', clock_display: '0:40 elapsed (1:00 on-clock)' }] }
  };
  test('keeps text that only cites evidence maps and rounds; English "split" is not a map', () => {
    const ok = 'You traded well in R3 on Haven and split the defense on Corrode.';
    expect(_test.postValidateDebrief(ok, blob)).toBe(ok);
  });
  test('falls back on an unknown map, unknown round, or provider error, in the (a)/(b)/(c) format', () => {
    for (const bad of ['Great play on Bind.', 'Look at round 19.', 'Gemini LLM Provider Error: incomplete response (MAX_TOKENS)']) {
      const out = _test.postValidateDebrief(bad, blob);
      expect(out).toMatch(/### \(a\) What the data shows[\s\S]*### \(b\) Why it matters[\s\S]*### \(c\) Next session/);
      expect(out).toContain('16 of 44');
      expect(out).not.toMatch(/estimated|frequently|often/i);
    }
  });
});
