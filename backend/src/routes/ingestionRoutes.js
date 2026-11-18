const express = require('express');
const router = express.Router();
const ingestionService = require('../services/ingestionService');
const { getSyncProgress, triggerBackgroundSync } = require('../services/ingestionQueue');

// POST /api/ingest/:region/:name/:tag - Non-blocking asynchronous sync trigger
router.post('/:region/:name/:tag', (req, res) => {
  const { region, name, tag } = req.params;
  
  if (!region || !name || !tag) {
    return res.status(400).json({ error: 'Missing required parameters: region, name, or tag.' });
  }

  try {
    const progress = triggerBackgroundSync(region, name, tag);
    res.json({
      message: 'Background synchronization initiated',
      progress
    });
  } catch (error) {
    console.error('[ingest] trigger failed:', error.message);
    res.status(503).json({ error: 'Service temporarily unavailable. Please try again shortly.' });
  }
});

// GET /api/ingest/progress/:riotId - Poll progress state
router.get('/progress/:riotId', (req, res) => {
  const { riotId } = req.params;
  const progress = getSyncProgress(decodeURIComponent(riotId));
  res.json(progress);
});

// GET /api/ingest/stream/:riotId - Server-Sent Events (SSE) live progress stream
router.get('/stream/:riotId', (req, res) => {
  const { riotId } = req.params;
  const decodedId = decodeURIComponent(riotId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const interval = setInterval(() => {
    const progress = getSyncProgress(decodedId);
    res.write(`data: ${JSON.stringify(progress)}\n\n`);

    if (progress.status === 'completed' || progress.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

module.exports = router;
