#!/usr/bin/env bash
# Records the demo video into docs/assets/demo.mp4 and demo.gif. See docs/development.md.
# UPDATE_EXPECTED=1 rewrites demo/expected.txt from this take instead of checking against it.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STAGE=/tmp/pi-marimo-demo
FOLEY_VERSION=0.1.0
for tool in pi uvx ffmpeg ffprobe curl node; do command -v "$tool" >/dev/null || { echo "demo: $tool is not on PATH" >&2; exit 1; }; done

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=darwin_arm64 SHA=f859833a39577f263ef0c15e46f295ba5c0b5e85b48bc8a8630c34d7635d0fea ;;
  Darwin-x86_64) PLATFORM=darwin_amd64 SHA=25a6d9ba7625d674fc18fc7504aec8f34354c26c210d51e1c7959b562fd16d74 ;;
  Linux-x86_64) PLATFORM=linux_amd64 SHA=5983539384d9927be3603b286179ca7965dd5b7a7837b06fb34cc1cd78f9dd28 ;;
  Linux-aarch64 | Linux-arm64) PLATFORM=linux_arm64 SHA=d39d7c9fd05bf2d90759588f70ab8c2719f541b651634be024894bf29a168be7 ;;
  *) echo "demo: foley has no build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/pi-marimo/foley-$FOLEY_VERSION"
FOLEY="$CACHE/foley"
if [ ! -x "$FOLEY" ]; then
  mkdir -p "$CACHE"
  curl -fsSL -o "$CACHE/foley.tar.gz" "https://github.com/GH-Jaider/foley/releases/download/v$FOLEY_VERSION/foley_${FOLEY_VERSION}_$PLATFORM.tar.gz"
  if command -v sha256sum >/dev/null; then echo "$SHA  $CACHE/foley.tar.gz" | sha256sum -c - >/dev/null
  else echo "$SHA  $CACHE/foley.tar.gz" | shasum -a 256 -c - >/dev/null; fi
  tar -xzf "$CACHE/foley.tar.gz" -C "$CACHE" foley
  rm "$CACHE/foley.tar.gz"
fi

# Captions are drawn in Inter, from its release tag.
FONT="${XDG_CACHE_HOME:-$HOME/.cache}/pi-marimo/InterVariable-4.1.ttf"
if [ ! -f "$FONT" ]; then
  mkdir -p "$(dirname "$FONT")"
  curl -fsSL -o "$FONT.part" "https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable.ttf"
  FONT_SHA=4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf
  if command -v sha256sum >/dev/null; then echo "$FONT_SHA  $FONT.part" | sha256sum -c - >/dev/null
  else echo "$FONT_SHA  $FONT.part" | shasum -a 256 -c - >/dev/null; fi
  mv "$FONT.part" "$FONT"
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/.pi" "$STAGE/.agent"
cp "$REPO/examples/demo.py" "$STAGE/demo.py"
cp "$REPO/demo/marimo.json" "$STAGE/.pi/marimo.json"
cp "$REPO/demo/pi-settings.json" "$STAGE/.agent/settings.json"
cp "$REPO/demo/launch.sh" "$STAGE/launch.sh"
# Resolve the pinned marimo environment before the take, so the server starts in the same time on every take.
node -e 'const c = require(process.argv[1]).server.command; require("node:child_process").execFileSync(c[0], [...c.slice(1), "--version"], { stdio: "ignore" })' "$REPO/demo/marimo.json"

OUT="$(mktemp -d)"
echo "demo: recording in $OUT (about 90 seconds)"
(cd "$OUT" && "$FOLEY" -mode realtime -dir "$STAGE" -env "PI_MARIMO_REPO=$REPO" "$REPO/demo/demo.tape")

normalize() {
  sed -E -e 's/:[0-9]{4,5}/:PORT/g' -e 's/[0-9]+(\.[0-9]+)?(ms|s|m) ago|just now/AGO/g' -e 's/ran [0-9]+(\.[0-9]+)?(ms|s|m)/ran N/g' \
    -e 's/[0-9]+ ms/N ms/g' -e 's/· [0-9]+(\.[0-9]+)?s/· Ns/g' -e 's/^[^│]*\(auto\)[^│]*│/FOOTER│/' "$1"
}
if grep -qE "Error:|Warning:" "$OUT/demo.txt"; then echo "demo: the take shows an error or warning; see $OUT/demo.txt" >&2; exit 1; fi
if [ "${UPDATE_EXPECTED:-}" = 1 ]; then
  normalize "$OUT/demo.txt" > "$REPO/demo/expected.txt"
  echo "demo: wrote demo/expected.txt"
elif ! diff -u "$REPO/demo/expected.txt" <(normalize "$OUT/demo.txt"); then
  echo "demo: the final screen differs from demo/expected.txt; take kept in $OUT, docs/assets untouched" >&2
  exit 1
fi

uvx -q --with pillow==13.0.0 python "$REPO/demo/annotate.py" "$OUT/take.mp4" "$OUT/take.cast" "$REPO/demo/captions.json" "$FONT" "$OUT/demo.mp4"
ffmpeg -v error -y -i "$OUT/demo.mp4" -vf "fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "$OUT/demo.gif"
mkdir -p "$REPO/docs/assets"
cp "$OUT/demo.mp4" "$OUT/demo.gif" "$REPO/docs/assets/"
echo "demo: docs/assets/demo.mp4 and demo.gif updated; beat screenshots in $OUT"
