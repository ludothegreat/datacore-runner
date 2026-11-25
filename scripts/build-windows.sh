#!/usr/bin/env bash
# Builds the Windows screensaver test package from this Linux machine.
#
#   bash scripts/build-windows.sh
#
# Result: dist/DatacoreRunner-windows-test.zip
#
# How: bundle the page into one script (esbuild), drop it with the wrapper from desktop/ into a
# stock Electron for Windows download, and rename electron.exe to DatacoreRunner.scr.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_VERSION="$(node -p "require('$ROOT/node_modules/electron/package.json').version")"
ZIP_NAME="electron-v${ELECTRON_VERSION}-win32-x64.zip"
BASE_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}"
CACHE="$ROOT/build/cache"
APP="$ROOT/build/app"
OUT="$ROOT/build/win/DatacoreRunner"
DIST="$ROOT/dist"

log() { printf '[build %s] %s\n' "$(date +%T)" "$*"; }

log "checks"
(cd "$ROOT" && npm run check && npm test)

log "bundling the page"
rm -rf "$APP"
mkdir -p "$APP/web"
(cd "$ROOT" && npx esbuild main.js --bundle --format=esm --target=es2022 --outfile="$APP/web/main.js" --log-level=warning)
# The bundle already contains three.js, so the page no longer needs the import map.
python3 - "$ROOT/index.html" "$APP/web/index.html" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
out, n = re.subn(r'<script type="importmap">.*?</script>\n', "", src, flags=re.S)
if n != 1:
    sys.exit(f"expected exactly one importmap block in index.html, found {n}")
open(sys.argv[2], "w", encoding="utf-8").write(out)
PY
cp "$ROOT/desktop/config.html" "$ROOT/desktop/blank.html" "$APP/web/"
cp "$ROOT/desktop/main.cjs" "$ROOT/desktop/preload.cjs" "$ROOT/desktop/args.cjs" "$ROOT/desktop/package.json" "$APP/"

if [[ "${1:-}" == "--app-only" ]]; then
  log "app folder ready: $APP"
  exit 0
fi

log "electron $ELECTRON_VERSION for Windows"
mkdir -p "$CACHE"
if [[ ! -f "$CACHE/$ZIP_NAME" ]]; then
  curl --fail --location --silent --show-error -o "$CACHE/$ZIP_NAME.part" "$BASE_URL/$ZIP_NAME"
  mv "$CACHE/$ZIP_NAME.part" "$CACHE/$ZIP_NAME"
fi
curl --fail --location --silent --show-error -o "$CACHE/SHASUMS256-$ELECTRON_VERSION.txt" "$BASE_URL/SHASUMS256.txt"
want="$(awk -v f="*$ZIP_NAME" '$2 == f {print $1}' "$CACHE/SHASUMS256-$ELECTRON_VERSION.txt")"
have="$(sha256sum "$CACHE/$ZIP_NAME" | awk '{print $1}')"
if [[ -z "$want" || "$want" != "$have" ]]; then
  echo "checksum mismatch for $ZIP_NAME: want '$want' have '$have'" >&2
  exit 1
fi
log "checksum ok"

log "assembling"
rm -rf "$ROOT/build/win"
mkdir -p "$OUT"
unzip -q "$CACHE/$ZIP_NAME" -d "$OUT"
rm "$OUT/resources/default_app.asar"
cp -r "$APP" "$OUT/resources/app"
mv "$OUT/electron.exe" "$OUT/DatacoreRunner.scr"
# English only: the other language packs are for Chromium's own menus, which never show.
find "$OUT/locales" -name '*.pak' ! -name 'en-US.pak' -delete
cp "$ROOT/desktop/README.txt" "$OUT/README.txt"
unix2dos -q "$OUT/README.txt" 2>/dev/null || sed -i 's/$/\r/' "$OUT/README.txt"

log "zipping"
mkdir -p "$DIST"
rm -f "$DIST/DatacoreRunner-windows-test.zip"
(cd "$ROOT/build/win" && zip -qr "$DIST/DatacoreRunner-windows-test.zip" DatacoreRunner)
log "done: $DIST/DatacoreRunner-windows-test.zip ($(du -h "$DIST/DatacoreRunner-windows-test.zip" | cut -f1))"
