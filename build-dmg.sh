#!/bin/bash
# Build a distributable Smoke.dmg that runs on both Apple Silicon and Intel.
#
#   bash build-dmg.sh
#
# The app ships both ffmpeg/ffprobe slices from vendor/bin and picks the right
# one at runtime, so a single universal bundle really does work on either Mac.
set -e
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
OUT="dist/Smoke-$VERSION.dmg"
STAGE="dist/dmg-stage"
IDENTITY="Smoke Local Signing"

if [ ! -f vendor/bin/ffmpeg-x64 ] || [ ! -f vendor/bin/ffmpeg-arm64 ]; then
  echo "Missing vendor/bin binaries. Run: bash vendor-binaries.sh"
  exit 1
fi

echo "==> packaging universal app (downloads the Intel Electron the first time)"
rm -rf dist/Smoke-darwin-universal
node pack-universal.js >/dev/null

APP="dist/Smoke-darwin-universal/Smoke.app"
[ -d "$APP" ] || { echo "packaging failed"; exit 1; }
cp assets/icon.icns "$APP/Contents/Resources/electron.icns"
chmod +x "$APP/Contents/Resources/app/vendor/bin/"* 2>/dev/null || true

# Credentials are NOT bundled by default. The app asks for them on first launch
# and saves them per user, so a DMG you hand to someone should carry none of
# yours: a shared disk image is the easiest way to leak a key by accident.
#
# Pass --with-credentials only for a build you are keeping yourself. Even then
# the account key is stripped, since it can create and delete whole libraries
# and is never read at runtime.
if [ "$1" = "--with-credentials" ] && [ -f .env ]; then
  grep -E '^(BUNNY_LIBRARY_ID|BUNNY_STREAM_API_KEY|BUNNY_CDN_HOSTNAME)=' .env \
    > "$APP/Contents/Resources/.env"
  echo "   !! bundled Bunny library $(grep -E '^BUNNY_LIBRARY_ID=' .env | cut -d= -f2) - do not share this DMG"
else
  echo "   no credentials bundled, the app will ask on first launch"
fi

echo "==> signing"
# A universal bundle has nested frameworks that the merge leaves unsigned, and
# signing only the outer bundle fails on them. --deep signs inside out. It is
# deprecated for App Store submission but correct for a locally shared build.
# Errors are NOT swallowed here: an unsigned app means Gatekeeper is harsher and
# the recipient's Screen Recording grant will not survive a reinstall.
if security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
  codesign --force --deep --timestamp=none -s "$IDENTITY" "$APP"
else
  echo "   no '$IDENTITY' certificate; signing ad-hoc"
  echo "   run: bash make-signing-cert.sh"
  codesign --force --deep --sign - "$APP"
fi

if ! codesign --verify --strict "$APP" 2>/dev/null; then
  echo "   signature did not verify, refusing to ship a broken bundle"
  exit 1
fi
echo "   signature verified"

echo "==> staging the disk image"
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/Smoke.app"
ln -s /Applications "$STAGE/Applications"

# The Gatekeeper step is the one thing that will stop someone cold, so it leads.
cat > "$STAGE/READ ME FIRST.txt" <<'TXT'
Installing Smoke
================

STEP 1  Drag Smoke onto the Applications folder shown next to it.


STEP 2  Unblock it. This takes one command and you only ever do it once.

macOS blocks apps that have not been through Apple's paid developer
programme. It will say "Apple cannot check it for malicious software".
That is expected and it is not a problem with the app.

On macOS 15 and later there is no "Open Anyway" button in that dialog,
so the old right click trick does not work. Do this instead:

  1. Open Terminal.
     Press Command + Space, type Terminal, press Return.

  2. Copy this line, paste it into Terminal, press Return:

     xattr -dr com.apple.quarantine /Applications/Smoke.app

  3. Nothing will appear to happen. That means it worked.

Now open Smoke from Applications normally.


STEP 3  Give it permission.

macOS will ask for Screen Recording, Camera and Microphone.
After you allow Screen Recording you have to quit Smoke and open it again,
because macOS only applies that one on a fresh start.


USING IT

Smoke lives in the menubar at the top of the screen, not in the Dock.
Click the flower icon to start a recording.

When you stop, the editor opens. Publish uploads the video and copies the
share link to your clipboard.
TXT

echo "==> building $OUT"
hdiutil create -volname "Smoke" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
rm -rf "$STAGE"

SIZE=$(du -h "$OUT" | awk '{print $1}')
echo
echo "Done: $OUT  ($SIZE)"
echo "Send that file. On the other Mac: drag to Applications, then right click > Open the first time."
