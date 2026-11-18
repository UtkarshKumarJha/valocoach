#!/bin/bash
set -e

# ValoCoach Unified Startup Script
echo "========================================="
echo "   Starting ValoCoach Platform Services  "
echo "========================================="

# Trap exit signals to kill all child processes on Ctrl+C
trap 'kill $(jobs -p) 2>/dev/null || true; echo -e "\nServices stopped."; exit 0' SIGINT SIGTERM EXIT

# 1. Start Python FastAPI ML Engine on Port 8001
echo "[1/3] Starting Python ML Microservice (FastAPI :8001)..."
(cd ml && .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8001) &
ML_PID=$!

# Wait briefly for ML engine to bind
sleep 2

# 2. Start Express Backend on Port 5000
echo "[2/3] Starting Express Backend API (:5000)..."
(cd backend && npm start) &
BACKEND_PID=$!

sleep 2

# 3. Start Vite Frontend on Port 5173
echo "[3/3] Starting React Vite Frontend (:5173)..."
(cd frontend && npm run dev) &
FRONTEND_PID=$!

echo "========================================="
echo "ValoCoach running successfully!"
echo "  • Frontend: http://localhost:5173"
echo "  • Backend API: http://localhost:5000"
echo "  • ML Engine: http://localhost:8001"
echo "Press Ctrl+C to terminate all services."
echo "========================================="

wait
