const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  riotId: {
    type: String,
    required: true,
    unique: true,
    index: true // Indexed for quick lookups
  },
  name: { type: String, required: true },
  tag: { type: String, required: true },
  region: { type: String, required: true },
  puuid: { type: String },
  currentRank: { type: String },
  currentRR: { type: Number },
  lastUpdated: { type: Date, default: null }
}, {
  timestamps: true
});

module.exports = mongoose.model('Player', playerSchema);
