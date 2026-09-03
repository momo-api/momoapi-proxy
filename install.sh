#!/usr/bin/env bash
set -euo pipefail

API_KEY="${1:-${MOMO_API_KEY:-}}"
ENDPOINT="${MOMO_API_ENDPOINT:-https://momoapi.us}"
PORT="${MOMO_BRIDGE_PORT:-18789}"

echo "==> [momo-codex-bridge] Checking Node.js environment..."
if ! command -v node >/dev/null 2>&1; then
  echo "==> ERROR: Node.js 18+ is required. Please install Node.js from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -v | tr -d 'v' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "==> ERROR: Node.js version must be >= 18; found $(node -v)"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  read -rp "Enter your MOMO API Key (e.g. sk-momo-...): " API_KEY
fi

if [ -z "$API_KEY" ]; then
  echo "==> ERROR: MOMO API Key is required."
  exit 1
fi

INSTALL_DIR="$HOME/.momo-codex-bridge/app"
rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  
  echo "==> [momo-codex-bridge] Downloading latest release from GitHub..."
  TGZ_URL="https://github.com/momo-api/momo-codex-bridge/releases/download/v0.5.8/momo-api-codex-bridge-0.5.8.tgz"
  
  if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$TGZ_URL" | tar -xz -C "$INSTALL_DIR" --strip-components=1 || git clone https://github.com/momo-api/momo-codex-bridge.git "$INSTALL_DIR"
elif command -v wget >/dev/null 2>&1; then
  wget -qO- "$TGZ_URL" | tar -xz -C "$INSTALL_DIR" --strip-components=1 || git clone https://github.com/momo-api/momo-codex-bridge.git "$INSTALL_DIR"
else
  git clone https://github.com/momo-api/momo-codex-bridge.git "$INSTALL_DIR"
fi

BRIDGE_BIN="$INSTALL_DIR/bin/momo-codex-bridge.mjs"
chmod +x "$BRIDGE_BIN"

echo "==> [momo-codex-bridge] Configuring Codex provider and syncing models..."
node "$BRIDGE_BIN" install --api-key "$API_KEY" --endpoint "$ENDPOINT" --port "$PORT"

echo "==> [momo-codex-bridge] Starting background daemon..."
if command -v lsof >/dev/null 2>&1; then
  lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
elif command -v fuser >/dev/null 2>&1; then
  fuser -k "$PORT/tcp" 2>/dev/null || true
fi
nohup node "$BRIDGE_BIN" serve > /dev/null 2>&1 &

echo ""
echo "=========================================================="
echo "  MOMO Codex Bridge installed and running successfully!   "
echo "=========================================================="
echo "Local Bridge is listening on: http://127.0.0.1:$PORT/v1"
echo "Run 'momo-codex-bridge doctor' to verify health."
