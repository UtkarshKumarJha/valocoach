const valorantApiService = require('./valorantApiService');
const Player = require('../models/Player');
const Match = require('../models/Match');
const { isSupportedQueue } = require('../config/telemetryConfig');

exports.ingestPlayerData = async (region, name, tag) => {
  try {
    // 1. Fetch MMR Data
    const mmrData = await valorantApiService.fetchPlayerMmr(region, name, tag);
    const mmrParsed = mmrData.data;

    // Build unique Riot ID
    const riotId = `${name}#${tag}`.toLowerCase();

    // 2. Upsert Player Model
    let player = await Player.findOne({ riotId });
    if (!player) {
      player = new Player({
        riotId,
        name: mmrParsed.name,
        tag: mmrParsed.tag,
        region,
        puuid: mmrParsed.puuid || ''
      });
    }

    player.currentRank = mmrParsed.current_data?.currenttierpatched || 'Unranked';
    player.currentRR = mmrParsed.current_data?.ranking_in_tier || 0;
    player.lastUpdated = new Date();
    await player.save();

    console.log(`Player ${riotId} updated/created in DB.`);

    // 3. Fetch Matches
    const matchesData = await valorantApiService.fetchPlayerMatches(region, name, tag, 10);
    const matches = matchesData.data || [];

    let newMatchesCount = 0;
    const skippedMatches = [];

    // 4. Process Matches
    for (const matchInfo of matches) {
      if (!matchInfo || !matchInfo.metadata) {
        console.log(`Skipping corrupted match data for ${riotId}`);
        continue;
      }
      const matchId = matchInfo.metadata.matchid;
      
      // 0a. Mode gating: SUPPORTED_QUEUES (competitive, unrated, premier)
      const queueCheck = isSupportedQueue(matchInfo);
      if (!queueCheck.supported) {
        console.log(`Skipping match ${matchId}: ${queueCheck.reason}`);
        skippedMatches.push({
          matchId: matchId || 'unknown',
          reason: queueCheck.reason || 'unsupported_mode'
        });
        continue;
      }
      
      // Check if match already exists
      const existingMatch = await Match.findOne({ matchId, player: player._id });
      if (existingMatch) continue;

      // Find the specific player's stats in the match
      const playerStats = matchInfo.players.all_players.find(
        p => (player.puuid && p.puuid === player.puuid) ||
             (p.name && p.tag && p.name.toLowerCase() === player.name.toLowerCase() && p.tag.toLowerCase() === player.tag.toLowerCase())
      );

      if (!playerStats) continue;

      // Determine match outcome for this player
      let matchOutcome = 'Draw';
      const playerTeam = playerStats.team; // 'Red' or 'Blue'
      const winningTeam = matchInfo.teams.red.has_won ? 'Red' : (matchInfo.teams.blue.has_won ? 'Blue' : null);
      if (winningTeam) {
          matchOutcome = playerTeam === winningTeam ? 'Win' : 'Loss';
      }

      // Calculate total shots for Headshot percentage
      const shots = playerStats.stats.headshots + playerStats.stats.bodyshots + playerStats.stats.legshots;
      const headshotPct = shots > 0 ? playerStats.stats.headshots / shots : 0;

      // Extract per-round data for this specific player
      const extractedRounds = (matchInfo.rounds || []).map(r => {
        const pRoundStats = (r.player_stats || []).find(
          ps => (player.puuid && ps.player_puuid === player.puuid) ||
                (ps.player_display_name && ps.player_display_name.toLowerCase() === player.riotId.toLowerCase())
        );

        return {
          winning_team: r.winning_team,
          end_type: r.end_type,
          bomb_planted: r.bomb_planted,
          bomb_defused: r.bomb_defused,
          player_stats: pRoundStats ? {
            kills: pRoundStats.kills,
            score: pRoundStats.score,
            damage: pRoundStats.damage,
            weapon: {
              id: pRoundStats.economy?.weapon?.id,
              name: pRoundStats.economy?.weapon?.name
            },
            economy: {
              loadout_value: pRoundStats.economy?.loadout_value,
              spent: pRoundStats.economy?.spent,
              remaining: pRoundStats.economy?.remaining
            },
            was_afk: pRoundStats.was_afk,
            stayed_in_spawn: pRoundStats.stayed_in_spawn
          } : null
        };
      });

      // Extract all kill events in the match for tactical analysis
      const extractedKills = (matchInfo.kills || []).map(k => {
        const victimProfile = matchInfo.players.all_players.find(
           p => (k.victim_puuid && p.puuid === k.victim_puuid) ||
                (`${p.name}#${p.tag}`.toLowerCase() === (k.victim_display_name || '').toLowerCase())
        );
        const victimTier = (victimProfile && (victimProfile.currenttier_patched || victimProfile.currenttierpatched)) || 'Silver';
        return {
          kill_time_in_round: k.kill_time_in_round,
          kill_time_in_match: k.kill_time_in_match,
          killer_display_name: k.killer_display_name,
          killer_team: k.killer_team,
          victim_display_name: k.victim_display_name,
          victim_team: k.victim_team,
          victim_tier: victimTier,
          victim_death_location: k.victim_death_location,
          damage_weapon_name: k.damage_weapon_name,
          player_locations_on_kill: (k.player_locations_on_kill || []).map(loc => ({
            player_display_name: loc.player_display_name,
            player_team: loc.player_team,
            location: loc.location,
            view_radians: loc.view_radians
          }))
        };
      });

      // Create new Match document
      const newMatch = new Match({
        matchId,
        player: player._id,
        map: matchInfo.metadata.map,
        agent: playerStats.character,
        kills: playerStats.stats.kills,
        deaths: playerStats.stats.deaths,
        assists: playerStats.stats.assists,
        score: playerStats.stats.score, // This is total score, ACS would be score/rounds
        damage: {
          made: playerStats.damage_made,
          received: playerStats.damage_received
        },
        acs: matchInfo.metadata.rounds_played > 0 ? playerStats.stats.score / matchInfo.metadata.rounds_played : 0,
        shots: {
          head: playerStats.stats.headshots,
          body: playerStats.stats.bodyshots,
          leg: playerStats.stats.legshots
        },
        ability_cast_pr: {
          c_cast: matchInfo.metadata.rounds_played > 0 ? (playerStats.ability_casts?.c_cast || 0) / matchInfo.metadata.rounds_played : 0,
          q_cast: matchInfo.metadata.rounds_played > 0 ? (playerStats.ability_casts?.q_cast || 0) / matchInfo.metadata.rounds_played : 0,
          e_cast: matchInfo.metadata.rounds_played > 0 ? (playerStats.ability_casts?.e_cast || 0) / matchInfo.metadata.rounds_played : 0,
          x_cast: matchInfo.metadata.rounds_played > 0 ? (playerStats.ability_casts?.x_cast || 0) / matchInfo.metadata.rounds_played : 0
        },
        afk_rounds: playerStats.behavior?.afk_rounds || 0,
        economy: {
          spent: playerStats.economy?.spent?.average || 0,
          loadout_value: playerStats.economy?.loadout_value?.average || 0,
        },
        headshotPct,
        matchOutcome,
        tier: playerStats.currenttier_patched || playerStats.currenttierpatched || 'Unranked',
        playedAt: new Date(matchInfo.metadata.game_start * 1000),
        rounds: extractedRounds,
        kill_events: extractedKills
      });

      await newMatch.save();
      newMatchesCount++;
    }

    console.log(`Ingested ${newMatchesCount} new matches for ${riotId}.`);

    return {
      message: 'Ingestion successful',
      player: player.riotId,
      newMatchesAdded: newMatchesCount,
      skippedMatchesCount: skippedMatches.length,
      skippedMatches
    };
  } catch (error) {
    console.error('Error during ingestion process:', error);
    throw new Error('Data ingestion failed');
  }
};
