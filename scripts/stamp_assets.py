#!/usr/bin/env python3
"""Stamp each asset link in index.html with a hash of that file's contents.

GitHub Pages serves assets with a ten-minute cache. Without this, someone who
visited before a deploy can come back to fresh HTML still wired to a stale
cached script — which renders as a half-broken page rather than an obvious
error. Hashing the URL means new HTML can only ever load its own assets.

Run from anywhere; paths resolve relative to the repo.
"""
import hashlib
import re
import sys
from pathlib import Path

ASSETS = ["style.css", "app.js", "backdrop.js", "artwork.js"]

repo = Path(__file__).resolve().parent.parent
index = repo / "docs" / "index.html"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def main():
    if not index.exists():
        print(f"stamp: no index.html at {index}", file=sys.stderr)
        return 1

    html = original = index.read_text()

    for asset in ASSETS:
        target = repo / "docs" / asset
        if not target.exists():
            print(f"stamp: skipping missing {asset}", file=sys.stderr)
            continue
        stamp = digest(target)
        # Matches the bare filename or one already carrying a ?v= stamp.
        pattern = re.compile(r'(["\'])' + re.escape(asset) + r'(?:\?v=[0-9a-f]+)?\1')
        html, count = pattern.subn(rf'\g<1>{asset}?v={stamp}\g<1>', html)
        if count == 0:
            print(f"stamp: {asset} not referenced in index.html", file=sys.stderr)

    if html != original:
        index.write_text(html)
        print("stamp: index.html updated")
    else:
        print("stamp: already current")
    return 0


if __name__ == "__main__":
    sys.exit(main())
