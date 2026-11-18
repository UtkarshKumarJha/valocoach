const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_FILE = path.join(__dirname, '..', 'config', 'agent_roles_cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours TTL

// Committed fallback table of all known Valorant agents
const SEED_AGENT_ROLES = {
  // Duelists
  'jett': 'Duelist',
  'reyna': 'Duelist',
  'raze': 'Duelist',
  'phoenix': 'Duelist',
  'yoru': 'Duelist',
  'neon': 'Duelist',
  'iso': 'Duelist',
  'miks': 'Duelist', // Newly observed competitive duelist
  'waylay': 'Duelist', // Newly observed competitive duelist
  // Initiators
  'sova': 'Initiator',
  'breach': 'Initiator',
  'skye': 'Initiator',
  'kay/o': 'Initiator',
  'kayo': 'Initiator',
  'fade': 'Initiator',
  'gekko': 'Initiator',
  'tejo': 'Initiator',
  // Controllers
  'brimstone': 'Controller',
  'omen': 'Controller',
  'viper': 'Controller',
  'astra': 'Controller',
  'harbor': 'Controller',
  'clove': 'Controller',
  // Sentinels
  'killjoy': 'Sentinel',
  'cypher': 'Sentinel',
  'sage': 'Sentinel',
  'chamber': 'Sentinel',
  'deadlock': 'Sentinel',
  'vyse': 'Sentinel',
  'hush': 'Sentinel'
};

let inMemoryRoles = null;
let lastSyncTimestamp = 0;

function loadDiskCache() {
  if (inMemoryRoles && (Date.now() - lastSyncTimestamp < CACHE_TTL_MS)) {
    return inMemoryRoles;
  }

  if (fs.existsSync(CACHE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        const timestamp = data._lastSync || 0;
        if (Date.now() - timestamp < CACHE_TTL_MS) {
          inMemoryRoles = data.roles || data;
          lastSyncTimestamp = timestamp;
          return inMemoryRoles;
        }
      }
    } catch {
      // Fallback to committed seed table
    }
  }

  inMemoryRoles = { ...SEED_AGENT_ROLES };
  lastSyncTimestamp = Date.now();
  return inMemoryRoles;
}

function saveDiskCache(roles) {
  try {
    const payload = {
      _lastSync: Date.now(),
      roles
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Non-fatal if disk write fails
  }
}

/**
 * Syncs latest agents from the official Valorant API content endpoint.
 * Cached to disk with 24-hour TTL.
 */
async function syncAgentRolesFromApi() {
  try {
    const response = await axios.get('https://valorant-api.com/v1/agents?isPlayableCharacter=true', {
      timeout: 4000
    });
    if (response.data && Array.isArray(response.data.data)) {
      const rolesMap = { ...SEED_AGENT_ROLES };
      for (const agent of response.data.data) {
        if (agent.displayName && agent.role && agent.role.displayName) {
          rolesMap[agent.displayName.toLowerCase()] = agent.role.displayName;
        }
      }
      inMemoryRoles = rolesMap;
      lastSyncTimestamp = Date.now();
      saveDiskCache(rolesMap);
      return rolesMap;
    }
  } catch {
    // Graceful fallback to cached seed roles
  }
  return loadDiskCache();
}

/**
 * Returns role for a specific agent name (case-insensitive).
 * Returns null if the agent is unknown.
 */
function getRoleForAgent(agentName) {
  if (!agentName) return null;
  const roles = loadDiskCache();
  const cleaned = agentName.toLowerCase().trim();
  return roles[cleaned] || null;
}

/**
 * Obtains the role of the agent played in THAT specific match.
 * Never uses a player-level primary role.
 * If unknown agent, logs and returns null.
 */
function getRoleForMatch(match, playerRiotId, playerPuuid) {
  if (!match) return null;

  const matchId = match.matchId || match.metadata?.matchid || 'unknown_match';
  const riotIdLower = (playerRiotId || '').toLowerCase().trim();

  // Find player stats in all_players or matchInfo
  const allPlayers = match.all_players || match.players?.all_players || [];
  const playerStats = allPlayers.find(
    p => (playerPuuid && p.puuid === playerPuuid) ||
         (`${p.name}#${p.tag}`.toLowerCase() === riotIdLower) ||
         (p.name && riotIdLower.startsWith(p.name.toLowerCase()))
  );

  let agentName = null;
  if (playerStats) {
    agentName = playerStats.character || playerStats.agent;
  }
  if (!agentName && match.agent) {
    agentName = match.agent;
  }

  if (!agentName) {
    console.log(`[agentRoleService] Unknown agent for player ${playerRiotId || playerPuuid}, skipping role-conditioned detectors for match ${matchId}`);
    return null;
  }

  const role = getRoleForAgent(agentName);
  if (!role) {
    console.log(`[agentRoleService] Unknown agent "${agentName}", skipping role-conditioned detectors for match ${matchId}`);
    return null;
  }

  return role;
}

module.exports = {
  SEED_AGENT_ROLES,
  getRoleForAgent,
  getRoleForMatch,
  syncAgentRolesFromApi,
  loadDiskCache
};
