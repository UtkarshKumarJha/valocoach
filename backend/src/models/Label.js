const mongoose = require('mongoose');

// One human verdict on one labeling candidate. Durable copy of data/labels.jsonl (Render's disk is ephemeral).
const labelSchema = new mongoose.Schema({
  candidate_id: { type: String, index: true },
  rater: { type: String, index: true },
  created_at: { type: String, required: true }
}, { strict: false });

labelSchema.index({ candidate_id: 1, rater: 1, created_at: 1 }, { unique: true });

module.exports = mongoose.model('Label', labelSchema);
