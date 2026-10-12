#!/usr/bin/env bash
# Derives Otterware's icons from the Otter Code production artwork in
# assets/otter: the same symbol, with its cream background mapped to deep teal so
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
# The current artwork has a cream tile and charcoal symbol.
background="#0b4f6c"
mkdir -p "$out"

recolor() {
  # Map the charcoal-to-cream range to white-to-teal; keep the export's alpha.
  im "$1" -colorspace Gray -level 18%,96% -negate -colorspace sRGB \
    \( -size 1x256 "gradient:${background}-#ffffff" \) -channel RGB -clut +channel \
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

# Match the new vector favicon to the suite palette in both color schemes.
sed -e "s/\.tile { fill: #f8f5ec; }/.tile { fill: ${background}; }/" \
  -e 's/\.glyph { fill: #2c2f31; }/.glyph { fill: #ffffff; }/' \
  -e "/@media (prefers-color-scheme: dark)/d" \
  "$src/otter-web-favicon.svg" > "$out/otterware-web-favicon.svg"
