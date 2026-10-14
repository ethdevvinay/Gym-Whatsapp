#!/usr/bin/env bash
# ==============================================================================
# The Club 777° — Hostinger Cloud Node.js 24x7 Worker Automation Setup Script
# Server: ethicscomputer.in (62.72.15.20)
# ==============================================================================

set -e

echo "=== [1/6] Checking Node.js and NPM on Hostinger Server ==="
node -v
npm -v

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== [2/6] Preparing Production Directories ==="
mkdir -p logs auth_info
chmod 700 auth_info logs

echo "=== [3/6] Setting Up Production Environment File ==="
if [ ! -f .env ]; then
  if [ -f .env.production ]; then
    cp .env.production .env
    echo "[!] .env copied from .env.production. Please verify your DB_PASS in .env!"
  else
    echo "[!] No .env or .env.production found! Please configure .env first."
    exit 1
  fi
fi
chmod 600 .env

echo "=== [4/6] Installing Node.js Production Dependencies ==="
npm install --omit=dev

echo "=== [5/6] Checking or Installing PM2 Process Manager ==="
if ! command -v pm2 &> /dev/null; then
  echo "Installing PM2 globally..."
  npm install -g pm2 || npm install pm2
fi

echo "=== [6/6] Launching 24x7 WhatsApp Worker via PM2 ==="
npx pm2 start ecosystem.config.cjs
npx pm2 save

echo ""
echo "=================================================================="
echo " SUCCESS! The Club 777° WhatsApp Worker is running 24x7 via PM2!"
echo " Status Command:  npx pm2 status"
echo " Live Logs:       npx pm2 logs club777-whatsapp-worker"
echo " Health Endpoint: curl http://127.0.0.1:3001/health"
echo "=================================================================="
