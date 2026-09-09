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
After the first time, permission persists for that browser profile and the app
reuses the granted port without showing the picker again.

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

**Browser support.** Web Serial is Chrome and Edge on desktop only. On Safari,
Firefox, or any iPad, the button reads **Device GPS** and the app falls back to
`navigator.geolocation`. Only one source is ever live at a time; connecting the
USB receiver stops the device watch, because interleaving two position streams
into one track produces a line that zigzags between them.

---

## Offline

| Works offline | Needs the network |
|---|---|
| The app shell (cached by the service worker) | First load, if opened from GitHub Pages with an empty cache |
| USB GPS position and track logging | Map tiles never viewed before |
| All logging, IndexedDB storage, CSV export | |
| Map tiles already viewed once while online | |

**Before leaving the dock**, while still on wifi: open the app and pan and zoom
over the survey area at every zoom level you expect to use. The service worker
caches tiles as they are fetched, so a tile that has never been displayed is not
available offline. This is an operational step, not a bug — there is no
pre-caching tool in the app.

The laptop path (`localhost`) has no first-load problem at all, which is why it is
the recommended field setup.

`navigator.storage.persist()` is requested at startup. If the browser refuses, the
status line says so — export more often, because IndexedDB is the only copy of the
data until a CSV is saved.

---

## Data and export

**Export CSV** writes a single long-format file, `survey_log_<device>_<stamp>.csv`,
one row per record, in strict time order. `record_type` is one of `FOCAL`,
`INTERVAL`, `BLOW`, `EVENT`, `TRACK`.

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

**Merging two devices.** Use **Export JSON** on each device and **Import JSON** on
one of them, then export a combined CSV. Every record id is `device_id + uuid`, so
a merge is a plain `put()` with no collision logic. Focal labels are per-device —
two iPads will both produce `FocalA` — so use `device_label` to tell them apart.

---

## Tests

    node test_gps.js

39 assertions covering NMEA parsing: checksums against canonical published
sentences, `ddmm.mmmm` / `dddmm.mmmm` coordinate conversion with hemisphere signs
(round-tripped against a real Cook Inlet position, 59.62882, -151.6138883),
two-digit year handling, invalid-fix rejection, sentence reassembly across stream
chunks, and the end-to-end sentence-to-fix pipeline.

There is no automated test of the browser UI wiring; that is exercised by hand.

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
