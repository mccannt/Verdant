#!/bin/bash
# Start Runner
# Use the robust stop script
chmod +x stop.sh
./stop.sh

cd apps/runner
npm run dev &
RUNNER_PID=$!

# Start UI
cd ../ui
npm run dev &
UI_PID=$!

echo "Started Runner ($RUNNER_PID) and UI ($UI_PID)"

# Wait for them to be ready
sleep 5
