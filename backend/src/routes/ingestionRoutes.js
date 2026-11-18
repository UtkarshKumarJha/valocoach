const express = require('express');
const router = express.Router();
const ingestionService = require('../services/ingestionService');

// POST /api/ingest/:region/:name/:tag
router.post('/:region/:name/:tag', async (req, res) => {
  const { region, name, tag } = req.params;
  
  if (!region || !name || !tag) {
    return res.status(400).json({ error: 'Missing required parameters: region, name, or tag.' });
  }

  try {
    const result = await ingestionService.ingestPlayerData(region, name, tag);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
