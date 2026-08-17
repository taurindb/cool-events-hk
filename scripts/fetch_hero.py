#!/usr/bin/env python3
"""Pull an event page's Open Graph image and prepare it for the site.

An og:image is the picture a venue publishes so link previews look right, which
makes it the one image on their page that is meant to be shown elsewhere. We
still credit it and link back, and honour robots.txt before fetching.

Usage:
    python3 scripts/fetch_hero.py <page-url> [--title "Event name"]

Prints a JSON object on success:
    {"image": "images/hero-<hash>.jpg", "imageCredit": "...",
     "imageCreditUrl": "...", "source": "...", "width": 1200, "height": 630}

Prints nothing and exits 1 when there is no usable image — the caller should
leave the event without an `image` field and let the generated artwork stand in.
Reasons are written to stderr so a failure is never silent.

Stdlib only, so the daily run has no install step.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IMAGES = REPO / "docs" / "images"

UA = "WhatsOnHK/1.0 (student events listing; +https://taurindb.github.io/cool-events-hk/)"
HTML_CAP = 2_000_000      # bytes of markup to read
IMAGE_CAP = 12_000_000    # bytes of image to accept
TIMEOUT = 15

# An og:image below this is almost always a logo or a share icon, and looks
# worse on a card than the generated artwork it would replace.
MIN_WIDTH = 600
MIN_HEIGHT = 315
MAX_EDGE = 1600


class MetaParser(HTMLParser):
    """Collects <meta> property/content pairs and stops at </head>."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.done = False

    def handle_starttag(self, tag, attrs):
        if tag != "meta":
            return
        a = dict(attrs)
        key = (a.get("property") or a.get("name") or "").lower()
        content = a.get("content")
        if key and content and key not in self.meta:
            self.meta[key] = content

    def handle_endtag(self, tag):
        if tag == "head":
            self.done = True


def log(msg):
    print(f"fetch_hero: {msg}", file=sys.stderr)


def allowed_by_robots(url):
    parts = urllib.parse.urlsplit(url)
    robots = urllib.parse.urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", ""))
    parser = urllib.robotparser.RobotFileParser()
    try:
        req = urllib.request.Request(robots, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            parser.parse(resp.read(HTML_CAP).decode("utf-8", "replace").splitlines())
    except Exception:
        # No robots.txt, or unreachable: the permissive default.
        return True
    return parser.can_fetch(UA, url)


def get(url, cap):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read(cap), resp.headers, resp.url


def find_image_url(html, page_url):
    parser = MetaParser()
    try:
        parser.feed(html)
    except Exception:
        pass

    for key in ("og:image:secure_url", "og:image:url", "og:image", "twitter:image",
                "twitter:image:src"):
        candidate = parser.meta.get(key)
        if candidate:
            return urllib.parse.urljoin(page_url, candidate.strip()), parser.meta

    # Some pages only set it on a <link rel="image_src">.
    match = re.search(r'<link[^>]+rel=["\']image_src["\'][^>]+href=["\']([^"\']+)',
                      html, re.I)
    if match:
        return urllib.parse.urljoin(page_url, match.group(1)), parser.meta
    return None, parser.meta


def site_default_image(page_url):
    """The og:image on the site's own front page.

    Plenty of venues set one banner site-wide instead of per event — EKCC serves
    the same photo of its building for every listing. That passes every other
    check here, so without this the whole site would end up wearing one stock
    photo. One extra request settles it, and it needs no memory of past runs.
    """
    parts = urllib.parse.urlsplit(page_url)
    root = urllib.parse.urlunsplit((parts.scheme, parts.netloc, "/", "", ""))
    if root.rstrip("/") == page_url.rstrip("/"):
        return None
    try:
        raw, _headers, final = get(root, HTML_CAP)
    except Exception:
        return None
    url, _meta = find_image_url(raw.decode("utf-8", "replace"), final)
    return url


def dimensions(path):
    out = subprocess.run(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
        capture_output=True, text=True)
    w = h = 0
    for line in out.stdout.splitlines():
        line = line.strip()
        if line.startswith("pixelWidth:"):
            w = int(line.split(":")[1])
        elif line.startswith("pixelHeight:"):
            h = int(line.split(":")[1])
    return w, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--title", default="")
    ap.add_argument("--allow-site-default", action="store_true",
                    help="accept an image even if it matches the site's front-page banner")
    args = ap.parse_args()

    if not args.url.lower().startswith(("http://", "https://")):
        log("url must be http(s)")
        return 1

    if not allowed_by_robots(args.url):
        log(f"robots.txt disallows fetching {args.url}")
        return 1

    try:
        raw, _headers, final_url = get(args.url, HTML_CAP)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        log(f"could not fetch page: {e}")
        return 1

    html = raw.decode("utf-8", "replace")
    image_url, meta = find_image_url(html, final_url)
    if not image_url:
        log("no og:image on the page")
        return 1

    if not args.allow_site_default:
        default = site_default_image(final_url)
        if default and default == image_url:
            log(f"og:image is the site-wide default ({image_url}); "
                "not specific to this event, keeping generated artwork")
            return 1

    try:
        blob, headers, _ = get(image_url, IMAGE_CAP)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        log(f"could not fetch image: {e}")
        return 1

    ctype = (headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if not ctype.startswith("image/"):
        log(f"og:image is not an image ({ctype or 'no content-type'})")
        return 1
    if len(blob) >= IMAGE_CAP:
        log("image exceeds the size cap")
        return 1

    IMAGES.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(blob).hexdigest()[:12]
    out = IMAGES / f"hero-{digest}.jpg"

    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as tmp:
        tmp.write(blob)
        tmp_path = Path(tmp.name)

    try:
        w, h = dimensions(tmp_path)
        if w == 0 or h == 0:
            log("could not read image dimensions; not a usable image")
            return 1
        if w < MIN_WIDTH or h < MIN_HEIGHT:
            log(f"image too small ({w}x{h}); likely a logo, keeping generated artwork")
            return 1

        target = min(max(w, h), MAX_EDGE)
        conv = subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "72",
             "-Z", str(target), str(tmp_path), "--out", str(out)],
            capture_output=True)
        if conv.returncode != 0 or not out.exists():
            log("could not convert image")
            return 1

        subprocess.run(["python3", str(REPO / "scripts" / "strip_exif.py"), str(out)],
                       capture_output=True)
    finally:
        tmp_path.unlink(missing_ok=True)

    final_w, final_h = dimensions(out)
    credit = (meta.get("og:site_name")
              or urllib.parse.urlsplit(final_url).netloc.removeprefix("www."))

    print(json.dumps({
        "image": f"images/{out.name}",
        "imageAlt": f"Promotional image for {args.title}" if args.title else "",
        "imageCredit": credit,
        "imageCreditUrl": final_url,
        "source": image_url,
        "width": final_w,
        "height": final_h,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
