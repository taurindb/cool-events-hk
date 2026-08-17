# What's On HK

A student guide to events around Hong Kong — gigs, exhibitions, markets, film
nights and free things to do. Published as a static site on GitHub Pages.

Listings start life as photos of flyers spotted around town. A daily job reads
each new photo, researches the venue, price and ticket link, and updates the
site.

## How it runs

```bash
./scripts/ingest.sh    # pull new photos from the iCloud drop folder
                       # (the daily agent reads them and writes events.json)
./scripts/publish.sh   # commit and push the site
```

Preview locally at <http://localhost:4173>:

```bash
python3 -m http.server 4173 --directory docs
```

## Security notes

- Nothing in this pipeline logs in to iCloud. The drop folder is a normal synced
  directory on disk, so there are no Apple credentials to leak.
- The automation is scoped to that single folder and never reads elsewhere in
  iCloud Drive.
- Photos are resized and stripped of all EXIF metadata — including GPS — before
  they are committed.
- The site is fully static: no server, no database, no accounts, no user input.
- `publish.sh` only ever stages an explicit allowlist of paths.

Full operating rules are in [CLAUDE.md](CLAUDE.md).

## Corrections

Details are gathered automatically and can be wrong. Open an issue if you spot a
mistake or want an event listed.
