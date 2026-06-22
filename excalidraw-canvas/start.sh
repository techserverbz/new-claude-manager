#!/bin/bash
# Excalidraw Canvas — Start Script
# Kills existing processes on ports 4111 (API) and 5111 (Vite), then starts fresh.
# Run from: C:\Users\Shubham(Code)\Desktop\Github\excalidraw-canvas\
# Usage: bash start.sh

set -e

API_PORT=4111
VITE_PORT=5111

echo "=== Excalidraw Canvas Startup ==="
echo "API port: $API_PORT | Vite port: $VITE_PORT"
echo ""

# Kill anything on API port
PID_API=$(netstat -ano 2>/dev/null | grep ":${API_PORT} " | grep LISTENING | awk '{print $5}' | head -1)
if [ -n "$PID_API" ] && [ "$PID_API" != "0" ]; then
  echo "Killing existing process on :${API_PORT} (PID $PID_API)..."
  taskkill //F //PID "$PID_API" 2>/dev/null || true
  sleep 1
fi

# Kill anything on Vite port
PID_VITE=$(netstat -ano 2>/dev/null | grep ":${VITE_PORT} " | grep LISTENING | awk '{print $5}' | head -1)
if [ -n "$PID_VITE" ] && [ "$PID_VITE" != "0" ]; then
  echo "Killing existing process on :${VITE_PORT} (PID $PID_VITE)..."
  taskkill //F //PID "$PID_VITE" 2>/dev/null || true
  sleep 1
fi

# Unset any shell PORT override that could conflict
unset PORT

# Export the correct port (read from .env, but force it here too)
export PORT=$API_PORT

echo "Starting canvas (API :$API_PORT + Vite :$VITE_PORT)..."
echo "Frontend: http://localhost:$VITE_PORT"
echo "API:      http://127.0.0.1:$API_PORT"
echo ""

cd "$(dirname "$0")"
npm run dev
