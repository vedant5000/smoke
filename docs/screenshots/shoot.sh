#!/bin/bash
# Regenerate the README screenshots.
#
#   ./docs/screenshots/shoot.sh
#
# These are composed, not captured. Smoke marks its own windows as protected
# content so macOS keeps them out of every screen recorder, and pointing
# screencapture at a real session would put somebody's actual desktop into a
# public repo. Instead the REAL renderer pages are loaded in headless Chrome
# with a mock bridge standing in for Electron, over a synthetic desktop.
#
# Needs Google Chrome and Pillow (python3 -m pip install Pillow).
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
SRC="src"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME"; exit 1; }
python3 -c "import PIL" 2>/dev/null || { echo "Pillow required: python3 -m pip install Pillow"; exit 1; }

STAGE=$(mktemp -d /tmp/smoke-shots-XXXXX)
trap 'rm -rf "$STAGE"' EXIT
echo "==> staging in $STAGE"

# The real renderer, with the mock bridge injected as its first script. The
# shipping app never carries the bridge; it only exists in this copy.
cp -r "$ROOT/renderer" "$STAGE/renderer"
cp "$SRC/demo-bridge.js" "$STAGE/renderer/"
cp "$SRC/compose.html" "$SRC/desktop.html" "$SRC/avatar.html" "$STAGE/"
mkdir -p "$STAGE/assets" "$STAGE/media"
cp "$ROOT/assets/mark-black.png" "$STAGE/assets/"

python3 - "$STAGE" <<'PY'
import sys, os
stage = sys.argv[1]
d = os.path.join(stage, 'renderer')
for f in os.listdir(d):
    if f.endswith('.html'):
        p = os.path.join(d, f)
        s = open(p).read()
        open(p, 'w').write(s.replace('<head>', '<head>\n<script src="demo-bridge.js"></script>', 1))
# desktop.html sits one level higher in the staged copy than in src/
p = os.path.join(stage, 'desktop.html')
s = open(p).read()
open(p, 'w').write(s.replace('../../../assets/mark-black.png', 'assets/mark-black.png'))
PY

shot() { # out, url, w, h, [scale]
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --autoplay-policy=no-user-gesture-required --virtual-time-budget=8000 \
    --force-device-scale-factor="${5:-1}" --window-size="$3,$4" \
    --screenshot="$1" "$2" >/dev/null 2>&1
}

echo "==> building the frames the editor opens"
# The take Studio previews is the synthetic desktop itself. These are stills,
# not video: Chrome's virtual clock outruns media decoding, so a real <video>
# screenshots as an empty frame. demo-bridge.js feeds these to the preview.
shot "$STAGE/media/frame.png"  "file://$STAGE/desktop.html" 1920 1080
shot "$STAGE/media/avatar.png" "file://$STAGE/avatar.html"    720  720

echo "==> rendering"
for s in recorder setup studio publish recording; do
  shot "$STAGE/raw-$s.png" "file://$STAGE/compose.html?shot=$s" 1920 1080
done
# the windows on their own, at 2x, for the close-up crops
shot "$STAGE/raw-setup-win.png"  "file://$STAGE/compose.html?shot=setup&bare=1"  1920 1080 2
shot "$STAGE/raw-studio-win.png" "file://$STAGE/compose.html?shot=studio&bare=1" 1920 1080 2

echo "==> cropping"
python3 - "$STAGE" <<'PY'
import sys, os
from PIL import Image
stage = sys.argv[1]
HERE = os.getcwd()

def save(img, name, maxw=None):
    if maxw and img.width > maxw:
        img = img.resize((maxw, round(img.height * maxw / img.width)), Image.LANCZOS)
    img.convert("RGB").save(os.path.join(HERE, name), optimize=True, quality=92)
    print(f"   {name}  {img.width}x{img.height}")

full = lambda n: Image.open(os.path.join(stage, n)).convert("RGB")

save(full("raw-studio.png"),    "hero.png",      maxw=1600)
save(full("raw-recorder.png"),  "recorder.png",  maxw=1400)
save(full("raw-recording.png"), "recording.png", maxw=1400)
save(full("raw-publish.png"),   "publish.png",   maxw=1400)

# close-ups, cropped out of the 2x renders (window box * 2)
save(Image.open(os.path.join(stage, "raw-setup-win.png")).convert("RGB")
     .crop((1480, 470, 2360, 1690)), "setup.png", maxw=760)
save(Image.open(os.path.join(stage, "raw-studio-win.png")).convert("RGB")
     .crop((640, 260, 3200, 1900)), "studio.png", maxw=1600)
PY

echo "==> done"
