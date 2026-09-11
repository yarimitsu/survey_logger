# Survey Logger

Offline-first field logger for marine mammal surveys: a vessel track, timestamped
event tags, and focal-follow records (surfacing/dive intervals, blow counts,
behaviour, distance and bearing). Runs entirely in the browser, stores everything
in IndexedDB on the device, and exports one cumulative CSV.

Built to work with no internet connection on either a Windows laptop with
a USB GPS or an iPad using its internal GPS.

---

## Quick start

### Laptop (the primary field setup)

From the repository directory:

    python -m http.server 8080 --bind 127.0.0.1

Open **http://localhost:8080/** in **Chrome or Edge**.

This needs no internet once the repository is cloned and map tiles are cached
(see *Offline* below). It must be served over http — opening `index.html` as a
`file://` URL will not work, because service workers refuse to register there.

### iPad

Open the GitHub Pages URL for this repository in Safari and add it to the home
screen. iPads use their internal GPS via `navigator.geolocation`; there is no USB
GPS path on iOS.

---

## USB GPS (COM3, 4800 baud)

1. Plug in the receiver. Confirm it appears in Device Manager under
   *Ports (COM & LPT)*; the app is written for **COM3 at 4800 baud**, the NMEA
   0183 default.
2. Open the app in Chrome or Edge over `http://localhost:8080`.
3. Click **Connect GPS** in the top bar and pick the COM port from the browser's
   picker.

The button turns green and reads **USB GPS** while the serial feed is live.

**What is parsed.** `RMC` and `GGA` sentences, from any talker ID (`$GP`, `$GN`,
`$GL`, `$GA`, `$BD`, `$QZ` — most modern receivers emit `$GN`, not `$GP`).
Checksums are verified. Sentences reporting no valid fix (`RMC` status `V`,
`GGA` fix quality `0`) are discarded rather than logged, so a receiver that is
still acquiring cannot write a stale or null position into the track.

**If the feed drops.** An unplugged receiver, a sleep/wake cycle, or a driver
hiccup is caught and the port is reopened automatically every 3 seconds. A feed
that goes silent without erroring — the usual way a track dies mid-survey —
triggers a warning after 15 seconds and a forced reconnect after 30. Watch the
status line.

---

## Map layers

The map has a layer control in the top right.

**Base layers**

- **Nautical chart (NOAA ENC)** - the default. NOAA's Electronic Navigational
  Chart service: soundings, depth contours, depth areas, navaids, shoreline.
  This is the authoritative chart data for US waters and is what to read depth
  from.
- **OpenStreetMap** - land detail and place names. No bathymetry.
- Any layer cached to disk appears as *(offline)* and becomes the default when
  present.

**Overlay**

- **Seamarks (OpenSeaMap)** - buoys, beacons and lights, drawn over whichever
  base layer is active.
  
---

## Offline map tiles

Tiles are downloaded to disk and served from `localhost`, rather than relying on


**Check that it covers your transects** and pass `--bbox` if not.

**Tiles are not in the repository.** They are large, binary and derived; `tiles/`
is gitignored. Run the fetcher once on each machine after cloning.

**OpenStreetMap:** bulk downloading from `tile.openstreetmap.org` is against the
[OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
`--source osm` exists for a small land-context cache and is throttled to one
request per second. NOAA's chart service is US Government work in the public
domain and carries no such restriction, which is why it is the default. Keep OSM
caching small, or skip it.

### The iPad

iPads cannot run the fetcher. There the service worker's runtime cache is still
the only mechanism: **before leaving the dock**, on wifi, open the app and pan
and zoom over the survey area at every zoom level you expect to use. A tile that
has never been displayed is not cached.

| Works offline | Needs the network |
|---|---|
| USB GPS position and track logging | Tiles outside the cached area or zoom range |
| All logging, IndexedDB storage, CSV export | First load from GitHub Pages with an empty cache |
| Cached tiles (laptop), previously-viewed tiles (iPad) | The online NOAA / OSM / OpenSeaMap layers |
| The app shell | |

`navigator.storage.persist()` is requested at startup. If the browser refuses, the
status line says so - export more often, because IndexedDB is the only copy of
the data until a CSV is saved.

---

## Data and export

**Export CSV** writes **one** long-format file,
`survey_log_<device>_<stamp>.csv`: one row per record, every record type, in
strict time order. `record_type` is one of:

| `record_type` | one row per |
|---|---|
| `TRACK` | vessel position, every 10 s and on every logged action |
| `EVENT` | a quick tag or a free note |
| `FOCAL` | a focal follow (start, end, whale ID) |
| `INTERVAL` | a surfacing or dive within a follow |
| `BEHAVIOR` | one timestamped behaviour - blow, breach, fluke up... |

The five share one column set; columns that do not apply to a row are blank. So
a track point has `lat`/`lon` and no `behavior`, and a `FOCAL` row has
`whale_id` and no position.

Everything is in time order, so a follow reads straight down the file: the focal
starts, an interval opens, blows and a breach come in with track points
interleaved between them at their own timestamps. `focal_id`, `whale_id` and
`focal_uuid` are joined onto every row belonging to a follow, including its
track points, so `filter(focal_uuid == x)` gives you the whole follow with its
track.

The browser cannot append to a file on disk, so each export re-reads the whole
database. Every file is a strict superset of the last; only the newest needs
keeping.

Two columns are specific to the position source, and are populated on `TRACK`
rows:

- `gps_source` — `serial` (USB receiver) or `device` (internal/OS location).
  A survey that starts on the laptop's location service and switches to the USB
  puck partway through has a step change in accuracy; this is the only way to see
  it afterwards. Blank on points recorded before the USB GPS existed.
- `gps_time_utc` — the receiver's own UTC, from `RMC`. The `ts` / `time_utc`
  columns stay on the device clock so all record types remain joinable, but a
  laptop off the network for a week can drift by minutes, and this column is what
  detects that.
- `trigger` - `cadence` for a point written by the 10-second timer, `event` for
  one written because something was logged. Lets a track be thinned back to pure
  cadence without losing which points coincide with an observation.

### Behaviour vs activity

Two different columns, deliberately named apart:

- **`behavior`** - one timestamped observation, on a `BEHAVIOR` row. One of
  `blow`, `breach`, `lunge`, `fluke up`, `fluke down`, `slap`, `other`. Each tap
  is its own row with its own `ts`, so a surfacing with four blows and a breach
  is five rows.
- **`activity`** - the sticky state of the follow (`unknown`, `transit`,
  `foraging`), carried on `FOCAL` and `INTERVAL` rows. It applies until you
  change it, and it was called `behavior` before 2026-09-09. Follows recorded
  under the old name are renamed on upgrade and on import, and the export falls
  back to the old field anyway, so nothing recorded earlier loses its state.

`secs_into_surfacing` gives each behaviour's offset from the start of the
interval it fell in, and `surfacing_id` (e.g. `FocalA-S3`) ties it to a
particular surfacing.

**Blow is the only behaviour that changes the interval.** Tapping it during a
dive closes the dive and opens a new surfacing, the way the old blow button did,
because the first blow is what tells you the whale is up. Every other behaviour
is filed against whatever interval is already open and changes nothing - a fluke
up marks a dive *starting*, and a breach seen mid-dive is still a real
observation rather than a reason to end the dive. The blow count in the panel
counts blows only, so a breach does not inflate it.

To change the button list, edit `BEHAVIORS` in `app.js`; the panel is built from
it, so the buttons and the exported values cannot drift apart. Add to the list
rather than renaming, once a season has data - the strings are stored verbatim.

**Track cadence.** A point every 10 seconds, plus a forced point on every logged
action: event tag, note, focal start and end, interval switch, and every
behaviour. A
forced point takes its position from the last fix - there is no way to request
one synchronously, and at 1 Hz on the USB receiver it is under a second stale -
but its timestamp from the event, so it sorts alongside the record it
accompanies.

**Merging two devices.** Use **Export JSON** on each device and **Import JSON** on
one of them, then export a combined CSV. Every record id is `device_id + uuid`, so
a merge is a plain `put()` with no collision logic. Focal labels are per-device —
two iPads will both produce `FocalA` — so use `device_label` to tell them apart.

---

## Tests

    node test_gps.js
    node test_export.js
    node test_startup.js
    python tools/check_static.py

`test_gps.js` - 44 assertions covering NMEA parsing: checksums against canonical published
sentences, `ddmm.mmmm` / `dddmm.mmmm` coordinate conversion with hemisphere signs
(round-tripped against a real Cook Inlet position, 59.62882, -151.6138883),
two-digit year handling, invalid-fix rejection, sentence reassembly across stream
chunks, and the end-to-end sentence-to-fix pipeline.

`test_export.js` - 57 assertions covering the CSV export. It evaluates `app.js`
against an in-memory database and checks that no row is lost or duplicated, that a
follow's identity reaches its track points, that the cadence floor holds between
forced points, that forced points carry the event timestamp, and that
per-file `seq`, time order, whale-ID joining and surfacing numbering are correct.

`tools/check_static.py` - there is no build step and no module system here, so
nothing otherwise catches a renamed function or a selector pointing at an id that
no longer exists. It checks that every `$('#id')` matches an element in
`index.html`, that every `UI.`/`GPS.`/`App.`/`DB.` reference is actually exported,
that scripts load in dependency order, that every local asset is in the service
worker's shell list, and that `NOAA_LAYERS` is identical in `ui.js` and
`tools/fetch_tiles.py` - a mismatch there would make the cached chart silently
differ from the online one, which you would not discover until you were offline.

`test_startup.js` - 16 assertions that startup runs to completion and every
button actually gets a handler. `main.js` does all of startup inside one async
`init()`, and a rejection anywhere in it is caught by a single handler at the
bottom - so one broken await skips `wireControls()` and leaves the entire UI
inert, with one line of status text as the only clue.

There is no automated test of the map layers or of real serial hardware; those
are exercised by hand.

---

## Files

    index.html      layout and markup
    style.css       styling
    db.js           IndexedDB wrapper
    gps.js          position sources: Web Serial NMEA and navigator.geolocation
    app.js          core logic, focal follows, CSV/JSON export
    ui.js           DOM rendering and Leaflet map drawing
    main.js         startup and event wiring
    sw.js           service worker (offline app shell + runtime tile cache)
    test_gps.js     NMEA parser test harness
    test_export.js  CSV export split test harness
    tools/          fetch_tiles.py - offline tile downloader
                    check_static.py - cross-file consistency checks
    tiles/          downloaded tiles (gitignored; run the fetcher)
    _status.md      running project status, decisions, and open issues

The service worker is deliberately disabled on `localhost` and `127.0.0.1`.
Cache-first is right in the field and wrong while editing, where it serves
two-round-old files.

---
