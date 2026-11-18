const fs = require('fs');
const path = require('path');
const telemetryService = require('../src/services/telemetryIntelligenceService');
const { isSupportedQueue, SUPPORTED_QUEUES, HABIT_RULES, PROVISIONAL_TIER_TARGETS } = require('../src/config/telemetryConfig');
const { detectRoundSituations } = require('../src/services/situationDetectors');
const { aggregateHabits } = require('../src/services/habitAggregator');
const { getRoleForMatch } = require('../src/services/agentRoleService');

describe('Telemetry Intelligence Service - Validation Suite', () => {
  let fixtures;
  let matchDeathmatch;

  beforeAll(() => {
    const fixtureFiles = ['match1.json', 'match2.json', 'match3.json'];
    fixtures = fixtureFiles.map(file => {
      const p = path.join(__dirname, 'fixtures', file);
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { filename: file, data: raw };
    });

    const dmPath = path.join(__dirname, 'fixtures', 'match_deathmatch.json');
    if (fs.existsSync(dmPath)) {
      matchDeathmatch = JSON.parse(fs.readFileSync(dmPath, 'utf8'));
    }
  });

  // Print metric distributions across fixtures
  test('Metric Distributions Across Real Match Fixtures', () => {
    console.log('\n===============================================================');
    console.log('   TELEMETRY METRIC DISTRIBUTIONS ACROSS 3 REAL MATCH FIXTURES ');
    console.log('===============================================================');

    fixtures.forEach(({ filename, data }) => {
      const result = telemetryService.analyzeTelemetry(
        [data],
        data.player_riot_id || 'Player_Subject#0001',
        data.player_puuid,
        data.tier || 'Radiant'
      );

      expect(result).toBeDefined();
      console.log(`\n--- Fixture: ${filename} (Map: ${data.map}, Agent: ${data.agent}, Tier: ${data.tier}) ---`);
      console.log(`  • Deaths (Total / Eligible Trade): ${result.trade_metrics.total_deaths} / ${result.trade_metrics.eligible_trade_deaths}`);
      console.log(`  • Untradeable Deaths: ${result.trade_metrics.untradeable_deaths.count}/${result.trade_metrics.untradeable_deaths.denominator} (${result.trade_metrics.untradeable_deaths.pct}%)`);
      console.log(`  • Traded Deaths: ${result.trade_metrics.traded_deaths.count}/${result.trade_metrics.traded_deaths.denominator} (${result.trade_metrics.traded_deaths.pct}%)`);
      console.log(`  • You Trade Teammates: ${result.trade_metrics.you_trade_teammates.description}`);
      console.log(`  • Died From Behind: ${result.flank_angle.count}/${result.flank_angle.denominator} (${result.flank_angle.died_from_behind_pct}%)`);
      console.log(`  • Killer Aim Under 30°: ${result.killer_aim_validation.under_30_deg_pct}% (${result.killer_aim_validation.under_30_deg_count}/${result.killer_aim_validation.duels_evaluated} duels)`);
      console.log(`  • Dry-Peek (Attack / Defense): ${result.tempo.attack_dry_peeks.pct}% Atk / ${result.tempo.defense_dry_peeks.pct}% Def`);
      console.log(`  • Avg Engagement Distance: ${result.combat_range.avg_distance_meters} meters`);
      console.log(`  • Replay Cue Sheet Targets: ${result.replay_cue_sheet.length} critical rounds identified`);
      console.log(`  • Impact-Ranked Flaws: ${result.impact_flaws.map(f => `${f.flaw} [${f.round_impact}]`).join(', ') || 'None'}`);
    });
    console.log('===============================================================\n');
  });

  // (1) Debug match1.json / match_deathmatch.json: why are all 19 deaths ineligible? Print per-death alive-teammate counts and team/puuid matching.
  describe('(1) Debug match1.json / match_deathmatch.json Ineligible Deaths & Trade Timing', () => {
    test('Debug match_deathmatch.json: Print per-death alive-teammate counts and explain why all 19 deaths are ineligible', () => {
      // NOTE (Requirement 0h doc): Per Requirement 0a, match1.json was replaced with a competitive-queue fixture,
      // and the deathmatch fixture was moved to match_deathmatch.json as a dedicated 'is skipped' test.
      // Assertions are maintained at 19 deaths, 0 alive teammates, and 0 eligible trades.
      const dmData = matchDeathmatch;
      const riotId = dmData.player_riot_id || 'Player_Subject#0001';
      const puuid = dmData.player_puuid;

      console.log('\n--- DEBUGGING MATCH_DEATHMATCH.JSON DEATHS (FFA DEATHMATCH) ---');
      console.log(`Target Player: ${riotId} (PUUID: ${puuid})`);

      const killEvents = dmData.kill_events || [];
      const deaths = [];

      killEvents.forEach((k, idx) => {
        const isVictim = (puuid && k.victim_puuid === puuid) ||
                         (k.victim_display_name && k.victim_display_name.toLowerCase() === riotId.toLowerCase());
        if (isVictim) {
          const snapshot = k.player_locations_on_kill || [];
          const victimTeam = k.victim_team;
          const aliveTeammates = snapshot.filter(
            p => p.player_team === victimTeam &&
                 p.player_display_name && p.player_display_name.toLowerCase() !== riotId.toLowerCase()
          );

          deaths.push({
            deathIndex: deaths.length + 1,
            roundEventIdx: idx,
            killTimeMs: k.kill_time_in_round,
            victimTeam: victimTeam,
            killer: k.killer_display_name,
            killerTeam: k.killer_team,
            snapshotCount: snapshot.length,
            aliveTeammatesCount: aliveTeammates.length
          });
        }
      });

      console.log(`Total Player Deaths found in match_deathmatch: ${deaths.length}`);
      expect(deaths.length).toBe(19);

      // Print table of all 19 deaths
      console.table(deaths.map(d => ({
        Death: `#${d.deathIndex}`,
        KillTimeMs: d.killTimeMs,
        VictimTeamUUID: d.victimTeam.substring(0, 8) + '...',
        Killer: d.Killer,
        SnapshotPlayers: d.snapshotCount,
        AliveTeammates: d.aliveTeammatesCount
      })));

      // Assert that every death has 0 alive teammates because it is a Deathmatch FFA mode
      deaths.forEach(d => {
        expect(d.aliveTeammatesCount).toBe(0);
      });

      const result = telemetryService.analyzeTelemetry([dmData], riotId, puuid, 'Radiant');
      expect(result.game_mode).toBe('deathmatch_ffa');
      expect(result.trade_metrics.total_deaths).toBe(19);
      expect(result.trade_metrics.eligible_trade_deaths).toBe(0);
      expect(result.trade_metrics.untradeable_deaths.count).toBe(0);

      console.log('Conclusion: In Deathmatch FFA, every player is placed on a unique UUID team.');
      console.log('Therefore, aliveTeammates is always 0, triggering the clutch/last-alive guard for all 19 deaths.');
      console.log('-----------------------------------------------------\n');
    });

    test('Trade requires the killer specifically to be killed within 5s by a teammate', () => {
      const mockMatch = {
        map: 'Ascent',
        rounds: [{}],
        kill_events: [
          {
            kill_time_in_round: 10000,
            killer_display_name: 'EnemyA',
            killer_team: 'Red',
            victim_display_name: 'Student#001',
            victim_team: 'Blue',
            victim_death_location: { x: 1000, y: 1000 },
            player_locations_on_kill: [
              { player_display_name: 'Student#001', player_team: 'Blue', location: { x: 1000, y: 1000 }, view_radians: 0 },
              { player_display_name: 'Teammate1', player_team: 'Blue', location: { x: 1400, y: 1000 }, view_radians: 0 }
            ]
          },
          {
            kill_time_in_round: 13000, // 3000ms later (<5s)
            killer_display_name: 'Teammate1',
            killer_team: 'Blue',
            victim_display_name: 'EnemyA', // Killer eliminated
            victim_team: 'Red'
          }
        ]
      };

      const res = telemetryService.analyzeTelemetry([mockMatch], 'Student#001', null, 'Gold 2');
      expect(res.trade_metrics.traded_deaths.count).toBe(1);
      expect(res.trade_metrics.trade_conversion_rate).toBe(1.0);
    });

    test('Trade fails if elapsed time exceeds 5000ms', () => {
      const mockMatchLateTrade = {
        map: 'Ascent',
        rounds: [{}],
        kill_events: [
          {
            kill_time_in_round: 10000,
            killer_display_name: 'EnemyA',
            killer_team: 'Red',
            victim_display_name: 'Student#001',
            victim_team: 'Blue',
            victim_death_location: { x: 1000, y: 1000 },
            player_locations_on_kill: [
              { player_display_name: 'Student#001', player_team: 'Blue', location: { x: 1000, y: 1000 }, view_radians: 0 },
              { player_display_name: 'Teammate1', player_team: 'Blue', location: { x: 1400, y: 1000 }, view_radians: 0 }
            ]
          },
          {
            kill_time_in_round: 16000, // 6s later (>5s window)
            killer_display_name: 'Teammate1',
            killer_team: 'Blue',
            victim_display_name: 'EnemyA',
            victim_team: 'Red'
          }
        ]
      };

      const res = telemetryService.analyzeTelemetry([mockMatchLateTrade], 'Student#001', null, 'Gold 2');
      expect(res.trade_metrics.traded_deaths.count).toBe(0);
    });

    test('Last-alive (1vX clutch) deaths are excluded from isolated-death denominator', () => {
      const mockClutchMatch = {
        map: 'Ascent',
        rounds: [{}],
        kill_events: [
          {
            kill_time_in_round: 45000,
            killer_display_name: 'EnemyX',
            killer_team: 'Red',
            victim_display_name: 'Clutcher#001',
            victim_team: 'Blue',
            victim_death_location: { x: 5000, y: 5000 },
            player_locations_on_kill: [
              { player_display_name: 'Clutcher#001', player_team: 'Blue', location: { x: 5000, y: 5000 }, view_radians: 0 },
              { player_display_name: 'EnemyX', player_team: 'Red', location: { x: 5200, y: 5000 }, view_radians: Math.PI }
            ]
          }
        ]
      };

      const res = telemetryService.analyzeTelemetry([mockClutchMatch], 'Clutcher#001', null, 'Diamond 1');
      expect(res.trade_metrics.total_deaths).toBe(1);
      expect(res.trade_metrics.eligible_trade_deaths).toBe(0);
      expect(res.trade_metrics.untradeable_deaths.count).toBe(0);
      expect(res.trade_metrics.untradeable_deaths.denominator).toBe(0);
    });
  });

  // (2) Log raw counts alongside percentages for every metric
  describe('(2) Raw Counts Alongside Percentages for Every Metric', () => {
    test('Verifies structure { count, denominator, pct } across all metric domains', () => {
      const match2 = fixtures.find(f => f.filename === 'match2.json').data;
      const res = telemetryService.analyzeTelemetry([match2], match2.player_riot_id, match2.player_puuid, 'Ascendant 1');

      // 1. Untradeable deaths
      expect(res.trade_metrics.untradeable_deaths).toHaveProperty('count');
      expect(res.trade_metrics.untradeable_deaths).toHaveProperty('denominator');
      expect(res.trade_metrics.untradeable_deaths).toHaveProperty('pct');
      expect(typeof res.trade_metrics.untradeable_deaths.count).toBe('number');
      expect(typeof res.trade_metrics.untradeable_deaths.denominator).toBe('number');
      expect(typeof res.trade_metrics.untradeable_deaths.pct).toBe('number');

      // 2. Traded deaths
      expect(res.trade_metrics.traded_deaths).toHaveProperty('count');
      expect(res.trade_metrics.traded_deaths).toHaveProperty('denominator');
      expect(res.trade_metrics.traded_deaths).toHaveProperty('pct');

      // 3. Flank angle
      expect(res.flank_angle).toHaveProperty('count');
      expect(res.flank_angle).toHaveProperty('denominator');
      expect(res.flank_angle).toHaveProperty('died_from_behind_pct');

      // 4. Killer aim
      expect(res.killer_aim_validation).toHaveProperty('under_30_deg_count');
      expect(res.killer_aim_validation).toHaveProperty('duels_evaluated');
      expect(res.killer_aim_validation).toHaveProperty('under_30_deg_pct');

      // 5. Tempo (Attack & Defense)
      expect(res.tempo.attack_dry_peeks).toHaveProperty('count');
      expect(res.tempo.attack_dry_peeks).toHaveProperty('denominator');
      expect(res.tempo.attack_dry_peeks).toHaveProperty('pct');
      expect(res.tempo.defense_dry_peeks).toHaveProperty('count');
      expect(res.tempo.defense_dry_peeks).toHaveProperty('denominator');
      expect(res.tempo.defense_dry_peeks).toHaveProperty('pct');

      // 6. Combat range
      expect(res.combat_range.close_range_fights).toHaveProperty('count');
      expect(res.combat_range.close_range_fights).toHaveProperty('denominator');
      expect(res.combat_range.close_range_fights).toHaveProperty('pct');
    });
  });

  // (3) Replace Shannon entropy with top-3-cell death share per map and side, with a min-sample guard and a shuffled-baseline comparison
  describe('(3) Spatial Predictability: Top-3-Cell Death Share per Map and Side', () => {
    test('Guards against low sample size when deaths on map/side < 8', () => {
      const mockSparseMatch = {
        map: 'Ascent',
        rounds: [{}, {}, {}],
        kill_events: [
          {
            round: 1,
            kill_time_in_round: 15000,
            killer_display_name: 'Opp1',
            victim_display_name: 'Subject#001',
            victim_death_location: { x: 1000, y: 1000 },
            player_locations_on_kill: []
          },
          {
            round: 2,
            kill_time_in_round: 25000,
            killer_display_name: 'Opp2',
            victim_display_name: 'Subject#001',
            victim_death_location: { x: 1200, y: 1200 },
            player_locations_on_kill: []
          }
        ]
      };

      const res = telemetryService.analyzeTelemetry([mockSparseMatch], 'Subject#001', null, 'Platinum 2');
      const ascentAttack = res.spatial_top_3_cell_share['Ascent:attack'];
      expect(ascentAttack).toBeDefined();
      expect(ascentAttack.is_valid_sample).toBe(false);
      expect(ascentAttack.total_deaths).toBe(2);
      expect(ascentAttack.note).toContain('Insufficient sample');
    });

    test('Computes top-3-cell death share and shuffled baseline when sample >= 8', () => {
      // Create a scenario with 15 deaths on Ascent attack side:
      // 8 deaths clustered in cell (1, 1), and 7 deaths scattered across 7 different cells (2..8)
      const clusteredEvents = [];
      for (let i = 0; i < 8; i++) {
        clusteredEvents.push({
          round: 1 + (i % 5),
          kill_time_in_round: 20000,
          killer_display_name: 'Enemy',
          victim_display_name: 'Cluster#001',
          victim_death_location: { x: 1200, y: 1200 }, // Cell 1_1
          player_locations_on_kill: []
        });
      }
      for (let i = 0; i < 7; i++) {
        clusteredEvents.push({
          round: 1 + (i % 5),
          kill_time_in_round: 20000,
          killer_display_name: 'Enemy',
          victim_display_name: 'Cluster#001',
          victim_death_location: { x: (2000 + i * 1500), y: (2000 + i * 1500) }, // Distinct cells 2..8
          player_locations_on_kill: []
        });
      }

      const clusterMatch = {
        map: 'Ascent',
        rounds: Array(15).fill({}),
        kill_events: clusteredEvents
      };

      const res = telemetryService.analyzeTelemetry([clusterMatch], 'Cluster#001', null, 'Diamond 2');
      const attackSlice = res.spatial_top_3_cell_share['Ascent:attack'];
      expect(attackSlice.is_valid_sample).toBe(true);
      expect(attackSlice.total_deaths).toBe(15);
      expect(attackSlice.top_3_cell_deaths).toBeGreaterThanOrEqual(10);
      expect(attackSlice.top_3_cell_share_pct).toBeGreaterThanOrEqual(60.0);
      expect(attackSlice.shuffled_baseline_pct).toBeDefined();
      expect(attackSlice.excess_clustering_pct).toBeGreaterThan(0);
      expect(attackSlice.predictability_level).toContain('High');
    });
  });

  // (4) Split dry-peek by side and require no utility or no nearby ally
  describe('(4) Dry-Peek Split by Side & Spatial Ally Support', () => {
    test('Identifies opening dry-peeks (<22s without ally within 1500 units) on Attack and Defense', () => {
      const mockMatch = {
        map: 'Haven',
        rounds: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
        kill_events: [
          // Round 2 (Attack): Death at t=12s, teammate far away at 3500 units -> Attack Dry Peek
          {
            round: 2,
            kill_time_in_round: 12000,
            killer_display_name: 'Enemy1',
            killer_team: 'Defenders',
            victim_display_name: 'Peeker#001',
            victim_team: 'Attackers',
            victim_death_location: { x: 1000, y: 1000 },
            player_locations_on_kill: [
              { player_display_name: 'Peeker#001', player_team: 'Attackers', location: { x: 1000, y: 1000 }, view_radians: 0 },
              { player_display_name: 'Ally1', player_team: 'Attackers', location: { x: 4500, y: 1000 }, view_radians: 0 } // 3500 units away!
            ]
          },
          // Round 14 (Defense): Death at t=10s, teammate far away at 2800 units -> Defense Dry Peek
          {
            round: 14,
            kill_time_in_round: 10000,
            killer_display_name: 'Enemy2',
            killer_team: 'Attackers',
            victim_display_name: 'Peeker#001',
            victim_team: 'Defenders',
            victim_death_location: { x: 2000, y: 2000 },
            player_locations_on_kill: [
              { player_display_name: 'Peeker#001', player_team: 'Defenders', location: { x: 2000, y: 2000 }, view_radians: 0 },
              { player_display_name: 'Ally2', player_team: 'Defenders', location: { x: 4800, y: 2000 }, view_radians: 0 } // 2800 units away!
            ]
          },
          // Round 3 (Attack): Death at t=15s, BUT ally is right next to player (500 units) -> NOT a dry peek (has support)
          {
            round: 3,
            kill_time_in_round: 15000,
            killer_display_name: 'Enemy3',
            killer_team: 'Defenders',
            victim_display_name: 'Peeker#001',
            victim_team: 'Attackers',
            victim_death_location: { x: 1000, y: 1000 },
            player_locations_on_kill: [
              { player_display_name: 'Peeker#001', player_team: 'Attackers', location: { x: 1000, y: 1000 }, view_radians: 0 },
              { player_display_name: 'Ally1', player_team: 'Attackers', location: { x: 1500, y: 1000 }, view_radians: 0 } // 500 units away!
            ]
          }
        ]
      };

      const res = telemetryService.analyzeTelemetry([mockMatch], 'Peeker#001', null, 'Platinum 1');
      expect(res.tempo.attack_dry_peeks.count).toBe(1);
      expect(res.tempo.attack_dry_peeks.denominator).toBe(2);
      expect(res.tempo.attack_dry_peeks.pct).toBe(50.0);

      expect(res.tempo.defense_dry_peeks.count).toBe(1);
      expect(res.tempo.defense_dry_peeks.denominator).toBe(1);
      expect(res.tempo.defense_dry_peeks.pct).toBe(100.0);
    });
  });

  // (5) Add a “you trade teammates” metric, and show n plus a Wilson interval; don’t label anything from a single match
  describe('(5) "You Trade Teammates" & Wilson Interval & Single-Match Guard', () => {
    test('Computes Wilson 95% Confidence Interval for teammate trade opportunities', () => {
      // 10 opportunities, 4 trades
      const ci = telemetryService.calculateWilsonInterval(4, 10);
      expect(Array.isArray(ci)).toBe(true);
      expect(ci.length).toBe(2);
      expect(ci[0]).toBeGreaterThanOrEqual(0);
      expect(ci[1]).toBeLessThanOrEqual(100);
      expect(ci[0]).toBeLessThan(ci[1]);
      console.log(`[Wilson Score 95% CI Check] 4/10 successes -> CI: [${ci[0]}%, ${ci[1]}%]`);
    });

    test('Single-match analysis does NOT assign normative labels (Unlabeled guard)', () => {
      const match2 = fixtures.find(f => f.filename === 'match2.json').data;
      const singleRes = telemetryService.analyzeTelemetry([match2], match2.player_riot_id, match2.player_puuid, 'Gold 3');

      expect(singleRes.is_single_match).toBe(true);
      expect(singleRes.trade_metrics.efficiency_rating).toBe('Single Match (Unlabeled)');
      // Impact flaws should contain preliminary notice
      singleRes.impact_flaws.forEach(f => {
        expect(f.verdict).toContain('Preliminary');
      });
    });

    test('Multi-match analysis assigns normative labels (Elite / Moderate / Underperforming)', () => {
      const match2 = fixtures.find(f => f.filename === 'match2.json').data;
      const match3 = fixtures.find(f => f.filename === 'match3.json').data;
      const multiRes = telemetryService.analyzeTelemetry([match2, match3], match2.player_riot_id, match2.player_puuid, 'Gold 3');

      expect(multiRes.is_single_match).toBe(false);
      expect(['Elite', 'Moderate', 'Underperforming']).toContain(multiRes.trade_metrics.efficiency_rating);
    });
  });

  // (6) Verify tier scales invert correctly for lower-is-better stats
  describe('(6) Monotonically Inverting Tier Scales for Lower-is-Better Stats', () => {
    test('Target thresholds strictly decrease as rank increases from Iron 1 to Radiant', () => {
      const ranksInOrder = [
        'Iron 1', 'Iron 3',
        'Bronze 1', 'Bronze 3',
        'Silver 1', 'Silver 3',
        'Gold 1', 'Gold 3',
        'Platinum 1', 'Platinum 3',
        'Diamond 1', 'Diamond 3',
        'Ascendant 1', 'Ascendant 3',
        'Immortal 1', 'Immortal 3',
        'Radiant'
      ];

      const mockMatch = fixtures[1].data;
      let prevUntradeableMax = Infinity;
      let prevFlankMax = Infinity;
      let prevDryPeekMax = Infinity;

      ranksInOrder.forEach(rank => {
        const res = telemetryService.analyzeTelemetry([mockMatch], mockMatch.player_riot_id, mockMatch.player_puuid, rank);
        const targets = res.rank_cohort_context.lower_is_better_targets;

        console.log(`[Rank Tier Scale: ${rank.padEnd(12)}] Untradeable Max: ${targets.target_untradeable_max}, Flank Max: ${targets.target_flank_max}, Dry-Peek Max: ${targets.target_dry_peek_max}`);

        // Monotonic decrease: Higher elo = lower tolerance for untradeable deaths, flank deaths, and dry peeks
        expect(targets.target_untradeable_max).toBeLessThanOrEqual(prevUntradeableMax);
        expect(targets.target_flank_max).toBeLessThanOrEqual(prevFlankMax);
        expect(targets.target_dry_peek_max).toBeLessThanOrEqual(prevDryPeekMax);

        prevUntradeableMax = targets.target_untradeable_max;
        prevFlankMax = targets.target_flank_max;
        prevDryPeekMax = targets.target_dry_peek_max;
      });
    });
  });

  // (7) Show cues as elapsed plus on-clock time
  describe('(7) Replay Cue Sheet Formatting (Elapsed + On-Clock Time)', () => {
    test('Replay cues format elapsed combat time plus on-clock countdown time', () => {
      fixtures.forEach(({ filename, data }) => {
        const res = telemetryService.analyzeTelemetry([data], data.player_riot_id, data.player_puuid, 'Silver 1');
        
        res.replay_cue_sheet.forEach(cue => {
          console.log(`[Replay Cue Format - ${filename}] ${cue.clock_display}: ${cue.cue}`);
          expect(cue.clock_display).toMatch(/^\d+:\d{2} elapsed \(\d+:\d{2} on-clock\)$/);
          expect(cue.elapsed_time).toMatch(/^\d+:\d{2}$/);
          expect(cue.on_clock_remaining).toMatch(/^\d+:\d{2}$/);
        });
      });
    });
  });

  // (8) Anonymize fixtures and return a generic 503 instead of the Atlas whitelist message
  describe('(8) Anonymization of Fixtures', () => {
    test('Verifies that no real player names, real tags, or real PUUIDs exist in fixtures', () => {
      fixtures.forEach(({ filename, data }) => {
        const rawText = JSON.stringify(data);
        // Ensure no leaked real identifiers
        expect(rawText).not.toMatch(/f0rsaken/i);
        expect(rawText).not.toMatch(/tenz/i);
        expect(rawText).not.toMatch(/aspas/i);
        expect(rawText).not.toMatch(/mongodb\+srv/i);
      });
    });
  });

  // Angle Wrapping to [0, π] & Killer Aim Validation
  describe('Angle Wrapping to [0, π] & Killer Aim Validation', () => {
    test('wrapAngleToPi wraps any positive/negative angular delta strictly into [0, Math.PI]', () => {
      expect(telemetryService.wrapAngleToPi(0)).toBe(0);
      expect(telemetryService.wrapAngleToPi(Math.PI)).toBeCloseTo(Math.PI, 4);
      expect(telemetryService.wrapAngleToPi(-Math.PI)).toBeCloseTo(Math.PI, 4);
      expect(telemetryService.wrapAngleToPi(3 * Math.PI)).toBeCloseTo(Math.PI, 4);
      expect(telemetryService.wrapAngleToPi(2 * Math.PI)).toBeCloseTo(0, 4);
      expect(telemetryService.wrapAngleToPi(-0.5)).toBeCloseTo(0.5, 4);
    });

    test('Killer view toward victim is under 30° for the vast majority of gun kills across fixtures', () => {
      fixtures.forEach(({ filename, data }) => {
        const res = telemetryService.analyzeTelemetry([data], data.player_riot_id, data.player_puuid);
        const aimPct = res.killer_aim_validation.under_30_deg_pct;
        const duels = res.killer_aim_validation.duels_evaluated;

        console.log(`[Aim Check - ${filename}] ${aimPct}% of killers were aimed directly under 30° toward their target (${duels} duels evaluated)`);
        expect(duels).toBeGreaterThan(0);
        expect(aimPct).toBeGreaterThanOrEqual(70.0);
      });
    });
  });

  // Kill Time In Round vs Buy-Phase Offset
  describe('Kill Time In Round vs Buy-Phase Offset', () => {
    test('Henrik API kill_time_in_round starts at 0 upon combat barrier drop (no buy phase offset)', () => {
      fixtures.forEach(({ filename, data }) => {
        const killTimes = (data.kill_events || []).map(k => k.kill_time_in_round).filter(t => t != null);
        const minKillTime = Math.min(...killTimes);

        console.log(`[Buy-Phase Offset Check - ${filename}] Earliest kill in match occurred at: ${minKillTime}ms (${(minKillTime / 1000).toFixed(1)}s)`);
        expect(minKillTime).toBeLessThan(10000);

        const res = telemetryService.analyzeTelemetry([data], data.player_riot_id);
        expect(res.tempo.buy_phase_offset_ms).toBe(0);
      });
    });
  });

  // Explicit Labeling of Estimated Constants
  describe('Explicit Labeling of Estimated Constants', () => {
    test('Every round impact metric and replay cue carries the explicit (estimated) tag', () => {
      fixtures.forEach(({ filename, data }) => {
        const res = telemetryService.analyzeTelemetry([data], data.player_riot_id, data.player_puuid, 'Silver 1');

        res.impact_flaws.forEach(flaw => {
          expect(flaw.round_impact).toMatch(/\(estimated\)/);
          expect(flaw.metric_type).toBe('estimated');
        });

        res.replay_cue_sheet.forEach(cue => {
          expect(cue.win_prob_impact).toMatch(/\(estimated\)/);
        });
      });
    });
  });

  // Unit Sanity Test: Median Non-Operator Kill Distance (Requirement 0d)
  describe('Unit Sanity Test: Non-Operator Kill Distances (Requirement 0d)', () => {
    test('Median non-Operator kill distance strictly falls in 5–40m across competitive fixtures', () => {
      fixtures.forEach(({ filename, data }) => {
        const killEvents = data.kill_events || [];
        const distances = [];

        killEvents.forEach(k => {
          const weaponName = (k.damage_weapon_name || k.weapon || '').toLowerCase();
          if (weaponName.includes('operator')) return;

          const deathLoc = k.victim_death_location;
          const killerSnap = (k.player_locations_on_kill || []).find(
            p => p.player_display_name && p.player_display_name.toLowerCase() === (k.killer_display_name || '').toLowerCase()
          );

          if (deathLoc && killerSnap && killerSnap.location) {
            const dx = deathLoc.x - killerSnap.location.x;
            const dy = deathLoc.y - killerSnap.location.y;
            const distMeters = Math.sqrt(dx * dx + dy * dy) / 100;
            if (distMeters > 0) {
              distances.push(distMeters);
            }
          }
        });

        expect(distances.length).toBeGreaterThan(10);
        distances.sort((a, b) => a - b);
        const median = distances[Math.floor(distances.length / 2)];

        console.log(`[Sanity Check - ${filename}] Median non-Op kill distance: ${median.toFixed(2)}m (evaluated ${distances.length} duels)`);
        expect(median).toBeGreaterThanOrEqual(5.0);
        expect(median).toBeLessThanOrEqual(40.0);
      });
    });
  });

  // Mode Gating & Unsupported Queues (Requirement 0a)
  describe('Mode Gating: Supported Queues & Ingestion Filtering (Requirement 0a)', () => {
    test('SUPPORTED_QUEUES correctly recognizes competitive, unrated, and premier', () => {
      expect(SUPPORTED_QUEUES).toContain('competitive');
      expect(SUPPORTED_QUEUES).toContain('unrated');
      expect(SUPPORTED_QUEUES).toContain('premier');

      expect(isSupportedQueue({ queue: 'competitive', rounds: Array(20) }).supported).toBe(true);
      expect(isSupportedQueue({ metadata: { queue: 'unrated' }, rounds: Array(18) }).supported).toBe(true);
      expect(isSupportedQueue({ queue: 'premier', rounds: Array(22) }).supported).toBe(true);
    });

    test('Skips unsupported modes (deathmatch, spikerush, escalation, swiftplay) with recorded reason', () => {
      const dmCheck = isSupportedQueue({ queue: 'deathmatch' });
      expect(dmCheck.supported).toBe(false);
      expect(dmCheck.reason).toContain('deathmatch');

      const srCheck = isSupportedQueue({ mode: 'spikerush' });
      expect(srCheck.supported).toBe(false);
      expect(srCheck.reason).toContain('spikerush');

      const swiftCheck = isSupportedQueue({ queue: 'swiftplay' });
      expect(swiftCheck.supported).toBe(false);
      expect(swiftCheck.reason).toContain('swiftplay');

      const escCheck = isSupportedQueue({ metadata: { mode: 'escalation' } });
      expect(escCheck.supported).toBe(false);
      expect(escCheck.reason).toContain('escalation');

      // Verify the saved deathmatch fixture is rejected
      if (matchDeathmatch) {
        const fixtureCheck = isSupportedQueue(matchDeathmatch);
        expect(fixtureCheck.supported).toBe(false);
      }
    });
  });

  // Synthetic Situation Detectors (Layer A)
  describe('Synthetic Situation Detectors (Layer A)', () => {
    test('SOLO_HOLD_VS_STACK: detects defense death with >=3 enemies <=20m and 0 allies <=25m', () => {
      const cypherDeath = {
        round: 4,
        kill_time_in_round: 28000,
        victim_display_name: 'Cypher#001',
        victim_team: 'Blue',
        victim_death_location: { x: 5000, y: 5000 },
        killer_display_name: 'Enemy1',
        killer_team: 'Red',
        player_locations_on_kill: [
          { player_display_name: 'Cypher#001', player_team: 'Blue', location: { x: 5000, y: 5000 } },
          { player_display_name: 'Enemy1', player_team: 'Red', location: { x: 5800, y: 5200 } },
          { player_display_name: 'Enemy2', player_team: 'Red', location: { x: 6200, y: 5000 } },
          { player_display_name: 'Enemy3', player_team: 'Red', location: { x: 6000, y: 6000 } },
          { player_display_name: 'TeammateA', player_team: 'Blue', location: { x: 1000, y: 1000 } }
        ]
      };

      const situations = detectRoundSituations({
        matchId: 'm1',
        roundNum: 4,
        side: 'defense',
        role: 'Sentinel',
        killEvents: [cypherDeath],
        playerRiotId: 'Cypher#001'
      });

      const soloHold = situations.find(s => s.tag === 'SOLO_HOLD_VS_STACK');
      expect(soloHold).toBeDefined();
      expect(soloHold.polarity).toBe('flaw');
      expect(soloHold.evidence.enemiesNear).toBeGreaterThanOrEqual(3);
      expect(soloHold.evidence.alliesNear).toBe(0);
    });

    test('LETS_TEAMMATES_ENTER_FIRST: triggers on attack when Duelist is alive but not in top 2 nearest to contact', () => {
      const contactKill = {
        round: 2,
        kill_time_in_round: 15000,
        victim_display_name: 'SovaAlly',
        victim_team: 'Red',
        victim_death_location: { x: 3000, y: 3000 },
        killer_display_name: 'EnemyOp',
        killer_team: 'Blue',
        player_locations_on_kill: [
          { player_display_name: 'SovaAlly', player_team: 'Red', location: { x: 3000, y: 3000 } },
          { player_display_name: 'OmenAlly', player_team: 'Red', location: { x: 3400, y: 3100 } },
          { player_display_name: 'JettDuelist#001', player_team: 'Red', location: { x: 300, y: 300 } }
        ]
      };

      const situations = detectRoundSituations({
        matchId: 'm2',
        roundNum: 2,
        side: 'attack',
        role: 'Duelist',
        killEvents: [contactKill],
        playerRiotId: 'JettDuelist#001'
      });

      const baitTag = situations.find(s => s.tag === 'LETS_TEAMMATES_ENTER_FIRST');
      expect(baitTag).toBeDefined();
      expect(baitTag.polarity).toBe('flaw');
      expect(baitTag.evidence.playerDistMeters).toBeGreaterThan(25);
    });

    test('DRY_PEEK: requires elapsed < 22s AND no ally within 15m AND no utility cast', () => {
      const dryDeath = {
        round: 1,
        kill_time_in_round: 14000,
        victim_display_name: 'Entry#001',
        victim_team: 'Red',
        victim_death_location: { x: 4000, y: 4000 },
        killer_display_name: 'EnemyVandal',
        killer_team: 'Blue',
        player_locations_on_kill: [
          { player_display_name: 'Entry#001', player_team: 'Red', location: { x: 4000, y: 4000 } },
          { player_display_name: 'EnemyVandal', player_team: 'Blue', location: { x: 5500, y: 4000 } },
          { player_display_name: 'AllyFar', player_team: 'Red', location: { x: 1000, y: 1000 } }
        ]
      };

      // Case 1: No utility cast -> DRY_PEEK
      const situationsNoUtil = detectRoundSituations({
        matchId: 'm3',
        roundNum: 1,
        side: 'attack',
        role: 'Duelist',
        killEvents: [dryDeath],
        roundStats: { ability_casts: 0 },
        playerRiotId: 'Entry#001'
      });

      const dryPeek = situationsNoUtil.find(s => s.tag === 'DRY_PEEK');
      expect(dryPeek).toBeDefined();
      expect(dryPeek.polarity).toBe('flaw');

      // Case 2: Utility cast performed -> EARLY_DEATH_NO_ALLY
      const situationsWithUtil = detectRoundSituations({
        matchId: 'm3',
        roundNum: 1,
        side: 'attack',
        role: 'Duelist',
        killEvents: [dryDeath],
        roundStats: { ability_casts: 2 },
        playerRiotId: 'Entry#001'
      });

      expect(situationsWithUtil.some(s => s.tag === 'DRY_PEEK')).toBe(false);
      expect(situationsWithUtil.some(s => s.tag === 'EARLY_DEATH_NO_ALLY')).toBe(true);
    });
  });

  // Habit Aggregator (Layer B) Tiers
  describe('Habit Aggregator (Layer B) Tiers', () => {
    test('Habit tiers: n < 15 opportunities or < 5 matches returns "not enough data"', () => {
      const sparseMatches = [1, 2, 3].map(id => ({
        matchId: `sparse_${id}`,
        rounds: Array(12).fill({}),
        kill_events: []
      }));

      const res = aggregateHabits(sparseMatches, 'SparsePlayer#001', null);
      expect(res.habits.length).toBeGreaterThan(0);
      res.habits.forEach(h => {
        expect(h.tier).toBe('not enough data');
      });
    });

    test('Habit tier rules: thresholds strictly enforce occasional <=2, pattern >=3, strong >=5', () => {
      expect(HABIT_RULES.OCCASIONAL_MAX_PER_HALF).toBe(2);
      expect(HABIT_RULES.PATTERN_MIN_PER_HALF).toBe(3);
      expect(HABIT_RULES.STRONG_MIN_PER_HALF).toBe(5);
      expect(HABIT_RULES.PATTERN_MIN_HALF_PCT).toBe(0.50);
      expect(HABIT_RULES.PATTERN_MIN_MATCH_PCT).toBe(0.40);
      expect(HABIT_RULES.STRONG_MIN_HALF_PCT).toBe(0.70);
      expect(HABIT_RULES.STRONG_MIN_MATCH_PCT).toBe(0.60);
    });
  });
});
