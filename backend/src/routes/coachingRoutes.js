const express = require('express');
const router = express.Router();
const coachingService = require('../services/coachingService');

// GET /api/coaching/:region/:name/:tag?map=ascent&role=Duelist
router.get('/:region/:name/:tag', async (req, res) => {
  const { region, name, tag } = req.params;
  const { map, role } = req.query;
  
  if (!region || !name || !tag) {
    return res.status(400).json({ error: 'Missing required parameters: region, name, or tag.' });
  }

  try {
    const result = await coachingService.generateCoachingDebrief(
      region, 
      name, 
      tag, 
      map || null, 
      role || null
    );
    res.json(result);
  } catch (error) {
    // First visit: history is being synced in the background; client polls /api/ingest/progress/:riotId
    if (error.code === 'SYNC_IN_PROGRESS') {
      return res.status(202).json({ status: 'syncing', progress: error.progress });
    }
    if (error.code === 'NO_SUPPORTED_MATCHES') {
      return res.status(404).json({ error: 'No competitive, unrated or premier matches in your recent history yet. Play a few and search again.' });
    }
    console.error("Coaching debrief error:", error.message);
    // Generic 503 Service Unavailable (Requirement 8: Never leak Atlas whitelist or DB internals)
    res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
  }
});

// POST /api/coaching/chat - Interactive conversation with Gemini coach
router.post('/chat', async (req, res) => {
  const { riotId, messages, contextData } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required.' });
  }

  try {
    const result = await coachingService.chatWithCoach({ riotId, messages, contextData });
    res.json(result);
  } catch (error) {
    console.error("Coach chat error:", error.message);
    // Generic 503 Service Unavailable
    res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
  }
});

module.exports = router;
