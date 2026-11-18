/**
 * Ingestion Background Queue & Rate Limiter
 * 
 * Token bucket: 30 units / min (refills 0.5 units/sec).
 * Honors 429 and Retry-After headers with exponential backoff.
 * Assumes up to 2 units per deep detail call.
 * Job state is persisted to disk (sync_jobs.json) to survive process restarts.
 * Persists detected situations with feature_version so raw telemetry is never re-parsed per request.
 * 
 * Scope:
 * - 100-match window: Macro historical trends, rolling ACS, K/D ratios, multi-game session fatigue.
 * - Latest 50-match window: Deep event-level telemetry snapshot intelligence and peer habit distributions.
 */

const fs = require('fs');
const path = require('path');

const SYNC_JOBS_FILE = path.join(__dirname, '..', 'config', 'sync_jobs.json');

class TokenBucket {
  constructor(capacity = 30, refillRatePerSec = 0.5) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.lastRefill = Date.now();
    this.isBackingOff = false;
  }

  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
    this.lastRefill = now;
  }

  async acquire(cost = 2) {
    while (true) {
      if (this.isBackingOff) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return true;
      }
      const needed = cost - this.tokens;
      const waitMs = Math.ceil((needed / this.refillRatePerSec) * 1000);
      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 2000)));
    }
  }

  async handle429(retryAfterSec = 5) {
    this.isBackingOff = true;
    this.tokens = 0;
    const waitMs = Math.max(2000, Number(retryAfterSec || 5) * 1000);
    console.warn(`[TokenBucket] 429 Rate limit encountered. Backing off for ${waitMs / 1000}s...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.lastRefill = Date.now();
    this.isBackingOff = false;
  }
}

const globalTokenBucket = new TokenBucket(30, 0.5);

// Persistent Job State Management
function loadSyncJobs() {
  if (fs.existsSync(SYNC_JOBS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SYNC_JOBS_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveSyncJobs(jobs) {
  try {
    fs.writeFileSync(SYNC_JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf8');
  } catch (err) {
    console.warn('[SyncJobs] Failed to persist job state to disk:', err.message);
  }
}

// In-Memory map backed by disk
const syncProgressRegistry = new Map(Object.entries(loadSyncJobs()));

function getSyncProgress(riotId) {
  const key = (riotId || '').toLowerCase().trim();
  const state = syncProgressRegistry.get(key);
  if (state) return state;

  // Check disk
  const diskJobs = loadSyncJobs();
  if (diskJobs[key]) {
    syncProgressRegistry.set(key, diskJobs[key]);
    return diskJobs[key];
  }

  return {
    riotId: key,
    status: 'idle',
    total: 0,
    processed: 0,
    percent: 0,
    skippedMatches: []
  };
}

function updateSyncProgress(riotId, updates) {
  const key = (riotId || '').toLowerCase().trim();
  const current = getSyncProgress(key);
  const updated = { ...current, ...updates, lastUpdated: new Date().toISOString() };
  syncProgressRegistry.set(key, updated);

  const diskJobs = loadSyncJobs();
  diskJobs[key] = updated;
  saveSyncJobs(diskJobs);
  return updated;
}

const STALE_SYNC_MS = 10 * 60 * 1000; // a "syncing" state this old is a crashed worker, not a live one

/**
 * Starts a background sync for a player and returns its progress immediately (never blocks a request).
 * The worker is ingestionService.ingestPlayerData: the single path that pages v4, normalizes, gates queues
 * and saves complete matches through storeService.
 */
function triggerBackgroundSync(region, name, tag) {
  const riotId = `${name}#${tag}`.toLowerCase().trim();
  const current = getSyncProgress(riotId);
  const fresh = Date.now() - new Date(current.lastUpdated || 0).getTime() < STALE_SYNC_MS;
  if (current.status === 'syncing' && fresh) return current;

  const progressState = updateSyncProgress(riotId, {
    status: 'syncing',
    total: 50,
    processed: 0,
    percent: 0,
    skippedMatches: [],
    startedAt: new Date().toISOString(),
    error: null
  });

  setImmediate(async () => {
    try {
      const ingestionService = require('./ingestionService'); // lazy: ingestionService uses this module's token bucket
      const res = await ingestionService.ingestPlayerData(region, name, tag, 50, ({ accepted, target }) => {
        updateSyncProgress(riotId, { processed: accepted, total: target, percent: Math.min(99, Math.round((accepted / target) * 100)) });
      });
      updateSyncProgress(riotId, {
        status: 'completed',
        processed: res.acceptedMatchesCount,
        percent: 100,
        skippedMatches: res.skippedMatches,
        completedAt: new Date().toISOString()
      });
    } catch (err) {
      console.warn(`[BackgroundSync] Sync failed for ${riotId}:`, err.message);
      // Generic message only: progress is client-visible
      updateSyncProgress(riotId, { status: 'error', error: 'Sync failed. Check the Riot ID and region, then try again.' });
    }
  });

  return progressState;
}

module.exports = {
  TokenBucket,
  globalTokenBucket,
  getSyncProgress,
  triggerBackgroundSync
};
