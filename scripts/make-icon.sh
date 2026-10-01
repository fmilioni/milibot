#!/bin/bash
# Regenerates the app icons from apps/desktop/build/icon.svg:
#   icon.icns (macOS only: sips + iconutil), icons/<N>x<N>.png (Linux) and icon.ico (Windows).
# PNGs come from sips on macOS or rsvg-convert (librsvg2-bin) / ImageMagick elsewhere; the .ico is
# packed from the PNGs by scripts/make-ico.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/apps/desktop/build"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
SIZES="16 24 32 48 64 128 256 512 1024"

raster() { # <size> <out.png>
  if command -v sips >/dev/null; then
    [ -f "$WORK/icon-1024.png" ] || sips -s format png "$BUILD_DIR/icon.svg" --out "$WORK/icon-1024.png" >/dev/null
    sips -z "$1" "$1" "$WORK/icon-1024.png" --out "$2" >/dev/null
  elif command -v rsvg-convert >/dev/null; then
    rsvg-convert -w "$1" -h "$1" "$BUILD_DIR/icon.svg" -o "$2"
  elif command -v magick >/dev/null; then
    magick -background none -density 384 "$BUILD_DIR/icon.svg" -resize "$1x$1" "$2"
  else
    echo "need sips (macOS), rsvg-convert (librsvg2-bin) or ImageMagick" >&2
    exit 1
  fi
}

mkdir -p "$BUILD_DIR/icons"
for size in $SIZES; do raster "$size" "$BUILD_DIR/icons/${size}x${size}.png"; done
node "$ROOT/scripts/make-ico.mjs" "$BUILD_DIR/icon.ico" "$BUILD_DIR"/icons/{16x16,24x24,32x32,48x48,64x64,128x128,256x256}.png
echo "wrote $BUILD_DIR/icons/*.png and $BUILD_DIR/icon.ico"

if command -v iconutil >/dev/null; then
  ICONSET="$WORK/icon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    raster "$size" "$ICONSET/icon_${size}x${size}.png"
    raster $((size * 2)) "$ICONSET/icon_${size}x${size}@2x.png"
  done
  iconutil -c icns "$ICONSET" -o "$BUILD_DIR/icon.icns"
  echo "wrote $BUILD_DIR/icon.icns"
fi
