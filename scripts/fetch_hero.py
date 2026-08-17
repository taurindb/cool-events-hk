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
MAX_CANDIDATES = 6   # images to try per page before giving up
MIN_BYTES_PER_PIXEL = 0.03  # below this it is flat UI chrome, not artwork


EVENT_TYPES = {
    "event", "musicevent", "theaterevent", "danceevent", "comedyevent",
    "exhibitionevent", "screeningevent", "festival", "socialevent",
    "educationevent", "businessevent", "sportsevent", "visualartsevent",
    "literaryevent", "foodevent", "childrensevent",
}


class MetaParser(HTMLParser):
    """Collects <meta> pairs and any ld+json blocks."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.ld_blocks = []
        self._in_ld = False
        self._buf = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script":
            if (a.get("type") or "").lower().strip() == "application/ld+json":
                self._in_ld = True
                self._buf = []
            return
        if tag != "meta":
            return
        key = (a.get("property") or a.get("name") or "").lower()
        content = a.get("content")
        if key and content and key not in self.meta:
            self.meta[key] = content

    def handle_data(self, data):
        if self._in_ld:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._in_ld:
            self._in_ld = False
            self.ld_blocks.append("".join(self._buf))


def walk_json(node):
    """Yield every dict in a JSON-LD document, however it is nested."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk_json(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk_json(item)


def as_image_url(value):
    """schema.org `image` may be a string, an ImageObject, or a list of either."""
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        for key in ("url", "contentUrl", "@id"):
            if isinstance(value.get(key), str) and value[key].strip():
                return value[key].strip()
        return None
    if isinstance(value, list):
        for item in value:
            found = as_image_url(item)
            if found:
                return found
    return None


def summarise_event(node):
    """The few schema.org Event fields worth cross-checking research against.

    Emitted for information only — the caller still decides what to publish.
    A venue's own structured data is a stronger source than a search result.
    """
    if not isinstance(node, dict):
        return None

    def text(value):
        if isinstance(value, str):
            return value.strip() or None
        if isinstance(value, dict):
            for key in ("name", "@id", "url"):
                if isinstance(value.get(key), str):
                    return value[key].strip() or None
        if isinstance(value, list) and value:
            return text(value[0])
        return None

    out = {}
    for key in ("name", "startDate", "endDate", "eventStatus", "url"):
        value = text(node.get(key))
        if value:
            out[key] = value

    location = node.get("location")
    if isinstance(location, list) and location:
        location = location[0]
    if isinstance(location, dict):
        venue = text(location.get("name"))
        if venue:
            out["locationName"] = venue
        address = location.get("address")
        if isinstance(address, dict):
            parts = [address.get(k) for k in
                     ("streetAddress", "addressLocality", "addressRegion")]
            joined = ", ".join(p.strip() for p in parts if isinstance(p, str) and p.strip())
            if joined:
                out["locationAddress"] = joined
        elif isinstance(address, str) and address.strip():
            out["locationAddress"] = address.strip()

    offers = node.get("offers")
    if isinstance(offers, list) and offers:
        offers = offers[0]
    if isinstance(offers, dict):
        price = offers.get("price")
        if price not in (None, ""):
            out["price"] = str(price)
        for key in ("priceCurrency", "availability"):
            value = text(offers.get(key))
            if value:
                out[key] = value
        url = text(offers.get("url"))
        if url:
            out["ticketUrl"] = url

    return out or None


def event_from_ld(parser):
    """The first schema.org Event in the page, if there is one.

    Preferred over og:image because an Event's `image` is by definition about
    that event, where og:image is whatever the site wants in link previews —
    frequently one banner for the whole domain.
    """
    for block in parser.ld_blocks:
        try:
            data = json.loads(block)
        except (json.JSONDecodeError, ValueError):
            continue
        for node in walk_json(data):
            types = node.get("@type")
            types = [types] if isinstance(types, str) else (types or [])
            if not any(isinstance(t, str) and t.lower() in EVENT_TYPES for t in types):
                continue
            image = as_image_url(node.get("image"))
            if image:
                return node, image
    return None, None


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
    """Best available header image, plus how it was found.

    Returns (url, meta, source_kind, event_node).
    """
    parser = MetaParser()
    try:
        parser.feed(html)
    except Exception:
        pass

    event, ld_image = event_from_ld(parser)
    if ld_image:
        return urllib.parse.urljoin(page_url, ld_image), parser.meta, "json-ld", event

    for key in ("og:image:secure_url", "og:image:url", "og:image", "twitter:image",
                "twitter:image:src"):
        candidate = parser.meta.get(key)
        if candidate:
            return urllib.parse.urljoin(page_url, candidate.strip()), parser.meta, key, None

    # Some pages only set it on a <link rel="image_src">.
    match = re.search(r'<link[^>]+rel=["\']image_src["\'][^>]+href=["\']([^"\']+)',
                      html, re.I)
    if match:
        return urllib.parse.urljoin(page_url, match.group(1)), parser.meta, "image_src", None
    return None, parser.meta, None, None


CHROME_WORDS = re.compile(
    r"(icon|logo|sprite|spacer|placeholder|avatar|favicon|arrow|button|btn|share"
    r"|social|flag|badge|watermark|loader|loading|blank|pixel)", re.I)

HERO_WORDS = re.compile(r"(banner|poster|hero|cover|main|header|keyvisual|kv)", re.I)


def normalise(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def content_images(html, page_url, title):
    """In-page images, best candidates first.

    Plenty of venues never declare a hero in their metadata but do put the real
    poster in the body — East Kowloon Cultural Centre ships
    R_Live_Lines-banner_event-banner.jpg on a page whose og:image is a photo of
    the building. Ranking by how much the filename looks like the page it is on
    finds that reliably without downloading thirty icons to measure them.
    """
    refs = re.findall(r"<img[^>]+?(?:data-src|data-original|src)=[\"']([^\"']+)[\"']",
                      html, re.I)

    slug_raw = (urllib.parse.urlsplit(page_url).path.rsplit("/", 1)[-1]
                .rsplit(".", 1)[0])
    slug = normalise(slug_raw)
    # Whole-slug matching alone is too strict: the page r_livelines-workshops
    # carries R_Live_Lines-banner.jpg, which shares "livelines" but not the
    # whole slug. Without the token pass a generic event-workshop.png outranked
    # the real key art purely because the title contained the word "workshop".
    slug_tokens = [normalise(t) for t in re.split(r"[^A-Za-z0-9]+", slug_raw)]
    slug_tokens = [t for t in slug_tokens if len(t) >= 5]

    title_tokens = [normalise(t) for t in re.split(r"\W+", title or "") if len(t) >= 4]

    scored, seen = [], set()
    for ref in refs:
        url = urllib.parse.urljoin(page_url, ref.strip())
        if url in seen:
            continue
        seen.add(url)

        name = url.rsplit("/", 1)[-1]
        if name.lower().endswith(".svg"):
            continue

        flat = normalise(name.rsplit(".", 1)[0])
        score = 0
        if slug and len(slug) >= 5 and slug in flat:
            score += 100
        # The page's own slug is a far stronger signal than the event title,
        # which shares common words like "workshop" with the site's furniture.
        score += min(120, sum(60 for t in slug_tokens if t in flat))
        score += min(60, sum(20 for t in title_tokens if t and t in flat))
        if HERO_WORDS.search(name):
            score += 10
        if CHROME_WORDS.search(name):
            score -= 100

        if score > 0:
            scored.append((score, url))

    scored.sort(key=lambda pair: -pair[0])
    return [url for _score, url in scored]


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
    url, _meta, _kind, _event = find_image_url(raw.decode("utf-8", "replace"), final)
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
    meta_url, meta, kind, event = find_image_url(html, final_url)

    # Candidates in order of trustworthiness. Metadata first, then the page's
    # own images ranked by how much they look like they belong to this event.
    candidates = []
    if meta_url:
        # A JSON-LD Event image is about that event by construction; the
        # site-default check only needs to guard the page-level fallbacks.
        if kind == "json-ld" or args.allow_site_default:
            candidates.append((meta_url, kind))
        else:
            default = site_default_image(final_url)
            if default and default == meta_url:
                log(f"{kind} is the site-wide default ({meta_url}); "
                    "looking for a better image in the page")
            else:
                candidates.append((meta_url, kind))

    for url in content_images(html, final_url, args.title):
        if all(url != existing for existing, _ in candidates):
            candidates.append((url, "content"))

    if not candidates:
        log("no event image, og:image or usable in-page image found")
        return 1

    IMAGES.mkdir(parents=True, exist_ok=True)

    # Validation happens inside the loop: a candidate that turns out to be a
    # 60px logo should hand over to the next one, not abandon the event.
    chosen = None
    for url, source_kind in candidates[:MAX_CANDIDATES]:
        try:
            body, headers, _ = get(url, IMAGE_CAP)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            log(f"skipping {url}: {e}")
            continue

        content_type = (headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if not content_type.startswith("image/"):
            log(f"skipping {url}: not an image ({content_type or 'no content-type'})")
            continue
        if len(body) >= IMAGE_CAP:
            log(f"skipping {url}: exceeds the size cap")
            continue

        with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as tmp:
            tmp.write(body)
            tmp_path = Path(tmp.name)

        w, h = dimensions(tmp_path)
        if w == 0 or h == 0:
            log(f"skipping {url}: could not read dimensions")
            tmp_path.unlink(missing_ok=True)
            continue
        if w < MIN_WIDTH or h < MIN_HEIGHT:
            log(f"skipping {url}: too small ({w}x{h}), likely a logo")
            tmp_path.unlink(missing_ok=True)
            continue

        # Flat interface graphics compress far harder than photographs or
        # printed artwork. A speech-bubble label was passing every other check
        # here at 0.03 bytes per pixel where the real poster sits near 0.14.
        density = len(body) / float(w * h)
        if density < MIN_BYTES_PER_PIXEL:
            log(f"skipping {url}: {density:.3f} bytes/pixel, "
                "flat graphic rather than artwork")
            tmp_path.unlink(missing_ok=True)
            continue

        chosen = (url, source_kind, tmp_path, w, h,
                  hashlib.sha256(body).hexdigest()[:12])
        break

    if not chosen:
        log("no candidate passed validation; keeping generated artwork")
        return 1

    image_url, kind, tmp_path, w, h, digest = chosen
    out = IMAGES / f"hero-{digest}.jpg"

    try:
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

    result = {
        "image": f"images/{out.name}",
        "imageAlt": f"Promotional image for {args.title}" if args.title else "",
        "imageCredit": credit,
        "imageCreditUrl": final_url,
        "source": image_url,
        "via": kind,
        "width": final_w,
        "height": final_h,
    }
    structured = summarise_event(event)
    if structured:
        result["structured"] = structured

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
