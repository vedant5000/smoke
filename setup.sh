#!/bin/bash
# One command to get Smoke running on a new Mac.
#
#   bash setup.sh
#
# Installs dependencies, fetches the ffmpeg binaries (too big for git), creates
# a stable signing identity so macOS stops revoking Screen Recording, and builds
# the app. Bunny credentials are NOT handled here: the app asks for them on
# first launch and saves them per user.
#
# Safe to re-run. Every step skips itself if it is already done.
set -e
cd "$(dirname "$0")"

echo "=============================================="
echo " Smoke setup"
echo "=============================================="
echo

if [ "$(uname)" != "Darwin" ]; then
  echo "Smoke is macOS only (it uses ScreenCaptureKit and the macOS menubar)."
  exit 1
fi

# ---- 1. node ----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it, then run this again:"
  echo
  echo "    brew install node"
  echo
  echo "No Homebrew? Download the macOS installer from https://nodejs.org"
  exit 1
fi
echo "==> node $(node -v)"

# ---- 2. dependencies --------------------------------------------------------
if [ -d node_modules/electron ]; then
  echo "==> dependencies already installed"
else
  echo "==> installing dependencies (several minutes, it downloads Electron)"
  npm install
fi

# ---- 3. ffmpeg / ffprobe ----------------------------------------------------
# ~250MB of binaries. Gitignored and fetched instead, which keeps the repo small
# and means you get the build that matches this version of ffmpeg-static.
echo "==> fetching ffmpeg and ffprobe"
bash vendor-binaries.sh

# ---- 4. signing identity ----------------------------------------------------
# Without this, macOS treats every rebuild as a brand new app and throws away
# the Screen Recording permission you just granted.
echo "==> signing identity"
bash make-signing-cert.sh

# ---- 5. build ---------------------------------------------------------------
echo
echo "==> building"
bash build.sh

cat <<'DONE'

==============================================
 Done. Smoke is in /Applications.
==============================================

Open it. It lives in the MENUBAR, not the Dock: look for the mark up by the
clock, not for a window.

Two things happen on first launch:

  1. Smoke asks for your Bunny library ID and Stream API key.
     Both are on one page: dash.bunny.net > Stream > your library > API.
     It checks them with Bunny before saving, so a wrong paste is caught
     straight away rather than at the end of your first recording.

  2. macOS asks for Screen Recording, Camera and Microphone permission.
     Grant Screen Recording, then QUIT AND REOPEN Smoke. macOS only applies
     that particular grant when the app restarts. Until you do, the source
     list comes up empty and Start stays disabled.

     System Settings > Privacy & Security > Screen & System Audio Recording

After any code change, run: bash build.sh
A packaged app is a frozen snapshot, so edits do nothing until you rebuild.

Anything odd, read SETUP.md.
DONE
