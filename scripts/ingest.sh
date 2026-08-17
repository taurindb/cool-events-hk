#!/bin/bash
# Pull new event photos out of the iCloud drop folder into the repo.
#
# Scope is deliberately narrow: one hard-coded folder, top level only, image
# files only. Nothing else in iCloud Drive is ever read. Originals are left in
# place — the daily agent moves them to _processed/ only after it has
# successfully written an event, so a failed run never loses a photo.

set -euo pipefail

INBOX="$HOME/Library/Mobile Documents/com~apple~CloudDocs/HK Events Inbox"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGES="$REPO/docs/images"
STAGING="$REPO/.staging"
MANIFEST="$REPO/ingest-manifest.txt"
MAX_WIDTH=1600

if [[ ! -d "$INBOX" ]]; then
  echo "ingest: drop folder not found at: $INBOX" >&2
  exit 1
fi

mkdir -p "$IMAGES" "$STAGING"
touch "$MANIFEST"

QUEUE="$STAGING/new-photos.tsv"
: > "$QUEUE"

new_count=0
skipped=0

while IFS= read -r -d '' src; do
  hash="$(shasum -a 256 "$src" | cut -c1-12)"

  if grep -q "^${hash}	" "$MANIFEST" 2>/dev/null; then
    skipped=$((skipped + 1))
    continue
  fi

  out="$IMAGES/flyer-${hash}.jpg"

  # -Z upscales anything smaller than its target, so clamp it to the photo's
  # own longest edge and never enlarge a flyer past what was shot.
  longest="$(sips -g pixelWidth -g pixelHeight "$src" 2>/dev/null \
    | awk '/pixel(Width|Height)/ {if ($2+0 > m) m = $2+0} END {print m+0}')"
  target="$MAX_WIDTH"
  if (( longest > 0 && longest < MAX_WIDTH )); then
    target="$longest"
  fi

  if ! sips -s format jpeg -s formatOptions 72 -Z "$target" "$src" --out "$out" >/dev/null 2>&1; then
    echo "ingest: could not convert, skipping: $(basename "$src")" >&2
    continue
  fi

  python3 "$REPO/scripts/strip_exif.py" "$out" || true

  printf '%s\t%s\t%s\n' "$hash" "$(basename "$src")" "$(date +%F)" >> "$MANIFEST"
  printf '%s\t%s\t%s\n' "docs/images/flyer-${hash}.jpg" "$src" "$hash" >> "$QUEUE"
  new_count=$((new_count + 1))
done < <(find "$INBOX" -maxdepth 1 -type f \
  \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \
     -o -iname '*.heic' -o -iname '*.heif' -o -iname '*.webp' \) -print0)

echo "ingest: ${new_count} new photo(s), ${skipped} already seen"
if (( new_count > 0 )); then
  echo "ingest: queue written to .staging/new-photos.tsv"
fi
