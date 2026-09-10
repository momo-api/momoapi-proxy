#!/usr/bin/env bash
set -euo pipefail

API_KEY="${1:-${MOMO_API_KEY:-}}"
ENDPOINT="${MOMO_API_ENDPOINT:-https://momoapi.us}"
PORT="${MOMO_BRIDGE_PORT:-18789}"

echo "==> [momo-codex-bridge] Checking Node.js environment..."
if ! command -v node >/dev/null 2>&1; then
  echo "==> ERROR: Node.js 22+ is required. Please install Node.js from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -v | tr -d 'v' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "==> ERROR: Node.js version must be >= 22; found $(node -v)"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  read -rp "Enter your MOMO API Key (e.g. sk-momo-...): " API_KEY
fi

if [ -z "$API_KEY" ]; then
  echo "==> ERROR: MOMO API Key is required."
  exit 1
fi

INSTALL_ROOT="$HOME/.momoapi-proxy"
INSTALL_DIR="$INSTALL_ROOT/app"
STAGING_DIR="$INSTALL_ROOT/.install-$RANDOM-$RANDOM"
TGZ_PATH="$INSTALL_ROOT/package.tgz"
MANIFEST_PATH="$INSTALL_ROOT/bridge-latest.json"
mkdir -p "$INSTALL_ROOT" "$STAGING_DIR"
echo "==> [momo-codex-bridge] Reading and verifying the official release manifest..."
curl -fsSL --connect-timeout 10 --max-time 20 "https://momoapi.us/install/bridge-latest.json" -o "$MANIFEST_PATH"
readarray -t RELEASE < <(node - "$MANIFEST_PATH" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version || '') || !/^[a-f0-9]{64}$/i.test(value.sha256 || '')) process.exit(2);
process.stdout.write(value.version + '\n' + String(value.sha256).toLowerCase());
NODE
)
if [ "${#RELEASE[@]}" -lt 2 ]; then echo "==> ERROR: Official release manifest is invalid or missing SHA-256." >&2; exit 1; fi
VERSION="${RELEASE[0]}"
EXPECTED_SHA256="${RELEASE[1]}"
URLS=("https://momoapi.us/install/packages/momoapi-proxy-${VERSION}.tgz" "https://github.com/momo-api/momoapi-proxy/releases/download/v${VERSION}/momoapi-proxy-${VERSION}.tgz")
DOWNLOADED=0
for url in "${URLS[@]}"; do
  if curl -fsSL --connect-timeout 10 --max-time 120 "$url" -o "$TGZ_PATH" && [ "$(sha256sum "$TGZ_PATH" | awk '{print $1}')" = "$EXPECTED_SHA256" ]; then DOWNLOADED=1; break; fi
done
if [ "$DOWNLOADED" -ne 1 ]; then echo "==> ERROR: No release package matched the official SHA-256." >&2; exit 1; fi
tar -xzf "$TGZ_PATH" -C "$STAGING_DIR" --strip-components=1 --no-same-owner --no-same-permissions
PACKAGE_VERSION="$(node -p "require(process.argv[1]).version" "$STAGING_DIR/package.json")"
[ "$PACKAGE_VERSION" = "$VERSION" ] || { echo "==> ERROR: Package version does not match manifest." >&2; exit 1; }
rm -rf "$INSTALL_DIR"
mv "$STAGING_DIR" "$INSTALL_DIR"
rm -f "$TGZ_PATH" "$MANIFEST_PATH"

BRIDGE_BIN="$INSTALL_DIR/bin/momoapi-proxy.mjs"
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
