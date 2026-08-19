#!/bin/bash
# Rebuild Smoke.app from source, install to /Applications, and drop an alias on
# the Desktop. Run after any code change: bash build.sh
# A packaged app is a frozen snapshot, so edits do nothing until you run this.
set -e
cd "$(dirname "$0")"

# Build for whatever Mac this is. Hardcoding arm64 produces a bundle that will
# not launch on an Intel Mac. The DMG (build-dmg.sh) is the universal one.
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH=x64

echo "==> packaging for $ARCH"
npx @electron/packager . Smoke \
  --platform=darwin --arch=$ARCH --out=dist --overwrite \
  --app-bundle-id=com.sxv.smoke --app-version=1.0.0 \
  --icon=assets/icon.icns --extend-info=build-extra.plist \
  --prune=true \
  --ignore="^/dist" --ignore="^/extension" --ignore="\.log$" --ignore="^/\.env$" \
  --ignore="build-extra.plist" --ignore="^/assets/mark-source.png" \
  --ignore="^/assets/Smoke.iconset" \
  >/dev/null

APP="dist/Smoke-darwin-$ARCH/Smoke.app"

# packager writes the icon under its own name; drop our art in over it
cp assets/icon.icns "$APP/Contents/Resources/electron.icns"

# vendor/bin holds the binaries we actually run, one slice per architecture.
# The npm copies are dead weight, and ffprobe-static alone ships ~335MB of
# Linux and Windows builds this bundle will never touch.
rm -rf "$APP/Contents/Resources/app/node_modules/ffprobe-static/bin" 2>/dev/null || true
rm -f  "$APP/Contents/Resources/app/node_modules/ffmpeg-static/ffmpeg" 2>/dev/null || true

# This build only ever runs on this Mac, so drop the other architecture's
# binaries. The DMG keeps both, which is what makes it universal.
HOST=$ARCH
find "$APP/Contents/Resources/app/vendor/bin" -type f ! -name "*-$HOST" -delete 2>/dev/null || true
chmod +x "$APP/Contents/Resources/app/vendor/bin/"* 2>/dev/null || true

# credentials travel with the bundle but never with the repo
cp .env "$APP/Contents/Resources/.env" 2>/dev/null || echo "   (no .env found, add one before recording)"

echo "==> installing to /Applications"
pkill -f "/Applications/Smoke.app" 2>/dev/null || true
sleep 1
rm -rf /Applications/Smoke.app
cp -R "$APP" /Applications/Smoke.app

# macOS ties Screen Recording permission to the code signature. An ad-hoc
# signature changes on every rebuild, so the grant is revoked every time and you
# are asked again. Signing with a stable local identity keeps the grant.
# Create it once with: bash make-signing-cert.sh
IDENTITY="Smoke Local Signing"
if security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
  echo "   signing with '$IDENTITY'"
  # Electron bundles must be signed inside out: helpers and frameworks first
  find /Applications/Smoke.app/Contents/Frameworks -maxdepth 1 \( -name "*.app" -o -name "*.framework" \) -print0 2>/dev/null \
    | while IFS= read -r -d '' item; do
        codesign --force --timestamp=none -s "$IDENTITY" "$item" 2>/dev/null || true
      done
  find /Applications/Smoke.app/Contents/Resources/app/vendor/bin -type f -print0 2>/dev/null \
    | while IFS= read -r -d '' b; do codesign --force --timestamp=none -s "$IDENTITY" "$b" 2>/dev/null || true; done
  codesign --force --timestamp=none -s "$IDENTITY" /Applications/Smoke.app 2>/dev/null \
    || { echo "   signing failed, falling back to ad-hoc"; codesign --force --deep --sign - /Applications/Smoke.app 2>/dev/null || true; }
else
  echo "   no local signing identity found, using ad-hoc"
  echo "   (macOS will re-ask for Screen Recording after every rebuild)"
  echo "   run: bash make-signing-cert.sh   to fix that permanently"
  codesign --force --deep --sign - /Applications/Smoke.app 2>/dev/null || true
fi
touch /Applications/Smoke.app

echo "==> Desktop alias"
rm -f "$HOME/Desktop/Smoke.app" "$HOME/Desktop/Smoke.app alias"
if osascript -e 'tell application "Finder" to make alias file to POSIX file "/Applications/Smoke.app" at POSIX file "'"$HOME"'/Desktop"' >/dev/null 2>&1; then
  # Finder names it "Smoke.app alias"; drop the suffix
  [ -e "$HOME/Desktop/Smoke.app alias" ] && mv -f "$HOME/Desktop/Smoke.app alias" "$HOME/Desktop/Smoke.app"
  echo "   alias created"
else
  echo "   could not create the alias, open /Applications instead"
fi

echo
echo "Smoke installed. Open it from /Applications or the Desktop."
echo "It lives in the menubar: click the mark to record, right click for the menu."
