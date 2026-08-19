#!/bin/bash
# Rebuild Smoke's icon set from the source mark.
# Usage: bash assets/make-icons.sh [path-to-source.png]
set -e
cd "$(dirname "$0")"

SRC="${1:-mark-source.png}"
FF="../node_modules/ffmpeg-static/ffmpeg"
[ -x "$FF" ] || FF=$(command -v ffmpeg)

# tight bounding box of the mark inside the source screenshot
CROP="crop=212:211:37:43"

echo "==> transparent mark"
# geq's lum() needs a luma plane, so build the alpha on a gray copy first:
# cream goes transparent, the mark stays solid, edges stay antialiased.
"$FF" -y -loglevel error -i "$SRC" \
  -vf "${CROP},scale=1024:1024:flags=lanczos,format=gray,geq=lum='clip((235-lum(X,Y))*255/195,0,255)'" \
  -frames:v 1 mark-alpha.png

for pair in "black:0x000000" "white:0xffffff"; do
  name="${pair%%:*}"; col="${pair##*:}"
  "$FF" -y -loglevel error -f lavfi -i "color=c=${col}:s=1024x1024" -i mark-alpha.png \
    -filter_complex "[0:v]format=rgba[c];[1:v]format=gray[m];[c][m]alphamerge" \
    -frames:v 1 "mark-${name}.png"
done

echo "==> menubar template icons"
# macOS tints template images automatically, so a black shape plus alpha is all
# that is needed. 18pt tall matches the menubar.
sips -Z 18 mark-black.png --out smokeTemplate.png >/dev/null
sips -Z 36 mark-black.png --out smokeTemplate@2x.png >/dev/null

echo "==> app icon"
# 1024 canvas, cream rounded square inset to Apple's grid, mark centred on top
SQ=824; R=185; OFF=100; MARK=520
"$FF" -y -loglevel error -f lavfi -i "color=c=black:s=${SQ}x${SQ}" \
  -vf "format=gray,geq=lum='if(lt(X,${R})*lt(Y,${R}), if(lte(pow(X-${R},2)+pow(Y-${R},2),$((R*R))),255,0), if(gt(X,$((SQ-R)))*lt(Y,${R}), if(lte(pow(X-$((SQ-R)),2)+pow(Y-${R},2),$((R*R))),255,0), if(lt(X,${R})*gt(Y,$((SQ-R))), if(lte(pow(X-${R},2)+pow(Y-$((SQ-R)),2),$((R*R))),255,0), if(gt(X,$((SQ-R)))*gt(Y,$((SQ-R))), if(lte(pow(X-$((SQ-R)),2)+pow(Y-$((SQ-R)),2),$((R*R))),255,0), 255))))'" \
  -frames:v 1 sq-mask.png

# overlay flattens the alpha of its base, so compose the mark onto an opaque
# cream tile first and apply the rounded-corner alpha last. alphamerge then
# defines the transparency outright rather than inheriting overlay's result.
"$FF" -y -loglevel error -f lavfi -i "color=c=0xf7efea:s=${SQ}x${SQ}" -i mark-black.png \
  -filter_complex "[1:v]format=rgba,scale=${MARK}:${MARK}[mk];[0:v][mk]overlay=(W-w)/2:(H-h)/2:format=auto" \
  -frames:v 1 flat.png

"$FF" -y -loglevel error -i flat.png -i sq-mask.png \
  -filter_complex "[0:v]format=rgba[c];[1:v]format=gray[m];[c][m]alphamerge,pad=1024:1024:${OFF}:${OFF}:color=black@0" \
  -frames:v 1 -pix_fmt rgba icon_1024.png

echo "==> icns"
rm -rf Smoke.iconset && mkdir -p Smoke.iconset
for s in 16 32 64 128 256 512; do
  sips -Z $s icon_1024.png --out "Smoke.iconset/icon_${s}x${s}.png" >/dev/null
  sips -Z $((s*2)) icon_1024.png --out "Smoke.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
mv Smoke.iconset/icon_512x512@2x.png Smoke.iconset/icon_1024x1024.png 2>/dev/null || true
sips -Z 1024 icon_1024.png --out Smoke.iconset/icon_512x512@2x.png >/dev/null
iconutil -c icns Smoke.iconset -o icon.icns

rm -f sq-mask.png flat.png
echo "done: icon.icns, smokeTemplate.png, smokeTemplate@2x.png"
