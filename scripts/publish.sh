#!/bin/bash
# Commit and push the generated site.
#
# Only ever stages the three paths that make up the published site. A blanket
# `git add -A` could sweep in a stray file dropped into the repo folder, so the
# allowlist is explicit and anything outside it is reported and left alone.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ALLOWED=(docs/data/events.json docs/images ingest-manifest.txt)

git add -- "${ALLOWED[@]}" 2>/dev/null || true

if git diff --cached --quiet; then
  echo "publish: nothing new to publish"
  exit 0
fi

echo "publish: staged changes"
git diff --cached --name-status

count="$(python3 -c "import json;print(len(json.load(open('docs/data/events.json'))['events']))")"
git commit -q -m "Update events ($(date +%F)) — ${count} listed"

if git remote get-url origin >/dev/null 2>&1; then
  git push -q origin HEAD
  echo "publish: pushed to origin"
else
  echo "publish: committed locally (no 'origin' remote configured yet)"
fi
