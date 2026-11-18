const valorantApiService = require('./valorantApiService');
const { isSupportedQueue } = require('../config/telemetryConfig');
const { normalizeV4Match, validateNormalizedMatch } = require('../adapters/v4PayloadAdapter');
const storeService = require('./storeService');

/**
 * Ingest player data and recent matches (up to targetCount supported matches, default 50).
 * Paginates Henrik v4 matches API (10 per page) with rate-limit pacing and 429 backoff.
 */
exports.ingestPlayerData = async (region, name, tag, targetCount = 50, onProgress = null) => {
  const { globalTokenBucket } = require('./ingestionQueue'); // shared with the label-pool crawler
  const riotId = `${name}#${tag}`.toLowerCase();
  const jobId = `sync_${riotId}_${Date.now()}`;

  await storeService.saveSyncJob(jobId, {
    status: 'in_progress',
    riotId,
    region,
    targetCount,
    fetchedMatches: 0,
    acceptedMatches: 0,
    skippedMatches: [],
    startedAt: new Date()
  });

  try {
    // 1. Fetch MMR / Rank
    let mmrData = null;
    let currentRank = 'Unranked';
    let currentRR = 0;
    let puuid = '';

    try {
      await globalTokenBucket.acquire(1);
      const mmrRes = await valorantApiService.fetchPlayerMmr(region, name, tag);
      mmrData = mmrRes?.data;
      if (mmrData) {
        currentRank = mmrData.current_data?.currenttierpatched || 'Unranked';
        currentRR = mmrData.current_data?.ranking_in_tier || 0;
        puuid = mmrData.puuid || '';
      }
    } catch (mmrErr) {
      console.warn(`[ingestion] MMR lookup failed for ${riotId}: ${mmrErr.message}. Continuing with match pagination.`);
    }

    // 2. Paginate Henrik v4 matches until targetCount supported matches or history exhausted
    const PAGE_SIZE = 10;
    const MAX_PAGES = 10; // 10 pages * 10 = up to 100 raw matches queried to find targetCount supported
    const acceptedNormalized = [];
    const skippedMatches = [];
    let startOffset = 0;
    let historyExhausted = false;

    console.log(`[ingestion] Starting v4 match crawl for ${riotId} (target: ${targetCount} supported matches)...`);

    for (let page = 0; page < MAX_PAGES && acceptedNormalized.length < targetCount && !historyExhausted; page++) {
      startOffset = page * PAGE_SIZE;

      let rawPageRes = null;
      let retries = 0;
      const MAX_RETRIES = 2;

      while (retries <= MAX_RETRIES) {
        try {
          await globalTokenBucket.acquire(6); // 1 list call + Henrik's background detail fetches
          rawPageRes = await valorantApiService.fetchPlayerMatchesV4(region, name, tag, startOffset, PAGE_SIZE);
          break;
        } catch (apiErr) {
          if (apiErr.response?.status === 429 && retries < MAX_RETRIES) {
            const retryAfterSec = parseInt(apiErr.response.headers?.['retry-after'] || '3', 10);
            console.warn(`[ingestion] Rate limit (429) hit. Backing off for ${retryAfterSec}s...`);
            await new Promise(r => setTimeout(r, (retryAfterSec + 1) * 1000));
            retries++;
          } else {
            console.warn(`[ingestion] Error fetching v4 matches at start=${startOffset}: ${apiErr.message}`);
            historyExhausted = true;
            break;
          }
        }
      }

      const rawMatches = rawPageRes?.data || [];
      if (!Array.isArray(rawMatches) || rawMatches.length === 0) {
        console.log(`[ingestion] No more matches returned at offset ${startOffset}. History exhausted.`);
        historyExhausted = true;
        break;
      }

      for (const rawMatch of rawMatches) {
        if (!rawMatch || !rawMatch.metadata) continue;

        const matchId = rawMatch.metadata.match_id || rawMatch.metadata.matchid || 'unknown';

        // Filter queue: supported queues only (competitive, unrated, premier)
        const queueCheck = isSupportedQueue(rawMatch);
        if (!queueCheck.supported) {
          skippedMatches.push({
            matchId,
            reason: queueCheck.reason || 'unsupported_mode'
          });
          continue;
        }

        try {
          const normalized = normalizeV4Match(rawMatch, riotId);
          const validation = validateNormalizedMatch(normalized);
          if (!validation.valid) {
            console.warn(`[ingestion] Match ${matchId} failed validation:`, validation.errors);
            skippedMatches.push({
              matchId,
              reason: `validation_failed: ${validation.errors.join('; ')}`
            });
            continue;
          }

          // If we didn't have puuid yet, extract from normalized target player
          if (!puuid && normalized.player_puuid) {
            puuid = normalized.player_puuid;
          }

          acceptedNormalized.push(normalized);
          if (acceptedNormalized.length >= targetCount) {
            break;
          }
        } catch (normErr) {
          console.warn(`[ingestion] Failed to normalize match ${matchId}:`, normErr.message);
          skippedMatches.push({ matchId, reason: normErr.message });
        }
      }

      // If fewer than PAGE_SIZE returned, history is exhausted
      if (onProgress) onProgress({ accepted: acceptedNormalized.length, target: targetCount });
      if (rawMatches.length < PAGE_SIZE) historyExhausted = true;
    }

    console.log(`[ingestion] Crawl complete for ${riotId}. Accepted: ${acceptedNormalized.length}, Skipped: ${skippedMatches.length}.`);

    // 3. Upsert Player record
    await storeService.upsertPlayer({
      riotId,
      name,
      tag,
      region,
      puuid,
      currentRank,
      currentRR
    });

    // 4. Save normalized matches
    if (acceptedNormalized.length > 0) {
      await storeService.saveMatches(riotId, acceptedNormalized);
    }

    // 5. Update sync job
    await storeService.saveSyncJob(jobId, {
      status: 'completed',
      riotId,
      region,
      targetCount,
      acceptedMatches: acceptedNormalized.length,
      skippedMatchesCount: skippedMatches.length,
      skippedMatches,
      completedAt: new Date()
    });

    return {
      message: 'Ingestion completed successfully',
      player: riotId,
      acceptedMatchesCount: acceptedNormalized.length,
      skippedMatchesCount: skippedMatches.length,
      skippedMatches,
      matches: acceptedNormalized
    };
  } catch (error) {
    console.error(`[ingestion] Ingestion fatal error for ${riotId}:`, error);
    await storeService.saveSyncJob(jobId, {
      status: 'failed',
      riotId,
      error: error.message,
      failedAt: new Date()
    });
    throw error;
  }
};
