# Survey Logger

Offline-first browser app for marine mammal focal follows: vessel track, event tags,
surfacing/dive intervals, blow counts, and behaviour records. Stores everything in
IndexedDB; exports one cumulative CSV.

Works with no internet. Runs on a Windows laptop with a USB GPS or an iPad using its
internal GPS.

---

## Quick start

### Laptop

    python -m http.server 8080 --bind 127.0.0.1

Open **http://localhost:8080** in Chrome or Edge. Must be served — `file://` URLs
won't work (service worker restriction).

### iPad

Open **https://yarimitsu.github.io/survey_logger/** in Safari and add to the home screen.

---

## GPS

Click **Connect GPS** and pick the COM port. The button turns green while the serial
feed is live. The receiver is reconnected automatically after an unplug or sleep/wake.

If the fix feed goes silent for 15 seconds the coordinate display turns red and reads
**GPS lost**. Stale coordinates are not written to new records — lat/lon on events,
behaviours, and intervals will be blank until the signal returns.

**Wi-Fi-only iPad:** these have no GPS chip — position comes entirely from Apple's
Wi-Fi-positioning lookup, which needs an actual path to the internet, not just an
associated Wi-Fi network. A vessel's onboard Wi-Fi with no internet uplink will leave
the iPad unable to get a fix at all (`Device GPS error: ... kCLErrorDomain error 0`).
That's expected, not a bug — run the iPad as a timestamp-only logger in that case (lat/lon
blank on its records) and merge with the laptop's USB-GPS track afterward via Export
JSON / Import JSON, per **Merging two devices** below. A Cellular (LTE/5G) iPad model
has a real GPS chip and does not have this limitation.

**Reboots and long gaps:** if track points more than 2 minutes apart land next to each
other (a crash, a reboot, the toggle left off), the map draws a new line segment
instead of connecting them — a real gap is not a path you actually surveyed, so it is
never drawn as one. The two segments just aren't joined; nothing is deleted or marked,
and CSV/JSON export is unaffected.

---

## Focal follow behaviour buttons

- **Blow** — during a dive, closes the dive and opens a new surfacing before logging.
- **Fluke up / Fluke down** — if not already in a dive, closes the surfacing and opens a new dive before logging.
- All other behaviours log against whatever interval is already open.

---

## Export

**Export CSV** writes one long-format file, all record types, in time order:

| `record_type` | one row per |
|---|---|
| `TRACK` | vessel position, every 10 s and on every logged action |
| `EVENT` | quick tag or free note |
| `FOCAL` | focal follow (start, end, whale ID) |
| `INTERVAL` | surfacing or dive |
| `BEHAVIOR` | one timestamped behaviour (blow, fluke up, breach, …) |
| `TRANSECT` | on/off-effort transect (start, end) |
| `TRAWL` | trawl on/off-effort (start, end, scope, speed, RPM) |

`TRANSECT` and `TRAWL` also stamp their id (`transect_id` / `trawl_id`) onto every
other row that falls inside their time range, so a behaviour or event logged mid-trawl
carries both without having to be joined by hand.

Columns that don't apply to a row are blank. Every export is a superset of the last;
keep only the newest file.

**Merging two devices:** Export JSON on each, Import JSON on one, then export CSV.
Record IDs are `device_id + uuid` so there are no collisions.

---

## Offline map tiles

Run `tools/fetch_tiles.py` once after cloning to download NOAA chart tiles for the
survey area. Tiles are gitignored. On iPad, pan and zoom over the area on wifi before
going to sea — any tile you haven't viewed won't be cached.

---

## Files

    index.html / style.css          layout and styling
    db.js                           IndexedDB wrapper
    gps.js                          Web Serial NMEA + navigator.geolocation
    app.js                          core logic, export
    ui.js                           DOM and Leaflet map
    main.js                         startup and event wiring
    sw.js                           service worker (offline shell + tile cache)
    test_gps.js / test_export.js    test harnesses
    tools/fetch_tiles.py            offline tile downloader
    tools/check_static.py           cross-file consistency checks
