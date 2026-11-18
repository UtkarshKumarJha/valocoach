const mongoose = require('mongoose');

const syncJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true, index: true },
  riotId: { type: String, required: true, index: true },
  region: { type: String, default: 'ap' },
  status: { 
    type: String, 
    enum: ['queued', 'running', 'completed', 'failed'], 
    default: 'queued',
    index: true
  },
  totalMatches: { type: Number, default: 0 },
  processedMatches: { type: Number, default: 0 },
  skippedMatches: [{
    matchId: String,
    reason: String
  }],
  currentStage: { type: String, default: 'Initializing' },
  error: { type: String, default: null },
  featureVersion: { type: String, default: 'v2.1' },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
}, {
  timestamps: true
});

module.exports = mongoose.model('SyncJob', syncJobSchema);
