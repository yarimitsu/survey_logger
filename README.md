# Survey Logger

Offline-first field logger for marine mammal surveys: a vessel track, timestamped
event tags, and focal-follow records (surfacing/dive intervals, blow counts,
behaviour, distance and bearing). Runs entirely in the browser, stores everything
in IndexedDB on the device, and exports one cumulative CSV.

Built to work with no internet connection at all, on either a Windows laptop with
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

`http://<LAN-IP>:8080` will **not** work on an iPad. It is not a secure context,
so iOS Safari gives neither geolocation nor a service worker. Use https (GitHub
Pages) or the laptop.

---

## USB GPS (COM3, 4800 baud)

The laptop's own location service is useless in the field: Windows positions from
wifi and cell towers, not satellites, so with no internet it returns nothing or a
fix tens of kilometres out. The USB receiver is what makes the laptop viable.

The page reads the COM port directly using the **Web Serial API** — no bridge
process, no background service, no additional install beyond whatever driver the
USB receiver already needs.

1. Plug in the receiver. Confirm it appears in Device Manager under
   *Ports (COM & LPT)*; the app is written for **COM3 at 4800 baud**, the NMEA
   0183 default.
2. Open the app in Chrome or Edge over `http://localhost:8080`.
3. Click **Connect GPS** in the top bar and pick the COM port from the browser's
   picker.

The click is required by the Web Serial specification — a page cannot open a port
without a user gesture — so the app cannot connect automatically at startup.
After the first time, permission persists for that browser profile. If the GPS
is the only serial device this browser has been given access to, the app reuses
it silently; if you have also authorised something else (a CTD, a radio), the
picker appears each time, because the browser gives no reliable way to tell which
of several granted ports is the right one without asking.

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

**This reconnect path has not yet been tested against the actual receiver.**
At the dock, with the app running and the track on, unplug the puck and watch
the status line, then plug it back in and confirm the track resumes. Five
minutes, and it is the difference between a claim and a verified behaviour.

### Sharing the GPS with another program

**You cannot.** A Windows COM port is exclusive: exactly one process may have it
open at a time. If SeaLog, OpenCPN, a chart plotter, or even another browser tab
running this app already holds COM3, Connect GPS will fail, and the status line
will say so and name this as the reason.

If the port is busy, the fixes are, in order of preference:

1. **Close the other program.** Simplest, and right if you do not actually need
   both at once.
2. **Use a virtual COM port splitter.** A driver reads the real port once and
   presents the same NMEA stream on two or more virtual ports, one per program.
   `com0com` with `hub4com` is the free, open-source option on Windows; VSPE is
   the common commercial one. Point this app at one virtual port and the other
   program at the other. Untested here - if you go this way, confirm at the dock
   that both programs show a moving position before relying on it.
3. **A second receiver.** USB GPS pucks are cheap, and two receivers avoid the
   whole problem plus give you a spare when one fails at sea.

Clicking **USB GPS** while connected disconnects and releases the port, so you
can hand it to another program without closing the app.

**Browser support.** Web Serial is Chrome and Edge on desktop only. On Safari,
Firefox, or any iPad, the button reads **Device GPS** and the app falls back to
`navigator.geolocation`. Only one source is ever live at a time; connecting the
USB receiver stops the device watch, because interleaving two position streams
into one track produces a line that zigzags between them.

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

NOAA replaced its raster chart (RNC) tile services in 2025; `tileservice.charts.noaa.gov`
and `seamlessrnc.nauticalcharts.noaa.gov` both time out and are not used here.
The ENC service at `gis.charttools.noaa.gov` is the current one.

One known gap: the ENC service is requested with `layers=0,1,2,3,4,5,6`, but its
GetCapabilities document lists layers 0-12 **with no titles**, so there is no
published mapping from those numbers to ENC usage bands (Overview, General,
Coastal, Approach, Harbour). That subset was chosen by rendering Prince William
Sound and looking at the result. Which band appears at which zoom is untested.
If the chart is too cluttered or too sparse at working zoom, change
`NOAA_LAYERS` in `ui.js` and `tools/fetch_tiles.py`.

---

## Offline map tiles

Tiles are downloaded to disk and served from `localhost`, rather than relying on
the service worker to have happened to cache them. No eviction risk, no "did I
pan far enough", no first-load problem.

    python tools/fetch_tiles.py

That fetches NOAA ENC tiles for Prince William Sound and its Gulf approaches,
zoom 8-13, into
`tiles/noaa/{z}/{x}/{y}.png` and writes `tiles/manifest.json`. The app reads that
manifest at startup: if it is there the cached layers are used and made the
default; if not, the app is online-only and the status line says so.

The script prints the tile count per zoom and samples a few tiles to estimate the
download before asking to proceed. For the default area and zoom range that is
**12,377 tiles, about 110 MB** on disk. Measured rate is roughly 90 tiles a
minute, so budget **two to two and a half hours** and start it the night before.

The size the script predicts up front is an extrapolation from an 8-tile sample
and runs high - it sampled 20.7 KB a tile against a true mean nearer 9 KB, so it
guessed 250 MB for a 110 MB download. Treat its estimate as an upper bound.

It skips tiles already on disk, so an interrupted run resumes where it stopped,
and a rerun after widening the box only fetches the new edges. If a tile times
out the run carries on and reports the count; the manifest records
`"complete": false` and the status line says INCOMPLETE, so just rerun to fill
the gaps.

    python tools/fetch_tiles.py --zoom 8 14                # ~48,000 tiles; not casually
    python tools/fetch_tiles.py --bbox 59.0 -149.5 61.5 -144.8
    python tools/fetch_tiles.py --source osm               # see the policy note below

Default bounding box is **S 59.30, W -149.20, N 61.45, E -145.20**:

- south to 59.30, which is below Cape Cleare (59.77) at the foot of Montague
  Island. A tight box around the Sound stops near 59.95 and cuts off the whole
  southern half of Montague Strait and the Hinchinbrook Entrance approaches.
  It also brings Middleton Island (59.43 N, -146.33 W) inside the cache.
- west to -149.20: Whittier, Passage Canal, Cape Puget.
- north to 61.45: Port Valdez, Columbia Bay, College Fiord.
- east to -145.20: Cordova, Orca Bay.

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

### What works with no connection

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

## Known issues

- A focal follow can only have its whale ID and focal ID edited while it is open.
  Photo-ID often happens after the encounter, so post-hoc editing of a closed
  focal is the obvious next feature.
- Closing the app mid-focal leaves that interval's `end_ts` null. There is no
  recovery path on startup.
- `icon-192.png` and `icon-512.png` do not exist. Only affects the home-screen
  icon.
- Focal labels restart at `FocalA` after **Clear all survey data**. Keep old
  exports separate, or separate them by date.

See `_status.md` for the full list and the reasoning behind the design decisions.

---

## Why not SeaLog

SeaLog (ABR) was reviewed as a reference for track recording. It does not record a
track. Every row in its output is an observer-triggered record stamped with the
position and GPS time at the moment of the tap; in a sample survey file all 3,686
data rows were type `USER`, spaced irregularly from 12 to 80 seconds apart. Any
"track" is only what the observations happen to trace, and it stops whenever
observers stop tapping.

This app keeps a dedicated `track_points` store on a 30-second floor, independent
of observer activity, which is the behaviour the survey needs. Nothing was carried
over from SeaLog except the practice of storing device time and GPS time in
separate columns.
