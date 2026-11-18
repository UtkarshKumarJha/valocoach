const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_FILE = path.join(__dirname, '..', 'config', 'agent_roles_cache.json');

// Local fallback seed cache in case of offline execution or network failure
const SEED_AGENT_ROLES = {
  // Duelists
  'jett': 'Duelist',
  'reyna': 'Duelist',
  'raze': 'Duelist',
  'phoenix': 'Duelist',
  'yoru': 'Duelist',
  'neon': 'Duelist',
  'iso': 'Duelist',
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
  'hush': 'Sentinel' // Test fixture agent
};

let inMemoryRoles = null;

function loadDiskCache() {
  if (inMemoryRoles) return inMemoryRoles;

  if (fs.existsSync(CACHE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      inMemoryRoles = data;
      return inMemoryRoles;
    } catch {
      // Ignore read error, fallback to seed
    }
  }

  inMemoryRoles = { ...SEED_AGENT_ROLES };
  return inMemoryRoles;
}

function saveDiskCache(roles) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(roles, null, 2), 'utf8');
  } catch {
    // Non-fatal if disk write fails
  }
}

/**
 * Syncs latest agents from the official Valorant API content endpoint.
 * Cached to disk and memory; non-blocking.
 */
async function syncAgentRolesFromApi() {
  try {
    const response = await axios.get('https://valorant-api.com/v1/agents?isPlayableCharacter=true', {
      timeout: 4000
    });
    if (response.data && Array.isArray(response.data.data)) {
      const rolesMap = { ...loadDiskCache() };
      for (const agent of response.data.data) {
        if (agent.displayName && agent.role && agent.role.displayName) {
          rolesMap[agent.displayName.toLowerCase()] = agent.role.displayName;
        }
      }
      inMemoryRoles = rolesMap;
      saveDiskCache(rolesMap);
      return rolesMap;
    }
  } catch {
    // Graceful fallback to cached roles
  }
  return loadDiskCache();
}

/**
 * Returns role for a specific agent name (case-insensitive).
 */
function getRoleForAgent(agentName) {
  if (!agentName) return 'Unknown';
  const roles = loadDiskCache();
  const cleaned = agentName.toLowerCase().trim();
  return roles[cleaned] || 'Unknown';
}

/**
 * Obtains the role of the agent played in THAT specific match.
 * Never uses a player-level primary role.
 */
function getRoleForMatch(match, playerRiotId, playerPuuid) {
  if (!match) return 'Unknown';

  const riotIdLower = (playerRiotId || '').toLowerCase().trim();

  // If match has agent directly
  if (match.agent) {
    const r = getRoleForAgent(match.agent);
    if (r !== 'Unknown') return r;
  }

  // Find player stats in match if available
  const allPlayers = match.players?.all_players || [];
  const playerStats = allPlayers.find(
    p => (playerPuuid && p.puuid === playerPuuid) ||
         (`${p.name}#${p.tag}`.toLowerCase() === riotIdLower) ||
         (p.name && riotIdLower.startsWith(p.name.toLowerCase()))
  );

  if (playerStats && (playerStats.character || playerStats.agent)) {
    return getRoleForAgent(playerStats.character || playerStats.agent);
  }

  return getRoleForAgent(match.agent) || 'Unknown';
}

module.exports = {
  getRoleForAgent,
  getRoleForMatch,
  syncAgentRolesFromApi,
  loadDiskCache
};
