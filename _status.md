# Survey Logger — status

Last updated: 2026-09-09

## How to run

    python -m http.server 8080 --bind 127.0.0.1
    # open http://localhost:8080/

Must be served over http, not opened as file://. Service workers refuse to
register over file://, and OSM tiles 403 without a referer.

The service worker is DISABLED on localhost/127.0.0.1 (see main.js). Cache-first
is right in the field and wrong while iterating: it served two-round-old files
and cost a debugging round. No cache bumping needed during development.

## Completed

- Serve-locally workflow; map tiles and service worker both working.
- Modal stacking fix: `#map` gets `position: relative; z-index: 0` so Leaflet's
  panes (400) and controls (800) stop painting over `.modal` (50).
- Service worker install fixed — `SHELL_FILES` had two icon files that do not
  exist, and `cache.addAll()` rejects atomically on any 404.
- Focal follow opens a SURFACE interval immediately, so the blow button is
  present the moment the panel opens.
- Blow button during a dive closes the dive and opens a new surfacing.
- Interval timer (colour-coded: amber "Down", green "Surface").
- Notes during a focal, stamped with focal + interval.
- Track cadence 10 s (floor, not a period — driven by position callbacks), plus
  a forced point whenever something is logged.
- Focal labels FocalA/FocalB..., auto-assigned per device.
- Whale ID field, assignable at any point in a follow.
- Focal ID editable during a follow, with a warning on duplicate or blank labels.
- Cumulative CSV export, ONE file: survey_log_<device>_<stamp>.csv, holding
  TRACK, EVENT, FOCAL, INTERVAL and BEHAVIOR rows. Long format, one row per
  record, one shared column set, strict time order.
- navigator.storage.persist() requested at startup; warns in the status line if
  the browser refuses.
- "Clear all survey data" button with a typed-CLEAR confirmation, record counts,
  and an Export CSV button inside the confirmation dialog.
- Layout: map is the main view; all controls in a left sidebar with Log/Focal
  tabs. Buttons at the 44px iOS touch minimum.
- Sequential surfacing numbers within each focal (surfacing_num, surfacing_id).
- Timestamped behaviours replacing the single blow button: blow, breach, lunge,
  fluke up, fluke down, slap, other. Store `behaviors`, DB v2.
- USB GPS on COM3 at 4800 baud, read in-page via the Web Serial API (gps.js).
  Auto-reconnect on drop, forced port reopen on a silent feed.
- gps_source / gps_time_utc columns on TRACK rows.
- README.md.
- Map layer control: NOAA ENC nautical chart (default), OpenStreetMap,
  OpenSeaMap seamark overlay, plus any offline layer found on disk.
- tools/fetch_tiles.py: downloads tiles to tiles/<layer>/{z}/{x}/{y}.png and
  writes tiles/manifest.json. App reads the manifest at startup and prefers
  cached layers when present.
- tools/check_static.py: ids, namespace exports, script order, service worker
  shell list, and NOAA_LAYERS agreement between ui.js and the fetcher.
- test_gps.js: 44 assertions on NMEA parsing, the sentence-to-fix pipeline, and
  the busy-COM-port failure path.
- test_export.js: 32 assertions on the two-file CSV export, including the
  no-follows and empty-database cases.
- test_startup.js: 12 assertions that startup completes and every button gets
  wired. A rejection anywhere in main.js init() is caught by one handler at the
  bottom, skipping wireControls() and leaving the WHOLE UI inert with only a
  status line as the clue.

## Key decisions

- `focal_id` holds the human label ("FocalA"); the UUID join key is `focal_uuid`.
- `focal_id` / `whale_id` are joined onto rows AT EXPORT, not copied at write
  time. This is what lets a whale ID assigned late in a follow reach every blow
  and interval already recorded under it. Do not move this to write time.
- `switchInterval()` assigns `state.focalInterval` before awaiting the IndexedDB
  write, so a rapid second blow tap cannot file its blow against the closed dive.
- Blow count is incremented locally on tap; `countBlows()` scans the whole store
  and must not sit between the tap and the number changing.
- Focal labels are per-device. Two iPads will both produce "FocalA";
  `device_label` on the focal record disambiguates after a merge.
- Dive duration is measured to first blow, not to first visual surfacing.
- Starting a focal follow auto-enables track logging (user decision, 2026-09-07).
  It stays on after the follow ends until toggled off.
- surfacing_num is DERIVED at export from interval order within a focal, not
  stored. Single source of truth, and it applies to intervals recorded before
  the concept existed. App.state.surfacingNum is display-only.
- Sidebar uses overflow-y: scroll, not auto. A scrollbar appearing on one tab
  and not the other would resize the map cell without Leaflet noticing.
- 44px is a floor, not a preference. Going below it needs a density toggle.
- The browser CANNOT append to a file on disk. Each export re-reads the whole
  database, so every file is a strict superset of the last and only the newest
  needs keeping. IndexedDB is therefore the accumulator and the single point of
  failure, which is why persist() matters.
- Export is sorted strictly by ts. Focal blocks come out contiguous for free,
  because one device can only run one follow at a time. No grouping logic.
- `ts` means start time on INTERVAL and FOCAL rows, event time on the rest.
- Track points are assigned to a focal by timestamp window, same device only.
  Focals with no end_ts are skipped rather than allowed to swallow every later
  track point.
- JSON merge export is unchanged; it serves the multi-device merge path.
- Clear wipes events, track_points, focals, focal_intervals, blows. It KEEPS the
  meta store (device id and label) and the tag list, which are configuration
  rather than observations. Clear is blocked while a focal follow is open, and
  reloads the page afterwards rather than unwinding map layers by hand.
- The offline tile layer sets minZoom 0 / maxZoom 18 for DISPLAY and
  min/maxNativeZoom to the cached range. Setting minZoom/maxZoom to the cached
  range instead is the obvious-looking mistake and hides the layer entirely
  outside it, so opening the map at an uncached zoom gives a blank grey page.
- The fetcher writes the manifest at the START of a run and every 500 tiles, not
  only at the end. A manifest written only on completion leaves the app
  describing the PREVIOUS run's area for the hours the new one takes - which is
  exactly how the app came to show a 90-tile test cache on 2026-09-09.
- The manifest carries `complete`, and the status line says INCOMPLETE when a
  run was interrupted. Silently showing a smaller area than expected is how you
  find out at sea instead of at the dock.
- Offline tiles go to DISK and are served from localhost, not left to the
  service worker's runtime cache. The SW cache needs the area panned at every
  zoom while online and can be evicted; disk tiles cannot. The SW path remains
  for the iPad, which cannot run the fetcher.
- tiles/ is gitignored. ~250 MB of binary derived data does not belong in git;
  each machine runs the fetcher once after cloning.
- Chart source is NOAA ENC via gis.charttools.noaa.gov MCS WMS. NOAA's raster
  chart (RNC) tile services were retired in 2025: tileservice.charts.noaa.gov
  and seamlessrnc.nauticalcharts.noaa.gov both time out. Do not reinstate them.
- The fetcher renders each XYZ tile as its own EPSG:3857 WMS GetMap, so a WMS
  source ends up in the same {z}/{x}/{y} layout as an XYZ source and the offline
  layer is a plain L.tileLayer regardless of where the tiles came from.
- NOAA default, OSM behind a flag and throttled to 1 req/s: bulk downloading
  from tile.openstreetmap.org is against the OSMF tile usage policy. NOAA is
  US Government work in the public domain with no such restriction.
- Default bbox widened 2026-09-09 to S 59.30 W -149.20 N 61.45 E -145.20 after
  the first box (S 59.95) was found to cut off the southern half of Montague
  Island and the Hinchinbrook Entrance approaches. Also brings Middleton Island
  inside the cache.
- The fetcher rewrites the manifest from what is actually on disk, so an
  interrupted run still leaves a manifest that matches reality.
- Position sources live in gps.js behind one fix shape {lat, lon, ts, source,
  gps_time}. app.js does not know which source is running. Adding a third source
  later (a NMEA-over-TCP feed from a vessel network, say) should not touch app.js.
- Only ONE source is live at a time. Connecting serial stops the geolocation
  watch. Two independent position streams written into one track store produce a
  line that zigzags between them and cannot be disentangled afterwards.
- Web Serial needs a secure context. http://localhost qualifies, http://<LAN-IP>
  does not. Field procedure on the laptop is localhost, decided 2026-09-09.
- Track ts stays on the DEVICE clock, not GPS time, so track points remain
  joinable to every other record type by timestamp window. GPS time is kept
  alongside in gps_time. SeaLog stores both for the same reason.
- Talker ID is ignored; the sentence type is the last three characters. Matching
  the literal $GPRMC would silently log nothing from a $GN receiver, which is
  most modern USB pucks.
- RMC is preferred over GGA. GGA is used only after RMC has been quiet 5 s, so a
  receiver sending both does not double-log, and a GGA-only receiver still works.
- Invalid-fix sentences (RMC status V, GGA quality 0) are dropped, not logged.
  Some receivers keep filling in the last known position in those sentences.
- navigator.serial.getPorts() returns every port ever granted to this origin,
  in no defined order. Reusing granted[0] is only safe when there is exactly
  one; otherwise the picker is shown. On reconnect, only a port that is the
  chosen one or matches its USB vendor/product ids is accepted, so a dropped
  GPS cannot silently come back as some other authorised device.
- A COM port is EXCLUSIVE on Windows: one process at a time. Two programs
  cannot share one receiver without a virtual COM port splitter (com0com +
  hub4com, or VSPE). This is the most likely cause of a Connect GPS that does
  nothing, and the failure message now names it.
- The FIRST port open is awaited inside connectSerial, not left to the session
  loop. Handing the port straight to the background loop made connectSerial
  return true while the open was still failing, so the button reported success
  and then looped 'retrying...' forever on a permanent condition. Reproduced
  in test_gps.js against the pre-fix code before fixing.
- serialSession only retries a port that has opened at least once (everOpened).
  Retrying one that never opened loops on something a reconnect cannot fix.
- A silent serial feed, not an exception, is the usual way a track dies. The
  stale watch forces the port back open after 30 s of silence.
- Track cadence changed 30 s -> 10 s on 2026-09-09 (user request), and a point
  is now forced on every logged action: event tag, note, focal start/end,
  interval switch, blow. The `trigger` column says which produced each point,
  so a track can be thinned back to pure cadence later.
- A forced point uses the LAST FIX for position but the EVENT time for ts, so
  it sorts alongside the record it accompanies. There is no way to request a
  fix synchronously; at 1 Hz off the USB receiver the position is under a
  second stale.
- A forced write resets lastTrackLogTs. Otherwise a run of blows would write a
  point per tap AND leave the cadence ticking underneath, doubling density
  during the busiest part of a follow.
- Export went two files -> ONE file on 2026-09-10 (user request), reversing the
  split made the day before. Track points are in it. seq is global 1..n and the
  five record types share one column set: a row is only ever one kind of thing,
  so inapplicable columns are simply blank.
- exportCSV still returns { files: [...] } with a single entry. The callers
  already render a list, and keeping the shape means adding a second output
  later does not ripple back through the UI.
- BEHAVIOR rows carry their own lat/lon as well as forcing a track point. In a
  combined file, a breach with no position would have to be joined to the track
  point beside it to be mapped - needless work for a value already in hand.
- The single blow button became a set of timestamped behaviours on 2026-09-09
  (user request). The record field is `behavior`; the sticky Unknown/Transit/
  Foraging state was RENAMED from `behavior` to `activity` in the same change,
  because two columns called behavior meaning different things is the notation
  collision that costs an afternoon later. Buttons: .behavior-btn (events) and
  .activity-btn (sticky).
- BEHAVIORS lives in app.js and the button grid is rendered from it, so the
  buttons and the exported strings cannot drift. Values are stored verbatim:
  ADD to the list, never rename, once a season has data.
- Only `blow` closes a dive and opens a surfacing (user decision, 2026-09-09).
  A fluke up marks a dive starting, so auto-opening a surfacing would be wrong,
  and a breach mid-dive is still a real observation.
- logBehavior does NOT require an open SURFACE interval, unlike the old logBlow.
  Refusing to record a behaviour seen during a dive would silently drop data.
- countBlows filters behavior === 'blow'. The panel count is "blows this
  surfacing", a respiration measure; a breach must not inflate it.
- record_type BLOW became BEHAVIOR. DB v1 -> v2 copies `blows` into `behaviors`
  with behavior: 'blow'. The old store is NOT deleted: a half-completed copy
  that then dropped the source would lose field data.
- importFile folds a legacy `blows` array into `behaviors` the same way, so an
  export taken before v2 still merges. Tested; the IndexedDB upgrade path is not.
- The behavior -> activity rename is handled on THREE paths, because missing any
  one loses the sticky state silently rather than with an error: the v2 upgrade
  rewrites existing focals/intervals, importFile rewrites legacy rows, and the
  export reads `activity || behavior` so a row that missed both still comes out
  right. The export fallback is negative-tested.
- Focal labels restart at FocalA after a clear. If an old export is later merged
  with a new one, FocalA will appear twice; separate by date or keep the files
  apart.

## Outstanding / known issues

- Whale ID and focal ID can only be edited while the follow is open. No post-hoc
  editing of a closed focal (photo-ID often happens after the encounter). This is
  the obvious next feature: a focal list with editable ID fields.
- Auto-numbering parses labels as Focal + optional separator + 1-2 letters,
  case-insensitively (FOCAL_LABEL_RE in app.js). A rename therefore stays in the
  sequence: "Focal D" makes the next one "Focal E", inheriting the separator and
  casing of the highest-numbered label. Names that are not a position in a
  sequence ("FocalTest") drop out. Two letters max, so AA..ZZ covers 702 follows.
- Next label is always max+1 over parseable labels, never most-recent+1, so
  renaming a focal to a lower letter cannot roll the sequence backwards and
  reissue a label that is already in use.
- Closing the app mid-focal leaves that interval's `end_ts` null. No recovery
  path on startup.
- `icon-192.png` / `icon-512.png` do not exist. Only affects the home-screen
  icon; manifest and apple-touch-icon still reference them.
- NOAA ENC WMS layer numbers are UNDOCUMENTED. GetCapabilities lists layers
  0-12 with no <Title> elements, so there is no published mapping to ENC usage
  bands. layers=0,1,2,3,4,5,6 was chosen by rendering PWS and looking at it;
  which band appears at which zoom is untested. Set in both ui.js (NOAA_LAYERS)
  and tools/fetch_tiles.py, and they must be kept in step or the cached tiles
  will not match the online layer.
- The iPad still has no pre-caching. There the survey area must be panned at the
  zoom levels to be used, while online, before leaving the dock.
- The map layer control has not been exercised in a browser.
- The IndexedDB v1 -> v2 migration is NOT tested. importFile's equivalent legacy
  path is, but the upgrade transaction itself needs a real browser. To check:
  open the app on a device that has pre-2026-09-09 blows and confirm the export
  shows them as BEHAVIOR rows with behavior=blow.
- The com0com / VSPE splitter route is documented but untested.
- Serial reconnect, the stale/dead-feed watch, and the port picker have not been
  exercised against real hardware. The parser and the sentence-to-fix pipeline
  are tested; everything downstream of navigator.serial is not.
- COM3 at 4800 is assumed from the receiver on hand. The browser's port picker
  lets any port be chosen, but the baud rate is fixed in gps.js (SERIAL_BAUD).
- Chrome treats the second programmatic download as a popup. There is a 400 ms
  gap between the two files, but the browser may still ask once for permission
  to download multiple files. Not yet confirmed in a real browser.
- At 10 s cadence a 10-hour day is ~3,600 track rows before forced points.
  loadExistingIntoMap() adds every one to a single polyline at startup; not
  yet checked for responsiveness across a multi-day survey without a clear.
- iPad testing needs https or GitHub Pages. `http://<LAN-IP>:8080` is not a
  secure context, so iOS Safari gives neither geolocation nor a service worker.
- Button-level UI wiring has not been exercised in a browser; verification so
  far is a scripted harness against `app.js` plus a static id/reference check.
