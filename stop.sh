#!/bin/bash
echo "Stopping Verdant processes..."
lsof -ti:8787 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null
echo "Processes stopped."
