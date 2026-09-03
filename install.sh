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
  
  echo "==> [momo-codex-bridge] Downloading latest release..."
  URLS=(
    "${ENDPOINT%/}/install/packages/momo-api-codex-bridge-latest.tgz"
    "https://momoapi.us/install/packages/momo-api-codex-bridge-latest.tgz"
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.6.2/momo-api-codex-bridge-0.6.2.tgz"
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.6.2/momo-api-codex-bridge-0.6.2.tgz"
  )
  
  DOWNLOADED=0
  for url in "${URLS[@]}"; do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsSL --connect-timeout 10 "$url" | tar -xz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null; then
        DOWNLOADED=1
        break
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -qO- --timeout=10 "$url" | tar -xz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null; then
        DOWNLOADED=1
        break
      fi
    fi
  done

  if [ "$DOWNLOADED" -eq 0 ]; then
    echo "==> [momo-codex-bridge] Direct download failed, falling back to git clone..."
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
