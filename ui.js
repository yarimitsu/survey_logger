// ui.js — DOM rendering and map drawing. Talks to App/DB, no business logic here.

// Opening view: the middle of Prince William Sound. This is a view point only —
// it is deliberately NOT the centre of the cached bbox, which extends south past
// Montague Island into the Gulf and would open the map on open water.
const PWS_CENTER = [60.65, -147.1];

function $(sel) { return document.querySelector(sel); }
function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

function setStatus(msg) {
  $('#status-line').textContent = msg;
}

function fmtCoord(v) {
  return v === null || v === undefined ? '—' : v.toFixed(5);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// The GPS button is the only place the active position source is visible, and
// which source is running changes what the track means: the USB puck is metres,
// a Windows laptop's own location service is hundreds of metres at best and
// nothing at all with no internet. Worth a permanent readout, not a status line
// message that scrolls away.
function updateGpsUI() {
  const btn = $('#gps-btn');
  if (!btn) return;
  const src = GPS.activeSource();
  btn.classList.toggle('gps-on', src === 'serial');
  if (src === 'serial') {
    btn.textContent = 'USB GPS';
    btn.title = 'Reading NMEA from the USB receiver. Click to disconnect.';
  } else if (!GPS.isSerialSupported()) {
    btn.textContent = 'Device GPS';
    btn.title = 'This browser has no Web Serial; using the device location service.';
  } else {
    btn.textContent = 'Connect GPS';
    btn.title = 'Connect a USB NMEA receiver over a COM port.';
  }
}

// Cleared and rescheduled on every incoming fix. Fires when the fix feed goes
// silent long enough that stamping new records with the last known position
// would be misleading. 15 s matches POSITION_STALE_MS in app.js.
let gpsStaleTimer = null;

function updatePositionUI(p) {
  const coordLine = $('#coord-line');
  coordLine.textContent = `${fmtCoord(p.lat)}, ${fmtCoord(p.lon)}`;
  coordLine.classList.remove('gps-lost');
  clearTimeout(gpsStaleTimer);
  gpsStaleTimer = setTimeout(() => {
    coordLine.classList.add('gps-lost');
    coordLine.textContent = 'GPS lost';
    setStatus('WARNING: GPS signal lost. Check the GPS receiver.');
  }, 15000);
  updateGpsUI();
  if (App.state.map) {
    if (!App.state.posMarker) {
      App.state.posMarker = L.circleMarker([p.lat, p.lon], {
        radius: 6, color: '#3ddc97', fillColor: '#3ddc97', fillOpacity: 1, weight: 2,
      }).addTo(App.state.map);
    } else {
      App.state.posMarker.setLatLng([p.lat, p.lon]);
    }
  }
}

// NOAA's Electronic Navigational Chart service. This is the reason the map has
// a layer control rather than one hardcoded tile layer: a marine survey needs
// soundings and depth contours, and OpenStreetMap has neither.
//
// The layer numbers are a known gap. The service's GetCapabilities document
// lists layers 0-12 with no <Title> elements, so there is no published mapping
// from these numbers to ENC usage bands (Overview, General, Coastal, Approach,
// Harbour). 0-6 was chosen by rendering Prince William Sound and looking at the
// result; which band appears at which zoom is untested. Change NOAA_LAYERS if
// the chart is too cluttered or too sparse at working zoom.
const NOAA_WMS =
  'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer' +
  '/exts/MaritimeChartService/WMSServer';
const NOAA_LAYERS = '0,1,2,3,4,5,6';

// Written by tools/fetch_tiles.py. Absent unless the fetcher has been run, in
// which case the app is online-only and says so.
const TILE_MANIFEST = 'tiles/manifest.json';

async function loadTileManifest() {
  try {
    const res = await fetch(TILE_MANIFEST, { cache: 'no-store' });
    if (!res.ok) return null;
    const m = await res.json();
    return m && m.layers && Object.keys(m.layers).length ? m : null;
  } catch (_) {
    // No manifest is the normal case on a fresh clone, not an error.
    return null;
  }
}

function onlineLayers() {
  return {
    'Nautical chart (NOAA ENC)': L.tileLayer.wms(NOAA_WMS, {
      layers: NOAA_LAYERS,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      maxZoom: 16,
      attribution: 'NOAA ENC',
    }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap',
    }),
  };
}

async function initMap() {
  const map = L.map('map', { zoomControl: true }).setView(PWS_CENTER, 9);
  App.state.map = map;

  const bases = {};
  const manifest = await loadTileManifest();

  // Cached tiles come first so they are the default when present: on a boat with
  // no signal, an online layer is a grey grid.
  if (manifest) {
    for (const [key, info] of Object.entries(manifest.layers)) {
      bases[`${info.title || key} (offline)`] = L.tileLayer(`tiles/${key}/{z}/{x}/{y}.png`, {
        // minZoom/maxZoom are the zooms the layer will DISPLAY at;
        // min/maxNativeZoom are the zooms it actually has files for. Setting the
        // first pair to the cached range is the obvious-looking mistake: it
        // hides the layer entirely outside that range, so opening the map at a
        // zoom the cache does not contain gives a blank grey page. Leave display
        // wide open and let the native bounds upscale the nearest cached tile.
        minZoom: 0,
        maxZoom: 18,
        minNativeZoom: info.minzoom,
        maxNativeZoom: info.maxzoom,
        attribution: (info.attribution || '') + ' (cached)',
      });
    }
  }
  Object.assign(bases, onlineLayers());

  const overlays = {
    'Seamarks (OpenSeaMap)': L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenSeaMap',
    }),
  };

  // Cached first if there is one, so a boat with no signal opens to a usable
  // map rather than a grey grid.
  Object.values(bases)[0].addTo(map);
  L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);

  App.state.trackLine = L.polyline([], { color: '#3ddc97', weight: 3 }).addTo(map);
  App.state.tileManifest = manifest;
  // Say what the cache actually holds, not just that it exists. A run of
  // fetch_tiles.py that is still going, or was interrupted, leaves a real
  // manifest describing a smaller area than expected, and silently showing that
  // smaller area is how you find out at sea instead of at the dock.
  if (manifest) {
    const parts = Object.entries(manifest.layers).map(([k, i]) =>
      `${k} z${i.minzoom}-${i.maxzoom}, ${i.tiles} tiles${i.complete === false ? ' (INCOMPLETE)' : ''}`);
    setStatus(`Ready. Cached: ${parts.join('; ')}.`);
  } else {
    setStatus('Ready. No cached tiles — the map needs a connection. See README.');
  }
}

function drawTrackPoint(rec) {
  if (!App.state.map) return;
  App.state.trackLine.addLatLng([rec.lat, rec.lon]);
}

const TAG_COLORS = {
  CTD: '#4fb0ff', eDNA: '#c792ea', Trawl: '#ffcb6b', Calibration: '#7c8a99',
  Anchor: '#82aaff', Wildlife: '#ff9f43', Note: '#e8edf2',
};

function drawEventMarker(rec) {
  if (!App.state.map || rec.lat == null) return;
  const color = TAG_COLORS[rec.tag_label] || '#ff5d5d';
  const m = L.circleMarker([rec.lat, rec.lon], {
    radius: 7, color, fillColor: color, fillOpacity: 0.85, weight: 1,
  }).addTo(App.state.map);
  m.bindPopup(`<b>${rec.tag_label}</b><br>${fmtTime(rec.ts)}<br>${rec.notes || ''}`);
  App.state.eventMarkers.push(m);
}

async function loadExistingIntoMap() {
  const [tracks, events] = await Promise.all([DB.getAll('track_points'), DB.getAll('events')]);
  tracks.sort((a, b) => a.ts - b.ts);
  for (const t of tracks) App.state.trackLine.addLatLng([t.lat, t.lon]);
  for (const e of events) drawEventMarker(e);
  if (tracks.length) {
    App.state.map.fitBounds(App.state.trackLine.getBounds(), { maxZoom: 13 });
  }
}

// ---------- quick tag grid ----------

async function renderTagGrid() {
  const grid = $('#tag-grid');
  grid.innerHTML = '';
  for (const tag of App.state.tags) {
    const btn = el('button', { className: 'tag-btn', textContent: tag.label });
    btn.style.setProperty('--tag-color', TAG_COLORS[tag.label] || '#7c8a99');
    btn.addEventListener('click', () => openNotesPrompt(tag));
    grid.appendChild(btn);
  }
}

function openNotesPrompt(tag) {
  $('#notes-modal-title').textContent = tag ? `Log: ${tag.label}` : 'Note';
  $('#notes-input').value = '';
  $('#notes-modal').classList.remove('hidden');
  $('#notes-input').focus();
  $('#notes-save').onclick = async () => {
    const notes = $('#notes-input').value.trim();
    await App.logEvent(tag ? tag.id : null, tag ? tag.label : 'Note', notes);
    $('#notes-modal').classList.add('hidden');
    setStatus(`Logged: ${tag ? tag.label : 'Note'} at ${fmtTime(Date.now())}`);
  };
}

// ---------- tag manager ----------

async function renderTagManager() {
  const list = $('#tag-list');
  list.innerHTML = '';
  const all = await DB.getAll('tags');
  for (const t of all.filter((x) => x.active)) {
    const row = el('div', { className: 'tag-row' }, [
      el('span', { textContent: t.label }),
      el('button', { className: 'small-btn danger', textContent: 'Remove' }),
    ]);
    row.querySelector('button').addEventListener('click', async () => {
      await App.deactivateTag(t.id);
      await renderTagGrid();
      await renderTagManager();
    });
    list.appendChild(row);
  }
}

// ---------- clear data ----------

const CLEAR_LABELS = {
  track_points: 'Track points',
  events: 'Events and notes',
  focals: 'Focal follows',
  focal_intervals: 'Intervals',
  behaviors: 'Behaviors',
};

async function openClearModal() {
  const counts = await App.surveyCounts();
  const list = $('#clear-counts');
  list.innerHTML = '';
  let total = 0;
  for (const [store, n] of Object.entries(counts)) {
    total += n;
    list.appendChild(el('div', { className: 'tag-row' }, [
      el('span', { textContent: CLEAR_LABELS[store] || store }),
      el('span', { textContent: String(n) }),
    ]));
  }
  $('#clear-total').textContent = String(total);
  $('#clear-input').value = '';
  $('#clear-confirm').disabled = true;
  $('#clear-modal').classList.remove('hidden');
}

// ---------- focal follow panel ----------

// Whale ID is focal-scoped, so it is set here at focal start and never touched
// by clearOptionalFields().
function setFocalHeader(focal) {
  $('#focal-label').textContent = focal && focal.focal_id ? `— ${focal.focal_id}` : '';
  $('#field-focal-id').value = focal && focal.focal_id ? focal.focal_id : '';
  $('#field-whale-id').value = focal && focal.whale_id ? focal.whale_id : '';
  $('#focal-id-warning').textContent = '';
}

// Mirrors the edited label into the header and reports a duplicate or blank
// label, both of which break the join to the acoustic data.
async function refreshFocalIdState(label) {
  const trimmed = (label || '').trim();
  $('#focal-label').textContent = trimmed ? `— ${trimmed}` : '';
  const warn = $('#focal-id-warning');
  if (!trimmed) {
    warn.textContent = 'Blank focal ID — these rows will export with no focal label.';
  } else if (await App.focalIdCollision(trimmed)) {
    warn.textContent = `Another focal on this device is already called ${trimmed}.`;
  } else {
    warn.textContent = '';
  }
  updateSurfacingLine();
}

function setTrackToggle(on) {
  const btn = $('#track-toggle');
  btn.textContent = on ? 'Stop Track' : 'Start Track';
  btn.classList.toggle('track-off', !on);
  btn.classList.toggle('track-on', on);
}

function showTab(name) {
  for (const b of document.querySelectorAll('.tab-btn')) {
    b.classList.toggle('active', b.dataset.tab === name);
  }
  $('#tab-log').classList.toggle('hidden', name !== 'log');
  $('#tab-focal').classList.toggle('hidden', name !== 'focal');
}

// The map is now the main view and never gets swapped out, so the focal module
// is a state of the sidebar rather than a panel that replaces the controls.
function showFocalPanel(show) {
  $('#focal-active').classList.toggle('hidden', !show);
  $('#focal-idle').classList.toggle('hidden', show);
  if (show) showTab('focal');
}

function updateSurfacingLine() {
  const iv = App.state.focalInterval;
  const n = App.state.surfacingNum;
  $('#surfacing-line').textContent =
    iv && n ? `Surfacing ${n}` : '—';
}

function setActiveIntervalButton(type) {
  for (const b of document.querySelectorAll('.interval-btn')) {
    b.classList.toggle('active', b.dataset.type === type);
  }
}

// Displayed count is kept locally so a tap registers immediately; countBlows()
// scans the whole blows store, which gets slow over a season and must not sit
// between the tap and the number changing.
let blowCount = 0;

function bumpBlowCount() {
  blowCount += 1;
  $('#blow-count').textContent = blowCount;
}

// Authoritative recount from the DB. Cheap to call on interval switch (rare),
// never on a tap.
async function refreshBlowCount() {
  if (!App.state.focalInterval) {
    blowCount = 0;
    $('#blow-count').textContent = '0';
    return;
  }
  blowCount = await App.countBlows(App.state.focalInterval.id);
  $('#blow-count').textContent = blowCount;
}

// ---------- interval timer ----------

let timerHandle = null;

function updateIntervalTimer() {
  const iv = App.state.focalInterval;
  const box = $('#interval-timer');
  if (!iv) {
    box.textContent = '—';
    delete box.dataset.type;
    return;
  }
  // Derived from start_ts, not an accumulator, so a throttled background tab
  // still shows the true elapsed time.
  const secs = Math.max(0, Math.floor((Date.now() - iv.start_ts) / 1000));
  const label = iv.type === 'DIVE' ? 'Down' : iv.type === 'SURFACE' ? 'Surface' : 'Unclear';
  box.textContent = `${label} ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  box.dataset.type = iv.type;
  updateSurfacingLine();
}

function startIntervalTimer() {
  stopIntervalTimer();
  updateIntervalTimer();
  timerHandle = setInterval(updateIntervalTimer, 1000);
}

function stopIntervalTimer() {
  if (timerHandle !== null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  const box = $('#interval-timer');
  box.textContent = '—';
  delete box.dataset.type;
  $('#surfacing-line').textContent = '—';
}

// Built from App.BEHAVIORS rather than written into index.html, so the button
// row and the values that reach the CSV cannot drift apart.
function renderBehaviorGrid(onTap) {
  const grid = $('#behavior-grid');
  grid.innerHTML = '';
  for (const b of App.BEHAVIORS) {
    const btn = el('button', {
      className: 'behavior-btn' + (b === 'blow' ? ' primary' : ''),
      textContent: b === 'blow' ? 'Blow' : b.replace(/^./, (c) => c.toUpperCase()),
    });
    btn.dataset.behavior = b;
    btn.addEventListener('click', () => onTap(b));
    grid.appendChild(btn);
  }
}

// Brief highlight so a tap is visibly registered on a moving boat, where the
// count only changes for blows and the other behaviours would otherwise give no
// feedback at all.
const flashTimers = new WeakMap();

function flashBehavior(behavior) {
  // Matched by walking the buttons rather than with an attribute selector:
  // behaviour names contain spaces ("fluke up"), and this needs no escaping.
  for (const b of document.querySelectorAll('#behavior-grid .behavior-btn')) {
    if (b.dataset.behavior !== behavior) continue;
    b.classList.add('just-tapped');
    // Blows can come faster than the highlight lasts. Without clearing the
    // previous timer, the first tap's expiry wipes the highlight while the
    // second tap is still current, and the button reads as unregistered.
    clearTimeout(flashTimers.get(b));
    flashTimers.set(b, setTimeout(() => b.classList.remove('just-tapped'), 350));
    return;
  }
}

function setActivityButtons(active) {
  for (const b of document.querySelectorAll('.activity-btn')) {
    b.classList.toggle('active', b.dataset.activity === active);
  }
}

function clearOptionalFields() {
  $('#field-distance').value = '';
  $('#field-bearing').value = '';
  $('#field-direction').value = '';
  $('#quality-good').classList.add('active');
  $('#quality-bad').classList.remove('active');
}

const UI = {
  $, el, setStatus, fmtCoord, fmtTime, updatePositionUI, updateGpsUI, initMap, drawTrackPoint,
  loadTileManifest,
  drawEventMarker, loadExistingIntoMap, renderTagGrid, openNotesPrompt, renderTagManager,
  showFocalPanel, showTab, setTrackToggle, setFocalHeader, refreshFocalIdState, openClearModal, setActiveIntervalButton, refreshBlowCount, bumpBlowCount,
  startIntervalTimer, stopIntervalTimer, setActivityButtons, clearOptionalFields,
  renderBehaviorGrid, flashBehavior,
};
