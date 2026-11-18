const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Player = require('../models/Player');
const Match = require('../models/Match');
const SyncJob = require('../models/SyncJob');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'store_cache.json');

// In-Memory fallback store to ensure zero 502s or blank stats even when Atlas is offline/whitelisting
const inMemoryPlayers = new Map();
const inMemoryMatches = new Map(); // key: riotId (lowercase), value: Array of normalized match objects
const inMemoryJobs = new Map();

// Load persistent disk cache if exists
function loadDiskCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (data.players) {
        Object.entries(data.players).forEach(([k, v]) => inMemoryPlayers.set(k, v));
      }
      if (data.matches) {
        Object.entries(data.matches).forEach(([k, v]) => inMemoryMatches.set(k, v));
      }
      if (data.jobs) {
        Object.entries(data.jobs).forEach(([k, v]) => inMemoryJobs.set(k, v));
      }
    } catch (e) {
      console.warn('[storeService] Failed to load disk cache:', e.message);
    }
  }
}

function saveDiskCache() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dump = {
      players: Object.fromEntries(inMemoryPlayers),
      matches: Object.fromEntries(inMemoryMatches),
      jobs: Object.fromEntries(inMemoryJobs)
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(dump), 'utf8');
  } catch (e) {
    console.warn('[storeService] Failed to save disk cache:', e.message);
  }
}

loadDiskCache();

function isMongoConnected() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

/**
 * Get player by riotId (lowercase)
 */
async function getPlayer(riotId) {
  const cleanId = riotId.toLowerCase().trim();
  if (isMongoConnected()) {
    try {
      const p = await Player.findOne({ riotId: cleanId }).lean();
      if (p) {
        inMemoryPlayers.set(cleanId, p);
        return p;
      }
    } catch (err) {
      console.warn('[storeService] Mongo read player failed, fallback to memory:', err.message);
    }
  }
  return inMemoryPlayers.get(cleanId) || null;
}

/**
 * Upsert player record
 */
async function upsertPlayer(playerData) {
  const cleanId = playerData.riotId.toLowerCase().trim();
  inMemoryPlayers.set(cleanId, { ...playerData, riotId: cleanId, updatedAt: new Date() });
  saveDiskCache();

  if (isMongoConnected()) {
    try {
      const updated = await Player.findOneAndUpdate(
        { riotId: cleanId },
        { ...playerData, riotId: cleanId, lastUpdated: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      return updated;
    } catch (err) {
      console.warn('[storeService] Mongo upsert player failed:', err.message);
    }
  }
  return inMemoryPlayers.get(cleanId);
}

/**
 * Get matches for a player, sorted by playedAt descending, limited to limit
 */
async function getMatches(riotId, limit = 100) {
  const cleanId = riotId.toLowerCase().trim();
  let matches = [];

  if (isMongoConnected()) {
    try {
      const p = await Player.findOne({ riotId: cleanId }).lean();
      if (p) {
        matches = (await Match.find({ player: p._id })
          .sort({ playedAt: -1 })
          .limit(limit)
          .lean())
          // Docs saved before strict:false lack all_players/queue; skip them so the player re-syncs fully
          .filter(m => Array.isArray(m.all_players) && m.all_players.length > 0 && m.queue);
      }
    } catch (err) {
      console.warn('[storeService] Mongo read matches failed, fallback to memory:', err.message);
    }
  }

  if (!matches || matches.length === 0) {
    const memList = inMemoryMatches.get(cleanId) || [];
    matches = [...memList]
      .sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt))
      .slice(0, limit);
  }

  return matches;
}

/**
 * Save normalized matches for a player
 */
async function saveMatches(riotId, normalizedMatches) {
  const cleanId = riotId.toLowerCase().trim();
  const existingMem = inMemoryMatches.get(cleanId) || [];
  const existingIds = new Set(existingMem.map(m => m.matchId));

  for (const m of normalizedMatches) {
    if (!existingIds.has(m.matchId)) {
      existingMem.push(m);
      existingIds.add(m.matchId);
    }
  }
  inMemoryMatches.set(cleanId, existingMem);
  saveDiskCache();

  if (isMongoConnected()) {
    try {
      const p = await Player.findOne({ riotId: cleanId });
      if (p) {
        for (const m of normalizedMatches) {
          await Match.findOneAndUpdate(
            { matchId: m.matchId, player: p._id },
            { ...m, player: p._id },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
        }
      }
    } catch (err) {
      console.warn('[storeService] Mongo batch match upsert failed:', err.message);
    }
  }

  return existingMem.length;
}

/**
 * Get sync job state
 */
async function getSyncJob(jobId) {
  if (isMongoConnected()) {
    try {
      const job = await SyncJob.findOne({ jobId }).lean();
      if (job) return job;
    } catch (err) {
      console.warn('[storeService] Mongo get sync job failed:', err.message);
    }
  }
  return inMemoryJobs.get(jobId) || null;
}

/**
 * Save sync job state
 */
async function saveSyncJob(jobId, jobData) {
  inMemoryJobs.set(jobId, { ...jobData, jobId, updatedAt: new Date() });
  saveDiskCache();

  if (isMongoConnected()) {
    try {
      await SyncJob.findOneAndUpdate(
        { jobId },
        { ...jobData, jobId, updatedAt: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (err) {
      console.warn('[storeService] Mongo save sync job failed:', err.message);
    }
  }
}

module.exports = {
  isMongoConnected,
  getPlayer,
  upsertPlayer,
  getMatches,
  saveMatches,
  getSyncJob,
  saveSyncJob,
  inMemoryPlayers,
  inMemoryMatches,
  inMemoryJobs
};
