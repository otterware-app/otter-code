#!/usr/bin/env bash
# Derives Otterware's icons from the Otter Code production artwork in
# assets/otter: the same otter, with its black background mapped to deep teal so
# the two apps are told apart in a dock or launcher. Needs ImageMagick 6 or 7.
# Rerun after assets/otter changes and commit assets/otterware.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if command -v magick >/dev/null 2>&1; then
  im() { magick "$@"; }
else
  im() { convert "$@"; }
fi

src=assets/otter
out=assets/otterware
# The artwork is grayscale: black maps to the background colour, white stays white.
background="#0b4f6c"
mkdir -p "$out"

recolor() {
  # Only the colour channels go through the lookup; the macOS export's
  # transparent safe area and shadow keep their alpha.
  im "$1" \( -size 1x256 "gradient:${background}-#ffffff" \) -channel RGB -clut +channel \
    -strip "$2"
}

recolor "$src/otter-macos-1024.png" "$out/otterware-macos-1024.png"
recolor "$src/otter-universal-1024.png" "$out/otterware-universal-1024.png"
recolor "$src/otter-web-apple-touch-180.png" "$out/otterware-web-apple-touch-180.png"
recolor "$src/otter-web-favicon-16x16.png" "$out/otterware-web-favicon-16x16.png"
recolor "$src/otter-web-favicon-32x32.png" "$out/otterware-web-favicon-32x32.png"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for size in 16 24 32 48 64 128 256; do
  im "$out/otterware-universal-1024.png" -resize "${size}x${size}" -strip "$tmp/$size.png"
done
im "$tmp"/{16,24,32,48,64,128,256}.png "$out/otterware-web-favicon.ico"
