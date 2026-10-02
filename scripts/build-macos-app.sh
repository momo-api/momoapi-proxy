#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/macos/MOMO API Proxy.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/package.json")"
for ARCH in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -parse-as-library -O -target "$ARCH-apple-macosx13.0" "$ROOT/src-macos/MomoMenuBar.swift" -o "$ROOT/dist/macos/MomoMenuBar-$ARCH"
done
lipo -create "$ROOT/dist/macos/MomoMenuBar-arm64" "$ROOT/dist/macos/MomoMenuBar-x86_64" -output "$APP/Contents/MacOS/MomoMenuBar"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>us.momoapi.menu-bar</string>
<key>CFBundleName</key><string>MOMO API Proxy</string>
<key>CFBundleExecutable</key><string>MomoMenuBar</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$VERSION</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
plutil -lint "$APP/Contents/Info.plist"
if [ -n "${MOMO_MAC_SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$MOMO_MAC_SIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP"
  if [ -n "${MOMO_MAC_NOTARY_PROFILE:-}" ]; then
    ditto -c -k --keepParent "$APP" "$ROOT/dist/macos/notarization.zip"
    xcrun notarytool submit "$ROOT/dist/macos/notarization.zip" --keychain-profile "$MOMO_MAC_NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
    spctl --assess --type execute "$APP"
    mkdir -p "$ROOT/resources/macos"
    ditto "$APP" "$ROOT/resources/macos/MOMO API Proxy.app"
  fi
else
  echo 'Build-only artifact: unsigned app is NOT included in the installable release.'
fi
