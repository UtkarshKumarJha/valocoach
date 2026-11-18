const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const devTelemetryService = require('../services/devTelemetryService');
const labelPoolService = require('../services/labelPoolService');

// Invite gate: when LABELER_INVITE_CODE is set, every labeler call must send it (X-Invite-Code header)
router.use((req, res, next) => {
  const code = process.env.LABELER_INVITE_CODE;
  if (!code) return next();
  const given = Buffer.from(String(req.get('x-invite-code') || ''));
  const expected = Buffer.from(code);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  res.status(401).json({ error: 'Invite code required' });
});

// Generic body for server-side failures; details stay in the server log
const fail = (res, where, err) => {
  console.error(`[devRoutes] ${where}:`, err.message);
  res.status(503).json({ error: 'Service temporarily unavailable. Please try again shortly.' });
};

// GET /api/dev/matches - List all match fixtures & stored telemetry
router.get('/matches', (req, res) => {
  try {
    const matches = devTelemetryService.getAvailableMatches();
    res.json({ matches });
  } catch (err) {
    fail(res, 'matches', err);
  }
});

// GET /api/dev/situations - Extract candidate situations for labeling
router.get('/situations', (req, res) => {
  try {
    const {
      matchId = 'match1',
      playerRiotId,
      samplingMode = 'all',
      shuffle = 'false'
    } = req.query;

    const data = devTelemetryService.getCandidateSituations({
      matchId,
      playerRiotId,
      samplingMode,
      shuffle: shuffle === 'true' || shuffle === true
    });

    res.json(data);
  } catch (err) {
    fail(res, 'situations', err);
  }
});

// POST /api/dev/verdicts - Append human verdict to data/labels.jsonl
router.post('/verdicts', async (req, res) => {
  try {
    const verdict = req.body;
    const result = await devTelemetryService.appendVerdict(verdict);
    if (verdict?.candidate_id) labelPoolService.markLabeled(String(verdict.candidate_id));
    res.json(result);
  } catch (err) {
    if (err.code === 'STORAGE_FAILED') return fail(res, 'verdict storage', err);
    res.status(400).json({ error: err.message }); // our own validation messages only
  }
});

// GET /api/dev/labels - Read recorded labels
router.get('/labels', (req, res) => {
  try {
    const labels = devTelemetryService.getLabels();
    res.json({ count: labels.length, labels });
  } catch (err) {
    fail(res, 'labels', err);
  }
});

// GET /api/dev/evaluate - Compute per-detector precision/recall (70/30 split)
router.get('/evaluate', (req, res) => {
  try {
    const splitRatio = Number(req.query.split || 0.70);
    const results = devTelemetryService.evaluateLabels(splitRatio);
    res.json(results);
  } catch (err) {
    fail(res, 'evaluate', err);
  }
});

// GET /api/dev/next?rater=Name&focus=TAG - Next round to label from the crawled pool (empty -> 204)
router.get('/next', (req, res) => {
  try {
    const rater = String(req.query.rater || '').trim();
    if (!rater) return res.status(400).json({ error: 'rater is required' });
    const card = labelPoolService.nextRound({ rater, focus: req.query.focus ? String(req.query.focus) : null });
    if (!card) return res.status(204).end();
    res.json(card);
  } catch (err) {
    fail(res, 'next', err);
  }
});

// GET /api/dev/pool/status - Pool size, crawler state, label counts per rater/bucket
router.get('/pool/status', (req, res) => {
  try {
    res.json(labelPoolService.getStatus());
  } catch (err) {
    fail(res, 'pool status', err);
  }
});

// POST /api/dev/pool/seeds {riotId, region, source: owner|friend|pro} - Add an account to crawl
router.post('/pool/seeds', (req, res) => {
  let seeds;
  try {
    seeds = labelPoolService.addSeed(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  labelPoolService.ensureCrawler();
  res.json({ seeds });
});

module.exports = router;
