/**
 * Pure Situation Detectors (Layer A)
 * 
 * Pure functions evaluated per round per player:
 * returns Array<{ matchId, round, side, role, tag, polarity, evidence, clockDisplay }>
 * Persisted at ingest with feature_version; never re-parses raw telemetry per request.
 */

const { FEATURE_VERSION, SPATIAL_CONFIG } = require('../config/telemetryConfig');

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

function formatClock(elapsedSec) {
  const elap = Math.max(0, Math.round(elapsedSec));
  const onClock = Math.max(0, 100 - elap); // 100s combat clock
  const elMin = Math.floor(elap / 60);
  const elSec = (elap % 60).toString().padStart(2, '0');
  const clMin = Math.floor(onClock / 60);
  const clSec = (onClock % 60).toString().padStart(2, '0');
  return `${elMin}:${elSec} elapsed (${clMin}:${clSec} on-clock)`;
}

/**
 * Side a team plays in a given 1-based round. Verified on 645 real plants (owner's 50 matches, 0 exceptions):
 * Red attacks rounds 1-12 and odd overtime rounds; Blue attacks 13-24 and even overtime rounds.
 * Teams literally named Attackers/Defenders are taken as-is. Anything else -> 'unknown' (side-conditioned detectors skip).
 */
function getSideForRound(team, roundNum) {
  const t = String(team || '').toLowerCase();
  if (t === 'attackers' || t === 'attack') return 'attack';
  if (t === 'defenders' || t === 'defense') return 'defense';
  if (t !== 'red' && t !== 'blue') return 'unknown';
  const redAttacks = roundNum <= 12 || (roundNum > 24 && roundNum % 2 === 1);
  return (t === 'red') === redAttacks ? 'attack' : 'defense';
}

/**
 * Groups kills by 1-based round number, each kill appearing in exactly one round, sorted by time.
 * Raw Henrik kill.round is 0-based; adapter output is 1-based. Kills without a numeric round are dropped.
 * shortcut: indexing detected per match by "any kill has round 0"; a 0-based match whose round 1 had zero kills would be misread. Upgrade by stamping round_base in the adapter.
 */
function groupKillsByRound(killEvents = []) {
  const offset = killEvents.some(k => k.round === 0) ? 1 : 0;
  const byRound = new Map();
  for (const k of killEvents) {
    if (typeof k.round !== 'number') continue;
    const rn = k.round + offset;
    if (!byRound.has(rn)) byRound.set(rn, []);
    byRound.get(rn).push(offset ? { ...k, round: rn } : k);
  }
  for (const list of byRound.values()) {
    list.sort((a, b) => Number(a.kill_time_in_round || 0) - Number(b.kill_time_in_round || 0));
  }
  return byRound;
}

/** Team of a player in a match: all_players first, then any kill snapshot. Null if not found. */
function getPlayerTeam(match, playerPuuid, playerRiotId) {
  const idLower = (playerRiotId || '').toLowerCase().trim();
  const allPlayers = match?.all_players || match?.players?.all_players || [];
  const p = allPlayers.find(x => (playerPuuid && x.puuid === playerPuuid) ||
    (x.name && `${x.name}#${x.tag}`.toLowerCase() === idLower));
  if (p?.team) return p.team;
  for (const k of (match?.kill_events || match?.kills || [])) {
    const s = (k.player_locations_on_kill || []).find(x => (playerPuuid && x.player_puuid === playerPuuid) ||
      (x.player_display_name && x.player_display_name.toLowerCase() === idLower));
    if (s?.player_team) return s.player_team;
    if ((playerPuuid && k.victim_puuid === playerPuuid) || k.victim_display_name?.toLowerCase() === idLower) return k.victim_team || null;
    if ((playerPuuid && k.killer_puuid === playerPuuid) || k.killer_display_name?.toLowerCase() === idLower) return k.killer_team || null;
  }
  return null;
}

/**
 * Utility casts for one player-round: a number when the payload has it, null when unknown.
 * Henrik v4 per-round ability_casts are always null (260/260 player-rounds checked), so v4 gives null:
 * "no utility" must never be inferred from missing data.
 */
function getRoundUtilityCasts(roundStats) {
  if (!roundStats) return null;
  for (const v of [roundStats.ability_casts_count, roundStats.ability_casts]) {
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') {
      const nums = Object.values(v).filter(x => typeof x === 'number');
      if (nums.length) return nums.reduce((a, b) => a + b, 0);
    }
  }
  if (roundStats.spent_utility === true || roundStats.was_utility_used === true) return 1;
  if (roundStats.was_utility_used === false) return 0;
  return null;
}

function getEventClockDisplay(eventTimeMs, plantTimeMs) {
  const elapsedSec = (eventTimeMs || 0) / 1000;
  if (plantTimeMs != null && eventTimeMs >= plantTimeMs) {
    const elapsedSincePlantSec = (eventTimeMs - plantTimeMs) / 1000;
    const spikeRemainingSec = Math.max(0, Math.round(45 - elapsedSincePlantSec));
    return `${spikeRemainingSec}s spike remaining (post-plant)`;
  }
  return formatClock(elapsedSec);
}

/**
 * Analyzes a single round's kill events and telemetry snapshots for one player.
 * Returns all detected situation opportunities and events.
 */
function detectRoundSituations({
  matchId,
  roundNum,
  side,           // 'attack' or 'defense'
  role,           // Role of the agent played in THAT match
  killEvents = [],
  roundStats = null,
  playerRiotId,
  playerPuuid,
  plantEvents = []
}) {
  const situations = [];
  const riotIdLower = (playerRiotId || '').toLowerCase().trim();
  const isAttack = (side === 'attack');
  const isDefense = (side === 'defense');

  // Determine if a spike plant occurred and its timestamp
  // Only a real plant timestamp counts; a planted round without one is treated as no known plant time
  let plantTimeMs = null;
  if (plantEvents && plantEvents.length > 0 && plantEvents[0].round_time_in_ms != null) {
    plantTimeMs = plantEvents[0].round_time_in_ms;
  } else if (roundStats && roundStats.plant_time_in_ms != null) {
    plantTimeMs = roundStats.plant_time_in_ms;
  }

  // Filter round kills
  const roundKills = killEvents.filter(k => k.round === roundNum || k.round == null);

  // Identify first contact event in round (if any)
  const firstContact = roundKills.length > 0 ? roundKills[0] : null;

  // Track if player died in this round
  let playerDeathEvent = null;
  let playerDeathIdx = -1;

  for (let i = 0; i < roundKills.length; i++) {
    const k = roundKills[i];
    const isVictim = (playerPuuid && k.victim_puuid === playerPuuid) ||
                     (k.victim_display_name && k.victim_display_name.toLowerCase() === riotIdLower);
    if (isVictim) {
      playerDeathEvent = k;
      playerDeathIdx = i;
      break;
    }
  }

  // 1. OPENING CONTACT: LETS_TEAMMATES_ENTER_FIRST vs TAKES_SPACE (Attack, Duelist or Initiator)
  if (isAttack && (role === 'Duelist' || role === 'Initiator') && firstContact) {
    const fcTime = Number(firstContact.kill_time_in_round || 0) / 1000;
    const contactLoc = firstContact.victim_death_location;
    const snapshot = firstContact.player_locations_on_kill || [];

    // Check if player was alive at first contact
    const playerAliveAtContact = !playerDeathEvent || (Number(playerDeathEvent.kill_time_in_round || 0) >= Number(firstContact.kill_time_in_round || 0));

    if (playerAliveAtContact && contactLoc) {
      // Find player snapshot
      const playerSnap = snapshot.find(
        p => (playerPuuid && p.player_puuid === playerPuuid) ||
             (p.player_display_name && p.player_display_name.toLowerCase() === riotIdLower)
      );

      if (playerSnap && playerSnap.location) {
        const victimTeam = firstContact.victim_team;
        const playerTeam = playerSnap.player_team;

        // Alive teammates on player's team at first contact
        const aliveAllies = snapshot.filter(p => p.player_team === playerTeam && p.location);
        
        // Calculate each alive teammate's distance to contact location
        const allyDistances = aliveAllies.map(a => ({
          name: a.player_display_name,
          distMeters: Number((calculateDistance(a.location, contactLoc) / 100).toFixed(1))
        })).sort((a, b) => a.distMeters - b.distMeters);

        const playerRankAtContact = allyDistances.findIndex(
          a => (playerPuuid && a.name === playerPuuid) || (a.name && a.name.toLowerCase() === riotIdLower)
        );

        const playerDist = allyDistances.find(
          a => (playerPuuid && a.name === playerPuuid) || (a.name && a.name.toLowerCase() === riotIdLower)
        )?.distMeters || 0;

        if (playerRankAtContact >= 2) {
          // Player was NOT among the 2 nearest teammates
          situations.push({
            matchId,
            round: roundNum,
            side,
            role,
            tag: 'LETS_TEAMMATES_ENTER_FIRST',
            polarity: 'flaw',
            evidence: {
              playerDistMeters: playerDist,
              nearestTwoDistsMeters: allyDistances.slice(0, 2).map(x => x.distMeters),
              elapsedSec: fcTime,
              teammatesAhead: playerRankAtContact
            },
            clockDisplay: getEventClockDisplay(firstContact.kill_time_in_round, plantTimeMs),
            feature_version: FEATURE_VERSION
          });
        } else if (playerRankAtContact >= 0 && playerRankAtContact < 2) {
          // Positive twin: TAKES_SPACE
          situations.push({
            matchId,
            round: roundNum,
            side,
            role,
            tag: 'TAKES_SPACE',
            polarity: 'positive',
            evidence: {
              playerDistMeters: playerDist,
              elapsedSec: fcTime,
              proximityRank: playerRankAtContact + 1
            },
            clockDisplay: getEventClockDisplay(firstContact.kill_time_in_round, plantTimeMs),
            feature_version: FEATURE_VERSION
          });
        }
      }
    }
  }

  // 2. OPENING DUEL PARTICIPATION & WIN/LOSS (Duelist)
  if (role === 'Duelist' && firstContact) {
    const isPlayerKiller = (playerPuuid && firstContact.killer_puuid === playerPuuid) ||
                           (firstContact.killer_display_name && firstContact.killer_display_name.toLowerCase() === riotIdLower);
    const isPlayerVictim = (playerPuuid && firstContact.victim_puuid === playerPuuid) ||
                           (firstContact.victim_display_name && firstContact.victim_display_name.toLowerCase() === riotIdLower);

    if (isPlayerKiller) {
      situations.push({
        matchId,
        round: roundNum,
        side,
        role,
        tag: 'OPENING_DUEL_WIN',
        polarity: 'positive',
        evidence: {
          victim: firstContact.victim_display_name,
          weapon: firstContact.damage_weapon_name,
          elapsedSec: (Number(firstContact.kill_time_in_round || 0) / 1000)
        },
        clockDisplay: getEventClockDisplay(firstContact.kill_time_in_round, plantTimeMs),
        feature_version: FEATURE_VERSION
      });
    } else if (isPlayerVictim) {
      situations.push({
        matchId,
        round: roundNum,
        side,
        role,
        tag: 'OPENING_DUEL_LOSS',
        polarity: 'flaw',
        evidence: {
          killer: firstContact.killer_display_name,
          weapon: firstContact.damage_weapon_name,
          elapsedSec: (Number(firstContact.kill_time_in_round || 0) / 1000)
        },
        clockDisplay: getEventClockDisplay(firstContact.kill_time_in_round, plantTimeMs),
        feature_version: FEATURE_VERSION
      });
    }
  }

  // 3. SITUATIONS ON PLAYER DEATH (Solo Hold, Dry-Peek, Unsupported Entry, Backstab, Isolated)
  if (playerDeathEvent) {
    const deathTimeMs = Number(playerDeathEvent.kill_time_in_round || 0);
    const deathTimeSec = deathTimeMs / 1000;
    const isPostPlantDeath = (plantTimeMs != null && deathTimeMs >= plantTimeMs);
    const deathClockDisplay = getEventClockDisplay(deathTimeMs, plantTimeMs);
    const deathLoc = playerDeathEvent.victim_death_location;
    const snapshot = playerDeathEvent.player_locations_on_kill || [];
    const victimTeam = playerDeathEvent.victim_team;

    const victimSnap = snapshot.find(
      p => (playerPuuid && p.player_puuid === playerPuuid) ||
           (p.player_display_name && p.player_display_name.toLowerCase() === riotIdLower)
    );
    const killerSnap = snapshot.find(
      p => (playerDeathEvent.killer_puuid && p.player_puuid === playerDeathEvent.killer_puuid) ||
           (p.player_display_name && p.player_display_name.toLowerCase() === (playerDeathEvent.killer_display_name || '').toLowerCase())
    );

    // Teammates and enemies in snapshot
    const aliveTeammates = snapshot.filter(
      p => p.player_team === victimTeam &&
           p.player_display_name && p.player_display_name.toLowerCase() !== riotIdLower
    );
    const aliveEnemies = snapshot.filter(p => p.player_team !== victimTeam);

    let minTeammateDistMeters = Infinity;
    for (const tm of aliveTeammates) {
      if (deathLoc && tm.location) {
        const d = calculateDistance(deathLoc, tm.location) / 100;
        if (d < minTeammateDistMeters) minTeammateDistMeters = d;
      }
    }
    // Last alive (or no teammate position known): spacing can't be judged, so spacing-based tags stay silent
    const teammateKnown = minTeammateDistMeters !== Infinity;

    // Check if player was traded within 5s by a teammate
    let wasTraded = false;
    const killerNameLower = (playerDeathEvent.killer_display_name || '').toLowerCase();
    for (let j = playerDeathIdx + 1; j < roundKills.length; j++) {
      const nextK = roundKills[j];
      const timeDiffMs = (nextK.kill_time_in_round || 0) - (playerDeathEvent.kill_time_in_round || 0);
      if (timeDiffMs > 5000 || timeDiffMs < 0) break;
      if (nextK.victim_display_name && nextK.victim_display_name.toLowerCase() === killerNameLower &&
          nextK.killer_team === victimTeam) {
        wasTraded = true;
        break;
      }
    }

    // A. SOLO_HOLD_VS_STACK (Defense)
    if (isDefense && deathLoc && teammateKnown) {
      let enemiesWithin20m = 0;
      for (const en of aliveEnemies) {
        if (en.location) {
          const d = calculateDistance(deathLoc, en.location) / 100;
          if (d <= SPATIAL_CONFIG.SOLO_HOLD_ENEMY_DIST_METERS) {
            enemiesWithin20m += 1;
          }
        }
      }

      if (enemiesWithin20m >= SPATIAL_CONFIG.SOLO_HOLD_ENEMY_COUNT && minTeammateDistMeters > SPATIAL_CONFIG.SOLO_HOLD_NO_ALLY_DIST_METERS) {
        situations.push({
          matchId,
          round: roundNum,
          side,
          role,
          tag: 'SOLO_HOLD_VS_STACK',
          polarity: 'flaw',
          evidence: {
            enemiesNear: enemiesWithin20m,
            alliesNear: 0,
            enemiesWithin20m,
            nearestTeammateDistMeters: Number(minTeammateDistMeters.toFixed(1)),
            elapsedSec: deathTimeSec
          },
          clockDisplay: deathClockDisplay,
          feature_version: FEATURE_VERSION
        });
      } else if (enemiesWithin20m >= SPATIAL_CONFIG.SOLO_HOLD_ENEMY_COUNT && minTeammateDistMeters <= SPATIAL_CONFIG.SOLO_HOLD_NO_ALLY_DIST_METERS) {
        // Positive twin: ANCHORED_WITH_SUPPORT
        situations.push({
          matchId,
          round: roundNum,
          side,
          role,
          tag: 'ANCHORED_WITH_SUPPORT',
          polarity: 'positive',
          evidence: {
            enemiesNear: enemiesWithin20m,
            alliesNear: aliveTeammates.length,
            enemiesWithin20m,
            nearestTeammateDistMeters: Number(minTeammateDistMeters.toFixed(1)),
            elapsedSec: deathTimeSec
          },
          clockDisplay: deathClockDisplay,
          feature_version: FEATURE_VERSION
        });
      }
    }

    // B. DRY-PEEK & SINGLE CONDITION VARIANTS (elapsed < 22s)
    const isEarly = (deathTimeSec > 0 && deathTimeSec < SPATIAL_CONFIG.DRY_PEEK_WINDOW_SEC);
    const hasNoNearbyAlly = (minTeammateDistMeters > SPATIAL_CONFIG.DRY_PEEK_NO_ALLY_DIST_METERS);
    const utilityCasts = getRoundUtilityCasts(roundStats);
    const utilityKnown = utilityCasts != null;
    const hadUtilityCast = utilityKnown && utilityCasts > 0;

    // DRY_PEEK needs KNOWN zero utility. No-ally deaths with utility used or unknown -> EARLY_DEATH_NO_ALLY.
    if (isEarly && teammateKnown) {
      if (hasNoNearbyAlly && utilityKnown && !hadUtilityCast) {
        situations.push({
          matchId,
          round: roundNum,
          side,
          role,
          tag: 'DRY_PEEK',
          polarity: 'flaw',
          evidence: {
            elapsedSec: deathTimeSec,
            nearestAllyDistMeters: Number(minTeammateDistMeters.toFixed(1)),
            hadUtilityCast: false
          },
          clockDisplay: deathClockDisplay,
          feature_version: FEATURE_VERSION
        });
      } else if (hasNoNearbyAlly) {
        // Single condition tag: no teammate near; utility used or not recorded
        situations.push({
          matchId,
          round: roundNum,
          side,
          role,
          tag: 'EARLY_DEATH_NO_ALLY',
          polarity: 'flaw',
          evidence: {
            elapsedSec: deathTimeSec,
            nearestAllyDistMeters: Number(minTeammateDistMeters.toFixed(1)),
            hadUtilityCast: utilityKnown ? true : null
          },
          clockDisplay: deathClockDisplay,
          feature_version: FEATURE_VERSION
        });
      } else if (utilityKnown && !hadUtilityCast) {
        // Single condition tag: teammate near, known zero utility
        situations.push({
          matchId,
          round: roundNum,
          side,
          role,
          tag: 'EARLY_DEATH_NO_UTILITY',
          polarity: 'flaw',
          evidence: {
            elapsedSec: deathTimeSec,
            nearestAllyDistMeters: Number(minTeammateDistMeters.toFixed(1)),
            hadUtilityCast: false
          },
          clockDisplay: deathClockDisplay,
          feature_version: FEATURE_VERSION
        });
      }
    }

    // C. UNSUPPORTED_ENTRY vs SUPPORTED_ENTRY (Duelists on Attack, death < 25s with 0 allies <= 15m)
    // Requirement 5: Skip for events after spike is planted
    const isEntryWindow = (deathTimeSec > 0 && deathTimeSec < 25);
    if (role === 'Duelist' && isAttack && isEntryWindow && !isPostPlantDeath && teammateKnown) {
      if (hasNoNearbyAlly && !wasTraded) {
        situations.push({
          matchId,
          round: roundNum,
          side,
          role,
          tag: 'UNSUPPORTED_ENTRY',
          polarity: 'flaw',
          evidence: {
            elapsedSec: deathTimeSec,
            nearestAllyDistMeters: Number(minTeammateDistMeters.toFixed(1)),
            wasTraded: false
          },
          clockDisplay: deathClockDisplay,
          feature_version: FEATURE_VERSION
        });
      } else if (!hasNoNearbyAlly || wasTraded) {
        // Positive twin: SUPPORTED_ENTRY
        situations.push({
          matchId,
          round: roundNum,
          side,
          role,
          tag: 'SUPPORTED_ENTRY',
          polarity: 'positive',
          evidence: {
            elapsedSec: deathTimeSec,
            nearestAllyDistMeters: Number(minTeammateDistMeters.toFixed(1)),
            wasTraded
          },
          clockDisplay: deathClockDisplay,
          feature_version: FEATURE_VERSION
        });
      }
    }

    // D. ISOLATED_PLAY vs STAYS_WITH_TEAM vs POST_PLANT_ISOLATION (Initiator & Controller only on Attack)
    if (isAttack && (role === 'Initiator' || role === 'Controller') && deathLoc && teammateKnown) {
      if (isPostPlantDeath) {
        // Requirement 5: Skip ISOLATED_* after spike plant; add POST_PLANT_ISOLATION as info-only tag
        if (minTeammateDistMeters > SPATIAL_CONFIG.ISOLATED_ALLY_DIST_METERS) {
          situations.push({
            matchId,
            round: roundNum,
            side,
            role,
            tag: 'POST_PLANT_ISOLATION',
            polarity: 'info',
            evidence: {
              outcome: 'death',
              eventType: 'death',
              nearestAllyDistMeters: Number(minTeammateDistMeters.toFixed(1)),
              elapsedSec: deathTimeSec,
              postPlant: true
            },
            clockDisplay: deathClockDisplay,
            feature_version: FEATURE_VERSION
          });
        }
      } else {
        if (minTeammateDistMeters > SPATIAL_CONFIG.ISOLATED_ALLY_DIST_METERS) {
          situations.push({
            matchId,
            round: roundNum,
            side,
            role,
            tag: 'ISOLATED_PLAY',
            polarity: 'flaw',
            evidence: {
              outcome: 'death',
              eventType: 'death',
              nearestAllyDistMeters: Number(minTeammateDistMeters.toFixed(1)),
              elapsedSec: deathTimeSec
            },
            clockDisplay: deathClockDisplay,
            feature_version: FEATURE_VERSION
          });
        } else if (minTeammateDistMeters <= 15) {
          situations.push({
            matchId,
            round: roundNum,
            side,
            role,
            tag: 'STAYS_WITH_TEAM',
            polarity: 'positive',
            evidence: {
              outcome: 'death',
              eventType: 'death',
              nearestAllyDistMeters: Number(minTeammateDistMeters.toFixed(1)),
              elapsedSec: deathTimeSec
            },
            clockDisplay: deathClockDisplay,
            feature_version: FEATURE_VERSION
          });
        }
      }
    }

    // E. BACKSTAB_DEATHS vs CROSSHAIR_FACING_DUEL
    // Requirement 1: Enable BACKSTAB_DEATH only when victim view_radians exists; otherwise "not available" (never a flag)
    if (victimSnap && victimSnap.view_radians != null && killerSnap && killerSnap.location && deathLoc) {
      const dx = killerSnap.location.x - deathLoc.x;
      const dy = killerSnap.location.y - deathLoc.y;
      const bearingToKiller = Math.atan2(dy, dx);
      const angleDiffRad = wrapAngleToPi(bearingToKiller - victimSnap.view_radians);
      const angleDiffDeg = Number((angleDiffRad * (180 / Math.PI)).toFixed(1));

      if (angleDiffDeg > 85.0) {
        situations.push({
          matchId,
          round: roundNum,
          side,
          role,
          tag: 'BACKSTAB_DEATH',
          polarity: 'flaw',
          evidence: {
            angleDeg: angleDiffDeg,
            killer: playerDeathEvent.killer_display_name,
            elapsedSec: deathTimeSec
          },
          clockDisplay: deathClockDisplay,
          feature_version: FEATURE_VERSION
        });
      } else if (angleDiffDeg <= 45.0) {
        situations.push({
          matchId,
          round: roundNum,
          side,
          role,
          tag: 'CROSSHAIR_FACING_DUEL',
          polarity: 'positive',
          evidence: {
            angleDeg: angleDiffDeg,
            killer: playerDeathEvent.killer_display_name,
            elapsedSec: deathTimeSec
          },
          clockDisplay: deathClockDisplay,
          feature_version: FEATURE_VERSION
        });
      }
    }

    // D3. Sentinel Lurk Timing on Death (Attack)
    // Section 3: Flank/lurk is EXPECTED for Sentinel. Flag unsynced early lurk death (died before team made contact).
    if (isAttack && role === 'Sentinel' && deathLoc && teammateKnown) {
      if (minTeammateDistMeters >= 30.0) {
        const deathTimeMs = Number(playerDeathEvent.kill_time_in_round || 0);
        const teammateContacts = [];
        for (const k of roundKills) {
          const isKMyKill = (playerPuuid && k.killer_puuid === playerPuuid) || (k.killer_display_name?.toLowerCase() === riotIdLower);
          const isKMyDeath = (playerPuuid && k.victim_puuid === playerPuuid) || (k.victim_display_name?.toLowerCase() === riotIdLower);
          if (!isKMyKill && !isKMyDeath && (k.killer_team === victimTeam || k.victim_team === victimTeam)) {
            teammateContacts.push(Number(k.kill_time_in_round || 0));
          }
        }
        if (plantTimeMs != null) teammateContacts.push(Number(plantTimeMs));

        const isSynced = teammateContacts.some(t => Math.abs(deathTimeMs - t) <= 10000);
        const earliestContact = teammateContacts.length > 0 ? Math.min(...teammateContacts) : Infinity;
        const diedBeforeTeamContact = deathTimeMs < (earliestContact - 10000);

        if (!isSynced && (diedBeforeTeamContact || teammateContacts.length === 0)) {
          situations.push({
            matchId,
            round: roundNum,
            side,
            role,
            tag: 'UNSYNCED_LURK_DEATH',
            polarity: 'flaw',
            evidence: {
              nearestAllyDistMeters: Number(minTeammateDistMeters.toFixed(1)),
              elapsedSec: deathTimeSec,
              earliestContactSec: earliestContact === Infinity ? null : Number((earliestContact / 1000).toFixed(1)),
              lurkDistanceMeters: Number(minTeammateDistMeters.toFixed(1))
            },
            clockDisplay: deathClockDisplay,
            feature_version: FEATURE_VERSION
          });
        }
      }
    }
  } // End of if (playerDeathEvent)

  // D2. ISOLATED_PLAY vs STAYS_WITH_TEAM on Kill Snapshots (Initiator & Controller Attack only)
  if (isAttack && (role === 'Initiator' || role === 'Controller')) {
    for (const k of roundKills) {
      const isPlayerKiller = (playerPuuid && k.killer_puuid === playerPuuid) ||
                             (k.killer_display_name && k.killer_display_name.toLowerCase() === riotIdLower);
      if (isPlayerKiller && k.player_locations_on_kill) {
        const snap = k.player_locations_on_kill;
        const mySnap = snap.find(
          p => (playerPuuid && p.player_puuid === playerPuuid) ||
               (p.player_display_name && p.player_display_name.toLowerCase() === riotIdLower)
        );
        if (mySnap && mySnap.location) {
          const myTeam = mySnap.player_team;
          const aliveAllies = snap.filter(
            p => p.player_team === myTeam &&
                 p.player_display_name && p.player_display_name.toLowerCase() !== riotIdLower
          );
          let minAllyDistMeters = Infinity;
          for (const a of aliveAllies) {
            if (a.location) {
              const d = calculateDistance(mySnap.location, a.location) / 100;
              if (d < minAllyDistMeters) minAllyDistMeters = d;
            }
          }
          if (aliveAllies.length > 0 && minAllyDistMeters !== Infinity) {
            const killTimeMs = Number(k.kill_time_in_round || 0);
            const killTimeSec = killTimeMs / 1000;
            const isPostPlantKill = (plantTimeMs != null && killTimeMs >= plantTimeMs);
            const killClockDisplay = getEventClockDisplay(killTimeMs, plantTimeMs);

            if (isPostPlantKill) {
              if (minAllyDistMeters > SPATIAL_CONFIG.ISOLATED_ALLY_DIST_METERS) {
                situations.push({
                  matchId,
                  round: roundNum,
                  side,
                  role,
                  tag: 'POST_PLANT_ISOLATION',
                  polarity: 'info',
                  evidence: {
                    outcome: 'kill',
                    nearestAllyDistMeters: Number(minAllyDistMeters.toFixed(1)),
                    elapsedSec: killTimeSec,
                    postPlant: true
                  },
                  clockDisplay: killClockDisplay,
                  feature_version: FEATURE_VERSION
                });
              }
            } else {
              if (minAllyDistMeters > SPATIAL_CONFIG.ISOLATED_ALLY_DIST_METERS) {
                situations.push({
                  matchId,
                  round: roundNum,
                  side,
                  role,
                  tag: 'ISOLATED_PLAY',
                  polarity: 'flaw',
                  evidence: {
                    outcome: 'kill',
                    nearestAllyDistMeters: Number(minAllyDistMeters.toFixed(1)),
                    elapsedSec: killTimeSec
                  },
                  clockDisplay: killClockDisplay,
                  feature_version: FEATURE_VERSION
                });
              } else if (minAllyDistMeters <= 15) {
                situations.push({
                  matchId,
                  round: roundNum,
                  side,
                  role,
                  tag: 'STAYS_WITH_TEAM',
                  polarity: 'positive',
                  evidence: {
                    outcome: 'kill',
                    nearestAllyDistMeters: Number(minAllyDistMeters.toFixed(1)),
                    elapsedSec: killTimeSec
                  },
                  clockDisplay: killClockDisplay,
                  feature_version: FEATURE_VERSION
                });
              }
            }
          }
        }
      }
    }
  }

  // D4. Sentinel Lurk Timing on Kill Snapshots (Attack)
  // Positive twin: SYNCED_LURK_KILL (flank frag within +-10s of team contact)
  if (isAttack && role === 'Sentinel') {
    for (const k of roundKills) {
      const isPlayerKiller = (playerPuuid && k.killer_puuid === playerPuuid) ||
                             (k.killer_display_name && k.killer_display_name.toLowerCase() === riotIdLower);
      if (isPlayerKiller && k.player_locations_on_kill) {
        const snap = k.player_locations_on_kill;
        const mySnap = snap.find(
          p => (playerPuuid && p.player_puuid === playerPuuid) ||
               (p.player_display_name && p.player_display_name.toLowerCase() === riotIdLower)
        );
        if (mySnap && mySnap.location) {
          const myTeam = mySnap.player_team;
          const aliveAllies = snap.filter(
            p => p.player_team === myTeam &&
                 p.player_display_name && p.player_display_name.toLowerCase() !== riotIdLower
          );
          let minAllyDistMeters = Infinity;
          for (const a of aliveAllies) {
            if (a.location) {
              const d = calculateDistance(mySnap.location, a.location) / 100;
              if (d < minAllyDistMeters) minAllyDistMeters = d;
            }
          }
          if (minAllyDistMeters !== Infinity && minAllyDistMeters >= 30.0) {
            const killTimeMs = Number(k.kill_time_in_round || 0);
            const killTimeSec = killTimeMs / 1000;
            const killClockDisplay = getEventClockDisplay(killTimeMs, plantTimeMs);

            const teammateContacts = [];
            for (const otherK of roundKills) {
              const isOtherMe = (otherK === k);
              if (!isOtherMe && (otherK.killer_team === myTeam || otherK.victim_team === myTeam)) {
                teammateContacts.push(Number(otherK.kill_time_in_round || 0));
              }
            }
            if (plantTimeMs != null) teammateContacts.push(Number(plantTimeMs));

            const isSynced = teammateContacts.some(t => Math.abs(killTimeMs - t) <= 10000);
            if (isSynced) {
              situations.push({
                matchId,
                round: roundNum,
                side,
                role,
                tag: 'SYNCED_LURK_KILL',
                polarity: 'positive',
                evidence: {
                  nearestAllyDistMeters: Number(minAllyDistMeters.toFixed(1)),
                  elapsedSec: killTimeSec,
                  lurkDistanceMeters: Number(minAllyDistMeters.toFixed(1)),
                  syncedWithContact: true
                },
                clockDisplay: killClockDisplay,
                feature_version: FEATURE_VERSION
              });
            }
          }
        }
      }
    }
  }

  // 4. GATED TRADE OPPORTUNITIES (0f: TRADES_WELL vs DOESNT_TRADE)
  // Evaluated when an ALLY dies
  for (let i = 0; i < roundKills.length; i++) {
    const k = roundKills[i];
    const isVictimPlayer = (playerPuuid && k.victim_puuid === playerPuuid) ||
                           (k.victim_display_name && k.victim_display_name.toLowerCase() === riotIdLower);
    
    // Check if victim was an ally
    if (!isVictimPlayer && k.victim_team && k.victim_death_location) {
      const snapshot = k.player_locations_on_kill || [];
      const victimTeam = k.victim_team;

      // Find player in snapshot
      const playerSnap = snapshot.find(
        p => (playerPuuid && p.player_puuid === playerPuuid) ||
             (p.player_display_name && p.player_display_name.toLowerCase() === riotIdLower)
      );

      // Find killer in snapshot
      const killerSnap = snapshot.find(
        p => (k.killer_puuid && p.player_puuid === k.killer_puuid) ||
             (p.player_display_name && p.player_display_name.toLowerCase() === (k.killer_display_name || '').toLowerCase())
      );

      if (playerSnap && playerSnap.player_team === victimTeam && playerSnap.location) {
        const allyDeathLoc = k.victim_death_location;
        const allyDistMeters = calculateDistance(playerSnap.location, allyDeathLoc) / 100;
        
        let killerDistMeters = Infinity;
        let angleToKillerDeg = 0;
        let isWithinViewCone = true;

        if (killerSnap && killerSnap.location) {
          killerDistMeters = calculateDistance(playerSnap.location, killerSnap.location) / 100;

          // If player view angle is available, check +/- 60 deg cone
          if (playerSnap.view_radians != null) {
            const kdx = killerSnap.location.x - playerSnap.location.x;
            const kdy = killerSnap.location.y - playerSnap.location.y;
            const bearingToKiller = Math.atan2(kdy, kdx);
            const viewDiffRad = wrapAngleToPi(bearingToKiller - playerSnap.view_radians);
            angleToKillerDeg = Number((viewDiffRad * (180 / Math.PI)).toFixed(1));
            isWithinViewCone = (angleToKillerDeg <= SPATIAL_CONFIG.KILLER_TRADE_MAX_VIEW_ANGLE_DEG);
          }
        }

        // Gated Trade Opportunity Criteria (0f):
        // 1. Ally died within 15m
        // 2. Killer within 25m of player
        // 3. Killer inside player's +/- 60 deg view cone
        const isGatedOpportunity = (
          allyDistMeters <= SPATIAL_CONFIG.ALLY_TRADE_MAX_DIST_METERS &&
          killerDistMeters <= SPATIAL_CONFIG.KILLER_TRADE_MAX_DIST_METERS &&
          isWithinViewCone
        );

        if (isGatedOpportunity) {
          // Check if player killed the killer within 5s
          let playerTradedKiller = false;
          const deathTimeMs = Number(k.kill_time_in_round || 0);
          const killerNameLower = (k.killer_display_name || '').toLowerCase();

          for (let j = i + 1; j < roundKills.length; j++) {
            const nextK = roundKills[j];
            const timeDiff = (nextK.kill_time_in_round || 0) - deathTimeMs;
            if (timeDiff > SPATIAL_CONFIG.TRADE_TIME_WINDOW_MS || timeDiff < 0) break;
            
            const isKillerKilled = nextK.victim_display_name && nextK.victim_display_name.toLowerCase() === killerNameLower;
            const isPlayerRevenge = (playerPuuid && nextK.killer_puuid === playerPuuid) ||
                                    (nextK.killer_display_name && nextK.killer_display_name.toLowerCase() === riotIdLower);

            if (isKillerKilled && isPlayerRevenge) {
              playerTradedKiller = true;
              break;
            }
          }

          if (playerTradedKiller) {
            situations.push({
              matchId,
              round: roundNum,
              side,
              role,
              tag: 'TRADES_WELL',
              polarity: 'positive',
              evidence: {
                allyDistMeters: Number(allyDistMeters.toFixed(1)),
                killerDistMeters: Number(killerDistMeters.toFixed(1)),
                angleToKillerDeg,
                tradedWithin5s: true,
                allyVictim: k.victim_display_name,
                killerEliminated: k.killer_display_name
              },
              clockDisplay: getEventClockDisplay(k.kill_time_in_round, plantTimeMs),
              feature_version: FEATURE_VERSION
            });
          } else {
            situations.push({
              matchId,
              round: roundNum,
              side,
              role,
              tag: 'DOESNT_TRADE',
              polarity: 'flaw',
              evidence: {
                allyDistMeters: Number(allyDistMeters.toFixed(1)),
                killerDistMeters: Number(killerDistMeters.toFixed(1)),
                angleToKillerDeg,
                tradedWithin5s: false,
                allyVictim: k.victim_display_name,
                killerEscaped: k.killer_display_name
              },
              clockDisplay: getEventClockDisplay(k.kill_time_in_round, plantTimeMs),
              feature_version: FEATURE_VERSION
            });
          }
        }
      }
    }
  }

  return situations;
}

module.exports = {
  detectRoundSituations,
  wrapAngleToPi,
  calculateDistance,
  formatClock,
  getEventClockDisplay,
  getSideForRound,
  groupKillsByRound,
  getPlayerTeam,
  getRoundUtilityCasts
};
