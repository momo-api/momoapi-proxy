#!/usr/bin/env bash
set -euo pipefail

API_KEY=""
if [ "${1:-}" = "--api-key-env" ]; then API_KEY="${MOMO_API_KEY:-}"; fi
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
  if [ ! -r /dev/tty ]; then echo "==> ERROR: Run in a terminal or explicitly use --api-key-env." >&2; exit 1; fi
  IFS= read -r -s -p "Enter a new MOMO API Key (hidden; blank cancels): " API_KEY </dev/tty
  printf '\n' >/dev/tty
fi

if [ -z "$API_KEY" ]; then
  echo "==> ERROR: MOMO API Key is required."
  exit 1
fi

INSTALL_ROOT="$HOME/.momoapi-proxy"
INSTALL_DIR="$INSTALL_ROOT/app"
STAGING_DIR="$INSTALL_ROOT/.momoapi-proxy-update-install-$RANDOM-$RANDOM"
BACKUP_DIR="$INSTALL_DIR.install-backup-$RANDOM-$RANDOM"
TGZ_PATH="$INSTALL_ROOT/package.tgz"
MANIFEST_PATH="$INSTALL_ROOT/bridge-latest.json"
mkdir -p "$INSTALL_ROOT" "$STAGING_DIR"
echo "==> [momo-codex-bridge] Reading and verifying the official release manifest..."
curl -fsSL --connect-timeout 10 --max-time 20 "https://momoapi.us/install/bridge-latest.json" -o "$MANIFEST_PATH"
RELEASE_TEXT="$(node - "$MANIFEST_PATH" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version || '') || !/^[a-f0-9]{64}$/i.test(value.sha256 || '')) process.exit(2);
process.stdout.write(value.version + '\n' + String(value.sha256).toLowerCase());
NODE
)"
VERSION="$(printf '%s\n' "$RELEASE_TEXT" | sed -n '1p')"
EXPECTED_SHA256="$(printf '%s\n' "$RELEASE_TEXT" | sed -n '2p')"
URLS=("https://momoapi.us/install/packages/momoapi-proxy-${VERSION}.tgz" "https://github.com/momo-api/momoapi-proxy/releases/download/v${VERSION}/momoapi-proxy-${VERSION}.tgz")
DOWNLOADED=0
for url in "${URLS[@]}"; do
  if curl -fsSL --connect-timeout 10 --max-time 120 "$url" -o "$TGZ_PATH" && [ "$(node -e 'const f=require("fs"),c=require("crypto"); process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TGZ_PATH")" = "$EXPECTED_SHA256" ]; then DOWNLOADED=1; break; fi
done
if [ "$DOWNLOADED" -ne 1 ]; then echo "==> ERROR: No release package matched the official SHA-256." >&2; exit 1; fi
tar -xzf "$TGZ_PATH" -C "$STAGING_DIR" --strip-components=1
PACKAGE_VERSION="$(node -p "require(process.argv[1]).version" "$STAGING_DIR/package.json")"
[ "$PACKAGE_VERSION" = "$VERSION" ] || { echo "==> ERROR: Package version does not match manifest." >&2; exit 1; }
grep -q -- '--api-key-stdin' "$STAGING_DIR/bin/momoapi-proxy.mjs" || { echo "==> ERROR: Release lacks safe credential input; installation was not changed." >&2; exit 1; }
if [ -d "$INSTALL_DIR" ]; then mv "$INSTALL_DIR" "$BACKUP_DIR"; fi
if ! mv "$STAGING_DIR" "$INSTALL_DIR"; then
  if [ -d "$BACKUP_DIR" ]; then mv "$BACKUP_DIR" "$INSTALL_DIR"; fi
  exit 1
fi
rm -f "$TGZ_PATH" "$MANIFEST_PATH"

BRIDGE_BIN="$INSTALL_DIR/bin/momoapi-proxy.mjs"
chmod +x "$BRIDGE_BIN"

echo "==> [momo-codex-bridge] Configuring Codex provider and syncing models..."
if ! printf '%s\n' "$API_KEY" | node "$BRIDGE_BIN" install --api-key-stdin --endpoint "$ENDPOINT" --port "$PORT"; then
  rm -rf "$INSTALL_DIR"
  if [ -d "$BACKUP_DIR" ]; then mv "$BACKUP_DIR" "$INSTALL_DIR"; fi
  echo "==> ERROR: App directory restored if present; Key/settings may have changed. This is not a full rollback." >&2
  exit 1
fi
unset API_KEY

if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
  echo "==> [momo-codex-bridge] Waiting for the macOS LaunchAgent..."
else
  echo "==> [momo-codex-bridge] Starting authenticated managed daemon..."
  if ! node "$BRIDGE_BIN" start; then
    echo "==> ERROR: Authenticated daemon activation failed; Key/settings may have changed. Check momoapi doctor." >&2
    exit 1
  fi
fi

healthy=0
attempt=0
while [ "$attempt" -lt 20 ]; do
  if node "$BRIDGE_BIN" status | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{try{const v=JSON.parse(s);process.exit(v.authenticatedRuntime&&v.runtimeVersion===process.argv[1]?0:1)}catch{process.exit(1)}})' "$VERSION"; then
    healthy=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.25
done
if [ "$healthy" -ne 1 ]; then
  node "$BRIDGE_BIN" rollback >/dev/null 2>&1 || true
  echo "==> ERROR: MOMO API Proxy did not become healthy." >&2
  exit 1
fi

echo ""
echo "=========================================================="
echo "  MOMO Codex Bridge installed and running successfully!   "
echo "=========================================================="
echo "Local Bridge is listening on: http://127.0.0.1:$PORT/v1"
echo "Run 'momo-codex-bridge doctor' to verify health."
