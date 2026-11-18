/**
 * Henrik v4 Payload Normalization Adapter & Schema Validator
 * Unifies all match ingestion and telemetry intelligence onto the Henrik v4 match schema.
 */

const { getRoleForAgent } = require('../services/agentRoleService');

/**
 * Validates that an object conforms to the internal normalized Match schema.
 * @param {Object} match Normalized match object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateNormalizedMatch(match) {
  const errors = [];

  if (!match || typeof match !== 'object') {
    return { valid: false, errors: ['Match must be a non-null object.'] };
  }

  if (!match.matchId || typeof match.matchId !== 'string') {
    errors.push('Missing or invalid matchId.');
  }

  if (!match.map || typeof match.map !== 'string') {
    errors.push('Missing or invalid map.');
  }

  if (!Array.isArray(match.all_players) || match.all_players.length === 0) {
    errors.push('Missing or empty all_players array.');
  } else {
    for (let i = 0; i < match.all_players.length; i++) {
      const p = match.all_players[i];
      if (!p.puuid || !p.character || !p.team) {
        errors.push(`Player at index ${i} missing required puuid, character, or team.`);
        break;
      }
    }
  }

  if (!Array.isArray(match.rounds) || match.rounds.length === 0) {
    errors.push('Missing or empty rounds array.');
  }

  if (!Array.isArray(match.kill_events)) {
    errors.push('Missing kill_events array.');
  } else {
    for (let i = 0; i < match.kill_events.length; i++) {
      const k = match.kill_events[i];
      if (typeof k.round !== 'number' || k.kill_time_in_round === undefined || !k.victim_death_location) {
        errors.push(`Kill event at index ${i} missing round, kill_time_in_round, or victim_death_location.`);
        break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Normalizes a raw Henrik v4 match payload into the internal ValoCoach Match schema.
 * @param {Object} rawV4 Raw Henrik v4 match payload
 * @param {string} targetRiotIdOrPuuid Identifier of the target player (e.g. 'Name#TAG' or puuid)
 * @returns {Object} Normalized match object
 */
function normalizeV4Match(rawV4, targetRiotIdOrPuuid = '') {
  if (!rawV4 || !rawV4.metadata) {
    throw new Error('Invalid Henrik v4 match payload: missing metadata.');
  }

  const meta = rawV4.metadata;
  const matchId = meta.match_id || meta.matchid;
  const mapName = meta.map?.name || meta.map || 'Unknown';
  const queueId = meta.queue?.id || meta.mode_id || 'competitive';
  const modeName = meta.queue?.name || meta.mode || 'Competitive';
  const playedAt = meta.started_at ? new Date(meta.started_at) : (meta.game_start ? new Date(meta.game_start * 1000) : new Date());
  const gameLengthMs = meta.game_length_in_ms || (meta.game_length ? meta.game_length * 1000 : 0);

  // Normalize all 10 players
  const rawPlayers = rawV4.players || [];
  const allPlayers = rawPlayers.map(p => {
    const charName = p.agent?.name || p.character || 'Unknown';
    const puuid = p.puuid || '';
    const name = p.name || '';
    const tag = p.tag || '';
    const team = p.team_id || p.team || 'Red';
    const stats = p.stats || {};
    const headshots = stats.headshots || 0;
    const bodyshots = stats.bodyshots || 0;
    const legshots = stats.legshots || 0;
    const totalShots = headshots + bodyshots + legshots;
    const hsPct = totalShots > 0 ? Number((headshots / totalShots).toFixed(3)) : 0;

    return {
      puuid,
      name,
      tag,
      team,
      character: charName,
      role: getRoleForAgent(charName) || 'Unknown',
      tier: p.tier?.name || 'Unranked',
      stats: {
        score: stats.score || 0,
        kills: stats.kills || 0,
        deaths: stats.deaths || 0,
        assists: stats.assists || 0,
        headshots,
        bodyshots,
        legshots,
        headshotPct: hsPct
      }
    };
  });

  // Identify target player
  const searchId = (targetRiotIdOrPuuid || '').toLowerCase().trim();
  const targetPlayer = allPlayers.find(p => 
    (p.puuid && p.puuid.toLowerCase() === searchId) ||
    (`${p.name}#${p.tag}`.toLowerCase() === searchId) ||
    (p.name.toLowerCase() === searchId)
  ) || allPlayers[0] || null;

  // Determine winning team
  let winningTeam = 'Draw';
  if (Array.isArray(rawV4.teams)) {
    const winTeamObj = rawV4.teams.find(t => t.won || t.has_won);
    if (winTeamObj) winningTeam = winTeamObj.team_id || winTeamObj.team || 'Red';
  } else if (rawV4.teams && typeof rawV4.teams === 'object') {
    if (rawV4.teams.red?.has_won) winningTeam = 'Red';
    else if (rawV4.teams.blue?.has_won) winningTeam = 'Blue';
  }

  let matchOutcome = 'Draw';
  if (targetPlayer && winningTeam !== 'Draw') {
    matchOutcome = targetPlayer.team === winningTeam ? 'Win' : 'Loss';
  }

  // Normalize rounds with plant & defuse timestamps
  const rawRounds = rawV4.rounds || [];
  const rounds = rawRounds.map((r, idx) => {
    const roundNum = typeof r.id === 'number' ? (r.id + 1) : (typeof r.round === 'number' ? r.round : (idx + 1));
    const winTeam = r.result === 'Defused' || r.result === 'Eliminated' || r.result === 'Bomb defused' || r.result === 'Bomb detonated'
      ? (r.winning_team || (r.plant ? (r.result === 'Bomb defused' ? 'Blue' : 'Red') : 'Red'))
      : (r.winning_team || 'Red');

    const plantEvents = [];
    if (r.plant) {
      plantEvents.push({
        round_time_in_ms: r.plant.round_time_in_ms || 0,
        plant_time_in_round: r.plant.round_time_in_ms || 0,
        site: r.plant.site || 'Site',
        location: r.plant.location || null,
        planted_by: r.plant.player ? {
          puuid: r.plant.player.puuid,
          display_name: `${r.plant.player.name}#${r.plant.player.tag}`,
          team: r.plant.player.team
        } : null
      });
    }

    const defuseEvents = [];
    if (r.defuse) {
      defuseEvents.push({
        round_time_in_ms: r.defuse.round_time_in_ms || 0,
        defuse_time_in_round: r.defuse.round_time_in_ms || 0,
        defused_by: r.defuse.player ? {
          puuid: r.defuse.player.puuid,
          display_name: `${r.defuse.player.name}#${r.defuse.player.tag}`,
          team: r.defuse.player.team
        } : null
      });
    }

    return {
      round_num: roundNum,
      winning_team: winTeam,
      end_type: r.result || r.end_type || 'Eliminated',
      bomb_planted: Boolean(r.plant),
      bomb_defused: Boolean(r.defuse),
      plant_events: plantEvents,
      defuse_events: defuseEvents,
      player_stats: (r.stats || []).map(ps => ({
        player_puuid: ps.player?.puuid || ps.player_puuid,
        player_display_name: ps.player ? `${ps.player.name}#${ps.player.tag}` : (ps.player_display_name || ''),
        score: ps.stats?.score || ps.score || 0,
        kills: ps.stats?.kills || ps.kills || 0,
        damage: ps.stats?.damage?.dealt || ps.damage || 0,
        economy: ps.economy || {}
      }))
    };
  });

  // Normalize kill events
  const rawKills = rawV4.kills || rawV4.kill_events || [];
  const killEvents = rawKills.map(k => {
    const roundIdx = typeof k.round === 'number' ? k.round : 1;
    // Henrik v4 uses 0-indexed round in kills, or 1-indexed. Ensure it aligns with round_num
    const roundNum = (roundIdx === 0 || (roundIdx < rounds.length && rounds[0]?.round_num === 1 && roundIdx === rounds[roundIdx]?.round_num - 1))
      ? roundIdx + 1
      : roundIdx;

    const killTimeMs = k.time_in_round_in_ms !== undefined ? k.time_in_round_in_ms : (k.kill_time_in_round || 0);

    const killerPuuid = k.killer?.puuid || k.killer_puuid || '';
    const killerName = k.killer ? `${k.killer.name}#${k.killer.tag}` : (k.killer_display_name || 'Opponent');
    const killerTeam = k.killer?.team || k.killer_team || 'Red';

    const victimPuuid = k.victim?.puuid || k.victim_puuid || '';
    const victimName = k.victim ? `${k.victim.name}#${k.victim.tag}` : (k.victim_display_name || 'Opponent');
    const victimTeam = k.victim?.team || k.victim_team || 'Blue';

    const deathLoc = k.location || k.victim_death_location || { x: 0, y: 0 };
    const weaponName = k.weapon?.name || k.damage_weapon_name || 'Vandal';

    // Normalize player_locations_on_kill
    const rawLocs = k.player_locations || k.player_locations_on_kill || [];
    let playerLocs = rawLocs.map(pl => {
      const plPuuid = pl.player?.puuid || pl.player_puuid || '';
      const plName = pl.player ? `${pl.player.name}#${pl.player.tag}` : (pl.player_display_name || '');
      const plTeam = pl.player?.team || pl.player_team || 'Red';
      const loc = pl.location || { x: 0, y: 0 };
      const viewRad = pl.view_radians !== undefined ? pl.view_radians : null;

      return {
        player_puuid: plPuuid,
        player_display_name: plName,
        player_team: plTeam,
        location: loc,
        view_radians: viewRad
      };
    });

    // Synthesize victim into player_locations_on_kill if missing
    const hasVictimInLocs = playerLocs.some(pl => pl.player_puuid === victimPuuid || pl.player_display_name === victimName);
    if (!hasVictimInLocs && victimPuuid) {
      playerLocs.push({
        player_puuid: victimPuuid,
        player_display_name: victimName,
        player_team: victimTeam,
        location: deathLoc,
        view_radians: null,
        isVictim: true
      });
    }

    return {
      round: roundNum,
      kill_time_in_round: killTimeMs,
      killer_puuid: killerPuuid,
      killer_display_name: killerName,
      killer_team: killerTeam,
      victim_puuid: victimPuuid,
      victim_display_name: victimName,
      victim_team: victimTeam,
      victim_death_location: deathLoc,
      damage_weapon_name: weaponName,
      player_locations_on_kill: playerLocs
    };
  });

  const totalRoundsCount = Math.max(1, rounds.length);
  const targetKills = targetPlayer?.stats?.kills || 0;
  const targetDeaths = targetPlayer?.stats?.deaths || 0;
  const targetAssists = targetPlayer?.stats?.assists || 0;
  const targetScore = targetPlayer?.stats?.score || 0;
  const targetAcs = Math.round(targetScore / totalRoundsCount);
  const targetHsPct = targetPlayer?.stats?.headshotPct || 0;

  const normalized = {
    matchId,
    map: mapName,
    mode: modeName,
    queue: queueId,
    agent: targetPlayer?.character || 'Unknown',
    role: targetPlayer?.role || 'Unknown',
    kills: targetKills,
    deaths: targetDeaths,
    assists: targetAssists,
    score: targetScore,
    acs: targetAcs,
    headshotPct: targetHsPct,
    matchOutcome,
    tier: targetPlayer?.tier || 'Unranked',
    playedAt,
    gameLengthMs,
    player_riot_id: targetPlayer ? `${targetPlayer.name}#${targetPlayer.tag}`.toLowerCase() : '',
    player_puuid: targetPlayer?.puuid || '',
    all_players: allPlayers,
    rounds,
    kill_events: killEvents
  };

  const validation = validateNormalizedMatch(normalized);
  if (!validation.valid) {
    throw new Error(`Normalized match validation failed: ${validation.errors.join('; ')}`);
  }

  return normalized;
}

module.exports = {
  normalizeV4Match,
  validateNormalizedMatch
};
