#!/bin/bash
# install.sh - One-step setup for Verdant

echo "🌱 Installing Verdant Dependencies..."
npm install

echo "🎭 Installing Playwright Browsers..."
npx playwright install chromium

echo ""
echo "✅ Installation Complete!"
echo "🚀 Run ./start.sh to launch Verdant."
