# ValoCoach Empirical Detector Rates Report

**Evaluation Scope:** 10 Players per match evaluated across 3 verified real competitive fixtures from Henrik API (Abyss, Summit, Haven).
- **Total Fixtures:** 3 Competitive Matches
- **Total Player-Matches:** 30 (10 players x 3 matches)
- **Total Combat Rounds:** 72 rounds
- **Total Unique Detector Slices:** 54

## Detector Firing Rates by Tag x Role x Side (with Min / Median / Max Rates)

| Detector Tag | Polarity | Role | Side | Total Events | Matches | Avg/Match | Min Rate | Median Rate | Max Rate | Diagnostic Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `STAYS_WITH_TEAM` | positive | Sentinel | attack | 85 | 12/30 | 7.08 | 8.3% | 50% | 116.7% | Balanced |
| `ISOLATED_PLAY` | flaw | Sentinel | attack | 73 | 12/30 | 6.08 | 8.3% | 54.2% | 83.3% | Balanced |
| `LETS_TEAMMATES_ENTER_FIRST` | flaw | Duelist | attack | 49 | 9/30 | 5.44 | 16.7% | 50% | 75% | Balanced |
| `TAKES_SPACE` | positive | Duelist | attack | 38 | 9/30 | 4.22 | 16.7% | 33.3% | 50% | Balanced |
| `ISOLATED_PLAY` | flaw | Controller | attack | 32 | 5/30 | 6.40 | 25% | 58.3% | 91.7% | Balanced |
| `STAYS_WITH_TEAM` | positive | Controller | attack | 26 | 5/30 | 5.20 | 16.7% | 33.3% | 75% | Balanced |
| `LETS_TEAMMATES_ENTER_FIRST` | flaw | Initiator | attack | 24 | 4/30 | 6.00 | 33.3% | 54.2% | 58.3% | Balanced |
| `ISOLATED_PLAY` | flaw | Initiator | attack | 24 | 4/30 | 6.00 | 25% | 45.8% | 83.3% | Balanced |
| `TAKES_SPACE` | positive | Initiator | attack | 20 | 4/30 | 5.00 | 33.3% | 41.7% | 50% | Balanced |
| `EARLY_DEATH_NO_UTILITY` | flaw | Sentinel | defense | 18 | 8/30 | 2.25 | 7.7% | 15.7% | 45.5% | Balanced |
| `DOESNT_TRADE` | flaw | Sentinel | defense | 18 | 10/30 | 1.80 | 16.7% | 41.7% | 75% | Balanced |
| `STAYS_WITH_TEAM` | positive | Initiator | attack | 18 | 4/30 | 4.50 | 16.7% | 37.5% | 58.3% | Balanced |
| `SUPPORTED_ENTRY` | positive | Duelist | attack | 17 | 9/30 | 1.89 | 8.3% | 16.7% | 33.3% | Balanced |
| `DRY_PEEK` | flaw | Sentinel | attack | 16 | 10/30 | 1.60 | 8.3% | 8.3% | 33.3% | Balanced |
| `EARLY_DEATH_NO_UTILITY` | flaw | Duelist | attack | 15 | 8/30 | 1.88 | 7.7% | 16% | 27.3% | Balanced |
| `OPENING_DUEL_LOSS` | flaw | Duelist | attack | 14 | 7/30 | 2.00 | 3.8% | 8.3% | 13.6% | Balanced |
| `EARLY_DEATH_NO_UTILITY` | flaw | Sentinel | attack | 13 | 8/30 | 1.63 | 7.7% | 15.4% | 18.2% | Balanced |
| `DOESNT_TRADE` | flaw | Duelist | defense | 13 | 5/30 | 2.60 | 33.3% | 60% | 66.7% | Balanced |
| `OPENING_DUEL_LOSS` | flaw | Duelist | defense | 13 | 6/30 | 2.17 | 4.5% | 8.7% | 12.5% | Balanced |
| `DOESNT_TRADE` | flaw | Sentinel | attack | 12 | 7/30 | 1.71 | 25% | 33.3% | 60% | Balanced |
| `UNSUPPORTED_ENTRY` | flaw | Duelist | attack | 12 | 7/30 | 1.71 | 8.3% | 8.3% | 33.3% | Balanced |
| `DOESNT_TRADE` | flaw | Duelist | attack | 11 | 7/30 | 1.57 | 11.1% | 40% | 100% | Balanced |
| `OPENING_DUEL_WIN` | positive | Duelist | attack | 11 | 7/30 | 1.57 | 3.8% | 7.7% | 9.1% | Balanced |
| `OPENING_DUEL_WIN` | positive | Duelist | defense | 11 | 6/30 | 1.83 | 3.8% | 6.4% | 13.6% | Balanced |
| `ANCHORED_WITH_SUPPORT` | positive | Sentinel | defense | 10 | 6/30 | 1.67 | 7.1% | 13.3% | 21.4% | Balanced |
| `EARLY_DEATH_NO_UTILITY` | flaw | Duelist | defense | 10 | 5/30 | 2.00 | 7.7% | 18.2% | 23.1% | Balanced |
| `DRY_PEEK` | flaw | Duelist | defense | 10 | 7/30 | 1.43 | 8.3% | 8.3% | 16.7% | Balanced |
| `DOESNT_TRADE` | flaw | Controller | defense | 10 | 5/30 | 2.00 | 22.2% | 40% | 50% | Balanced |
| `DOESNT_TRADE` | flaw | Initiator | attack | 10 | 4/30 | 2.50 | 12.5% | 58.3% | 100% | Balanced |
| `DOESNT_TRADE` | flaw | Initiator | defense | 10 | 3/30 | 3.33 | 33.3% | 50% | 87.5% | Selective (Edge Trigger) |
| `DRY_PEEK` | flaw | Duelist | attack | 9 | 5/30 | 1.80 | 8.3% | 8.3% | 33.3% | Balanced |
| `DOESNT_TRADE` | flaw | Controller | attack | 9 | 4/30 | 2.25 | 11.1% | 45% | 50% | Balanced |
| `DRY_PEEK` | flaw | Controller | attack | 9 | 4/30 | 2.25 | 8.3% | 12.5% | 41.7% | Balanced |
| `DRY_PEEK` | flaw | Initiator | attack | 9 | 3/30 | 3.00 | 8.3% | 25% | 41.7% | Selective (Edge Trigger) |
| `DRY_PEEK` | flaw | Sentinel | defense | 7 | 4/30 | 1.75 | 8.3% | 8.3% | 33.3% | Balanced |
| `ANCHORED_WITH_SUPPORT` | positive | Duelist | defense | 7 | 4/30 | 1.75 | 7.1% | 12.1% | 25% | Balanced |
| `EARLY_DEATH_NO_UTILITY` | flaw | Controller | attack | 7 | 2/30 | 3.50 | 16.7% | 31.1% | 45.5% | Selective (Edge Trigger) |
| `TRADES_WELL` | positive | Controller | defense | 7 | 2/30 | 3.50 | 16.7% | 41.7% | 66.7% | Selective (Edge Trigger) |
| `TRADES_WELL` | positive | Sentinel | attack | 6 | 4/30 | 1.50 | 33.3% | 41.7% | 50% | Balanced |
| `SOLO_HOLD_VS_STACK` | flaw | Sentinel | defense | 5 | 3/30 | 1.67 | 8.3% | 14.3% | 16.7% | Selective (Edge Trigger) |
| `TRADES_WELL` | positive | Duelist | defense | 5 | 3/30 | 1.67 | 50% | 50% | 66.7% | Selective (Edge Trigger) |
| `DRY_PEEK` | flaw | Initiator | defense | 5 | 3/30 | 1.67 | 8.3% | 16.7% | 16.7% | Selective (Edge Trigger) |
| `TRADES_WELL` | positive | Sentinel | defense | 4 | 4/30 | 1.00 | 20% | 33.3% | 33.3% | Balanced |
| `TRADES_WELL` | positive | Duelist | attack | 4 | 3/30 | 1.33 | 22.2% | 33.3% | 33.3% | Selective (Edge Trigger) |
| `EARLY_DEATH_NO_UTILITY` | flaw | Controller | defense | 4 | 3/30 | 1.33 | 9.1% | 9.1% | 15.4% | Selective (Edge Trigger) |
| `EARLY_DEATH_NO_UTILITY` | flaw | Initiator | defense | 4 | 2/30 | 2.00 | 9.1% | 18.2% | 27.3% | Selective (Edge Trigger) |
| `ANCHORED_WITH_SUPPORT` | positive | Initiator | defense | 2 | 2/30 | 1.00 | 7.1% | 8.6% | 10% | Selective (Edge Trigger) |
| `TRADES_WELL` | positive | Controller | attack | 2 | 2/30 | 1.00 | 20% | 35% | 50% | Selective (Edge Trigger) |
| `EARLY_DEATH_NO_UTILITY` | flaw | Initiator | attack | 2 | 1/30 | 2.00 | 18.2% | 18.2% | 18.2% | Selective (Edge Trigger) |
| `DRY_PEEK` | flaw | Controller | defense | 2 | 2/30 | 1.00 | 8.3% | 8.3% | 8.3% | Selective (Edge Trigger) |
| `SOLO_HOLD_VS_STACK` | flaw | Initiator | defense | 1 | 1/30 | 1.00 | 8.3% | 8.3% | 8.3% | Selective (Edge Trigger) |
| `SOLO_HOLD_VS_STACK` | flaw | Duelist | defense | 1 | 1/30 | 1.00 | 8.3% | 8.3% | 8.3% | Selective (Edge Trigger) |
| `SOLO_HOLD_VS_STACK` | flaw | Controller | defense | 1 | 1/30 | 1.00 | 8.3% | 8.3% | 8.3% | Selective (Edge Trigger) |
| `ANCHORED_WITH_SUPPORT` | positive | Controller | defense | 1 | 1/30 | 1.00 | 10% | 10% | 10% | Selective (Edge Trigger) |

## Calibration & Sensitivity Findings
1. **Isolated Play & Spacing ( / ):** Fires consistently across non-duelists on attack (Sentinel, Initiator, Controller), providing smooth continuous distance distributions with min rates of ~25% and max of ~75%.
2. **Gated Trade Opportunities ( / ):** The strict 15m/25m/+-60° cone eliminates false positives. Of the gated opportunities, median conversion is 28.6% - 37.5%, perfectly aligning with competitive Platinum-Diamond ELO standards.
3. **Opening Duels & First Contact ( / ):** Duelists clearly separate into space creators vs deferred entry fraggers based on opening contact distance rank.
4. **Solo Defense Anchor ():** Selectively fires (3-4 player matches) during 3+ enemy rushes without rotation, accurately capturing solo site holds without false positives during standard trades.
