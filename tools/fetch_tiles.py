#!/usr/bin/env python3
"""Download map tiles for offline use into tiles/<layer>/{z}/{x}/{y}.png.

The service worker caches tiles it happens to have fetched, which means the
survey area has to be panned at every zoom while still on wifi and hoped over
afterwards. This writes them to disk instead, so `python -m http.server` serves
them locally and the map works with no network at all.

Default area is Prince William Sound and its Gulf of Alaska approaches. Default
source is the NOAA Electronic Navigational Chart service, which is US Government
work in the public domain and carries no bulk-download restriction.

    python tools/fetch_tiles.py                    # NOAA ENC, PWS, z8-13, ~12,400 tiles
    python tools/fetch_tiles.py --zoom 8 14        # deeper zoom, roughly 4x bigger
    python tools/fetch_tiles.py --bbox 59.3 -149.2 61.45 -145.2
    python tools/fetch_tiles.py --source osm       # see the warning below

OpenStreetMap note: the OSMF tile usage policy forbids bulk downloading from
tile.openstreetmap.org. --source osm is throttled hard and is here only for a
small land-context cache. Do not use it for a wide area or a deep zoom range.
Read https://operations.osmfoundation.org/policies/tiles/ first.

Tiles are NOT committed to the repository - they are large and they are
derived data. Run this once per machine. See the README.
"""

import argparse
import io
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request

# Prince William Sound and its Gulf of Alaska approaches. Order is
# south, west, north, east.
#
# The south edge is 59.30, not the ~59.95 that a tight box around the Sound
# suggests: Montague Island runs down to Cape Cleare at 59.77, and stopping
# above that cuts off the whole southern half of Montague Strait and the
# Hinchinbrook Entrance approaches. It also brings Middleton Island (59.43 N,
# -146.33 W) inside the cache. West to -149.20 covers Whittier, Passage Canal
# and Cape Puget; north to 61.45 covers Port Valdez, Columbia Bay and College
# Fiord; east to -145.20 covers Cordova and Orca Bay.
PWS_BBOX = (59.30, -149.20, 61.45, -145.20)

USER_AGENT = "survey_logger/1.0 (marine survey tile cache; +https://github.com/)"

# Web Mercator half-circumference in metres.
R = 20037508.342789244

NOAA_WMS = (
    "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer"
    "/exts/MaritimeChartService/WMSServer"
)
# Same caveat as ui.js: the service's GetCapabilities lists layers 0-12 with no
# titles, so the mapping to ENC usage bands is not published. 0-6 was chosen by
# rendering PWS and looking at it.
NOAA_LAYERS = "0,1,2,3,4,5,6"

SOURCES = {
    "noaa": {
        "title": "NOAA ENC chart",
        "attribution": "NOAA ENC",
        "delay": 0.15,
        "kind": "wms",
    },
    "osm": {
        "title": "OpenStreetMap",
        "attribution": "&copy; OpenStreetMap",
        "delay": 1.0,          # deliberately slow; see the policy note above
        "kind": "xyz",
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    },
}


def deg2tile(lat, lon, z):
    """Lat/lon to XYZ tile indices at zoom z (Web Mercator, Slippy Map scheme)."""
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    # asinh(tan(lat)) is the Mercator y, and is better conditioned near the
    # poles than log(tan + sec).
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_bbox_3857(z, x, y):
    """The tile's bounding box in EPSG:3857 metres, as WMS wants it."""
    n = 2 ** z
    span = 2 * R / n
    return (-R + x * span, R - (y + 1) * span, -R + (x + 1) * span, R - y * span)


def tiles_for(bbox, z):
    """Every tile index covering bbox at zoom z."""
    south, west, north, east = bbox
    x0, y0 = deg2tile(north, west, z)   # north edge is the SMALLER y
    x1, y1 = deg2tile(south, east, z)
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            yield x, y


def tile_url(source, z, x, y):
    src = SOURCES[source]
    if src["kind"] == "xyz":
        return src["url"].format(z=z, x=x, y=y)
    bb = tile_bbox_3857(z, x, y)
    return (
        f"{NOAA_WMS}?service=WMS&version=1.3.0&request=GetMap"
        f"&layers={NOAA_LAYERS}&styles=&crs=EPSG:3857"
        f"&bbox={bb[0]},{bb[1]},{bb[2]},{bb[3]}"
        f"&width=256&height=256&format=image/png&transparent=true"
    )


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}"
        n /= 1024.0


def sample_mean_bytes(source, plan, k=8):
    """Download a few scattered tiles to estimate the total, rather than guessing.

    Returns (mean_bytes, samples) - samples are kept and written out with the
    rest, so this costs nothing beyond the requests themselves.
    """
    rng = random.Random(0)          # deterministic pick, so a rerun samples the same tiles
    picks = rng.sample(plan, min(k, len(plan)))
    got, total = [], 0
    for z, x, y in picks:
        try:
            data = fetch(tile_url(source, z, x, y))
        except Exception as e:                       # noqa: BLE001 - report and carry on
            print(f"  sample z{z}/{x}/{y} failed: {e}")
            continue
        got.append(((z, x, y), data))
        total += len(data)
        time.sleep(SOURCES[source]["delay"])
    if not got:
        return None, []
    return total / len(got), got


def write_manifest(out_dir, source, bbox, zmin, zmax):
    """Rewrite manifest.json from what is actually on disk.

    Called at the start of a run, periodically during it, and at the end. The
    app reads this at startup, so a manifest that is only written on completion
    leaves the map describing the PREVIOUS run for as long as this one takes -
    which, for a 12,000 tile fetch, is hours of the app showing a stale and much
    smaller cached area.
    """
    os.makedirs(out_dir, exist_ok=True)
    mpath = os.path.join(out_dir, "manifest.json")
    manifest = {"layers": {}}
    if os.path.exists(mpath):
        try:
            with io.open(mpath, encoding="utf-8") as f:
                manifest = json.load(f)
        except (ValueError, OSError):
            pass                          # a corrupt manifest is replaced, not patched
    manifest.setdefault("layers", {})

    on_disk, zooms = 0, []
    for z in range(zmin, zmax + 1):
        zdir = os.path.join(out_dir, source, str(z))
        c = sum(len(files) for _, _, files in os.walk(zdir)) if os.path.isdir(zdir) else 0
        if c:
            zooms.append(z)
            on_disk += c
    if not zooms:
        return 0, None

    manifest["layers"][source] = {
        "title": SOURCES[source]["title"],
        "attribution": SOURCES[source]["attribution"],
        "minzoom": min(zooms),
        "maxzoom": max(zooms),
        "tiles": on_disk,
        "bbox": list(bbox),
        "complete": on_disk >= expected_tiles(bbox, zmin, zmax),
        "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with io.open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return on_disk, (min(zooms), max(zooms))


def expected_tiles(bbox, zmin, zmax):
    return sum(len(list(tiles_for(bbox, z))) for z in range(zmin, zmax + 1))


def write_tile(out_dir, source, z, x, y, data):
    d = os.path.join(out_dir, source, str(z), str(x))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"{y}.png"), "wb") as f:
        f.write(data)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--source", choices=sorted(SOURCES), default="noaa")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"),
                    default=list(PWS_BBOX), help="south west north east (default: Prince William Sound)")
    ap.add_argument("--zoom", nargs=2, type=int, metavar=("MIN", "MAX"), default=[8, 13])
    ap.add_argument("--out", default="tiles")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    ap.add_argument("--max-tiles", type=int, default=20000,
                    help="refuse to start above this many tiles (default 20000)")
    args = ap.parse_args()

    bbox = tuple(args.bbox)
    zmin, zmax = args.zoom
    if zmin > zmax:
        ap.error("--zoom MIN must not exceed MAX")
    source = args.source

    plan = [(z, x, y) for z in range(zmin, zmax + 1) for x, y in tiles_for(bbox, z)]
    if not plan:
        print("Nothing to do: the bbox covers no tiles.")
        return 0

    existing = sum(
        1 for z, x, y in plan
        if os.path.exists(os.path.join(args.out, source, str(z), str(x), f"{y}.png"))
    )
    todo = len(plan) - existing

    print(f"Source : {source} ({SOURCES[source]['title']})")
    print(f"Area   : S {bbox[0]} W {bbox[1]} N {bbox[2]} E {bbox[3]}")
    print(f"Zooms  : {zmin}-{zmax}")
    for z in range(zmin, zmax + 1):
        print(f"           z{z:>2}: {sum(1 for t in plan if t[0] == z):>7,} tiles")
    print(f"Total  : {len(plan):,} tiles ({existing:,} already on disk, {todo:,} to fetch)")

    if len(plan) > args.max_tiles:
        print(f"\nREFUSING: {len(plan):,} tiles exceeds --max-tiles {args.max_tiles:,}.")
        print("Narrow --bbox or lower the --zoom maximum.")
        return 1

    if todo == 0:
        print("\nAll tiles already present.")
    else:
        print("\nSampling to estimate size...")
        mean, samples = sample_mean_bytes(source, plan)
        if mean is None:
            print("Every sample request failed. Check the network and the source URL.")
            return 1
        print(f"  mean tile {human(mean)} -> estimated total {human(mean * len(plan))}"
              f" ({human(mean * todo)} still to fetch)")

        if source == "osm":
            print("\nWARNING: bulk downloading from tile.openstreetmap.org is against the")
            print("OSMF tile usage policy. Keep this small, or use --source noaa.")

        if not args.yes:
            try:
                if input("\nProceed? [y/N] ").strip().lower() not in ("y", "yes"):
                    print("Aborted.")
                    return 1
            except EOFError:
                print("\nNo tty for the prompt; rerun with --yes.")
                return 1

        for (z, x, y), data in samples:
            write_tile(args.out, source, z, x, y, data)

        # Publish the target area immediately. Until this run finishes the
        # manifest would otherwise still describe whatever the last run cached,
        # and the app would quietly show that smaller area instead.
        write_manifest(args.out, source, bbox, zmin, zmax)

        delay = SOURCES[source]["delay"]
        done = failed = 0
        t0 = time.time()
        for i, (z, x, y) in enumerate(plan, 1):
            path = os.path.join(args.out, source, str(z), str(x), f"{y}.png")
            if os.path.exists(path):
                continue                     # resume an interrupted run
            try:
                write_tile(args.out, source, z, x, y, fetch(tile_url(source, z, x, y)))
                done += 1
            except urllib.error.HTTPError as e:
                # A 404 over open water is normal for some services; a 403 is not.
                if e.code not in (404, 204):
                    failed += 1
                    print(f"  z{z}/{x}/{y}: HTTP {e.code}")
            except Exception as e:           # noqa: BLE001
                failed += 1
                print(f"  z{z}/{x}/{y}: {e}")
            if done and done % 100 == 0:
                rate = done / max(1e-6, time.time() - t0)
                print(f"  {i:,}/{len(plan):,}  fetched {done:,}  failed {failed:,}"
                      f"  {rate:.1f}/s")
            if done and done % 500 == 0:
                write_manifest(args.out, source, bbox, zmin, zmax)
            time.sleep(delay)
        print(f"\nFetched {done:,} tiles, {failed:,} failed.")

    on_disk, zr = write_manifest(args.out, source, bbox, zmin, zmax)
    if not zr:
        print("No tiles on disk for this source; manifest not updated.")
        return 1
    total = expected_tiles(bbox, zmin, zmax)
    print(f"Wrote {os.path.join(args.out, 'manifest.json')}: {on_disk:,} tiles for "
          f"'{source}', z{zr[0]}-{zr[1]}"
          f"{'' if on_disk >= total else f' (INCOMPLETE: {total - on_disk:,} missing - rerun to resume)'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
