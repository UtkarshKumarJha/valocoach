require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const ingestionRoutes = require('./routes/ingestionRoutes');
const coachingRoutes = require('./routes/coachingRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});



// Routes
app.use('/api/ingest', ingestionRoutes);
app.use('/api/coaching', coachingRoutes);

app.get('/health', (req, res) => {
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

// Asynchronously connect to MongoDB Atlas
function connectMongo() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/valocoach';
  mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
    .then(() => {
      console.log('Successfully connected to MongoDB Atlas');
    })
    .catch((err) => {
      console.warn('MongoDB connection warning:', err.message);
      console.warn('Backend server remains active. Re-attempting connection in 10 seconds...');
      setTimeout(connectMongo, 10000);
    });
}

connectMongo();
