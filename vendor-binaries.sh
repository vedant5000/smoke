#!/bin/bash
# Fetch both architectures of ffmpeg and ffprobe into vendor/bin.
# The app picks the matching slice at runtime, which is what lets one universal
# build run on both Apple Silicon and Intel.
set -e
cd "$(dirname "$0")"
mkdir -p vendor/bin

TAG=$(node -p "require('./node_modules/ffmpeg-static/package.json')['binary-release-tag'] || 'b6.1.1'" 2>/dev/null || echo b6.1.1)
BASE="https://github.com/eugeneware/ffmpeg-static/releases/download/$TAG"

for arch in arm64 x64; do
  for tool in ffmpeg ffprobe; do
    out="vendor/bin/$tool-$arch"
    [ -s "$out" ] && { echo "have $tool-$arch"; continue; }
    echo "downloading $tool-$arch"
    curl -fsSL -o "$out" "$BASE/$tool-darwin-$arch"
    chmod +x "$out"
  done
done

echo
for f in vendor/bin/*; do
  printf "%-28s %s\n" "$f" "$(file -b "$f" | cut -d, -f1)"
done
