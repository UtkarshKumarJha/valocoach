require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const ingestionRoutes = require('./routes/ingestionRoutes');
const coachingRoutes = require('./routes/coachingRoutes');
const devRoutes = require('./routes/devRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// CORS: hosted, the Vercel frontend proxies /api same-origin; FRONTEND_ORIGIN allows direct calls from that site only
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.FRONTEND_ORIGIN || '*');
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Invite-Code');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});



// Routes
app.use('/api/ingest', ingestionRoutes);
app.use('/api/coaching', coachingRoutes);
// Round labeler + crawler: open locally; in production only when LABELER_INVITE_CODE is set (checked per request)
if (process.env.NODE_ENV !== 'production' || process.env.LABELER_INVITE_CODE) app.use('/api/dev', devRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date()
  });
});

// Always start HTTP server so port 5000 is immediately responsive (no 502 Bad Gateway)
app.listen(PORT, () => {
  console.log(`ValoCoach Backend Server running on port ${PORT}`);
});

// Disable command buffering so queries fail-fast to in-memory store when Mongo is offline
mongoose.set('bufferCommands', false);

// Asynchronously connect to MongoDB Atlas
function connectMongo() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/valocoach';
  mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
      console.log('Successfully connected to MongoDB Atlas');
      try {
        const n = await require('./services/devTelemetryService').loadLabelsFromMongo();
        require('./services/labelPoolService').refreshLabels();
        console.log(`[labels] ${n} labels loaded (Mongo + local file)`);
      } catch (err) {
        console.warn('[labels] could not load labels from Mongo:', err.message);
      }
    })
    .catch((err) => {
      console.warn('MongoDB connection warning:', err.message);
      console.warn('Backend server remains active (using resilient in-memory store). Re-attempting connection in 10 seconds...');
      setTimeout(connectMongo, 10000);
    });
}

connectMongo();
