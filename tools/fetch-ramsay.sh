#!/usr/bin/env bash
# Download the real-Ramsay clip pool into app/public/ramsay/ (gitignored).
# Source 1: private repo w1ne/SpiceDispenser-assets (durable; needs gh auth).
# Source 2: the original public soundboard URLs (fallback).
# The clips are copyrighted TV audio — they stay out of the public repo.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=app/public/ramsay
mkdir -p "$DEST"

CLIPS=(
  wheres-the-lamb-sauce.mp3 rawwww_ramsay.mp3 gordon-you-donkey.mp3
  gordon-ramsey-what-are-you-an-idiot-sandwich.mp3 idiot-sandwich.mp3
  gordon-burnt-pan.mp3 gordon-teamwork.mp3 rubber-rubber-rubber-1.mp3
  its-black.mp3 gordon-nonstick-pan.mp3 how-much-is-in-the-bin.mp3
  rotten_ramsay.mp3 gordon-burnt-duck.mp3 youre-making-me-mad.mp3
  gordon-ramsay-you-fucing-dounut.mp3 how-much-capellini.mp3
  look-look-wtf-is-this.mp3
)

ok=0; fail=0
for f in "${CLIPS[@]}"; do
  out="$DEST/$f"
  [ -s "$out" ] && { ok=$((ok+1)); continue; }
  if gh api "repos/w1ne/SpiceDispenser-assets/contents/ramsay/$f" \
       -H "Accept: application/vnd.github.raw" > "$out" 2>/dev/null && [ -s "$out" ]; then
    ok=$((ok+1)); continue
  fi
  if curl -fsSL "https://www.myinstants.com/media/sounds/$f" -o "$out" && [ -s "$out" ]; then
    ok=$((ok+1)); continue
  fi
  rm -f "$out"; fail=$((fail+1)); echo "MISS  $f"
done
echo "ramsay clips: $ok ok, $fail missing → $DEST"
[ "$fail" -eq 0 ]
