// app.js — survey logger core logic

const TRACK_INTERVAL_MS = 10000; // minimum spacing between track points (10 s)

const state = {
  config: null,
  lastPosition: null,      // {lat, lon, ts}
  trackOn: false,
  lastTrackLogTs: 0,
  tags: [],
  map: null,
  tileManifest: null,      // tiles/manifest.json, or null if not cached
  trackLine: null,
  eventMarkers: [],
  posMarker: null,
  focal: null,             // current open focal record, or null
  focalInterval: null,     // current open focal_intervals record, or null
  surfacingNum: 0,         // display only; the exported number is derived from
                           // interval order so it stays correct after a merge
  activity: 'unknown',     // sticky activity for the current focal (transit/foraging)
                           // NOT the same thing as a `behavior` record, which is a
                           // single timestamped event (blow, breach, fluke up...)
};

// ---------- geolocation ----------

// Position sources live in gps.js. Both of them — the device's own geolocation
// and a USB NMEA receiver on a COM port — deliver the same fix shape here, so
// nothing below this function knows or cares which one is running.
function startPositionWatch() {
  GPS.init({
    onFix: (p) => {
      state.lastPosition = p;
      updatePositionUI(p);
      if (state.trackOn) maybeLogTrackPoint(p);
    },
    onStatus: (msg) => {
      setStatus(msg);
      updateGpsUI();
    },
  });
  GPS.startDeviceWatch();
  updateGpsUI();
}

async function maybeLogTrackPoint(p, force = false) {
  if (!force && p.ts - state.lastTrackLogTs < TRACK_INTERVAL_MS) return;
  // Reset the floor on a forced write too. Without this, a run of blows would
  // write a point per tap AND leave the 10 s cadence ticking underneath it,
  // doubling track density during the busiest part of a follow.
  state.lastTrackLogTs = p.ts;
  const rec = {
    id: `${state.config.device_id}_${DB.uuid()}`,
    device_id: state.config.device_id,
    ts: p.ts,
    lat: p.lat,
    lon: p.lon,
    // Which receiver produced this point. A survey that starts on the laptop's
    // own location service and later switches to the USB puck has a step change
    // in accuracy partway through the track; without this column there is no
    // way to see it after the fact.
    source: p.source || 'device',
    // The receiver's own UTC, where it reports one. `ts` stays on the device
    // clock so every record type remains joinable, but a laptop that has been
    // off the network for a week can drift minutes, and this is the only way
    // to detect that later. SeaLog keeps both for the same reason.
    gps_time: p.gps_time == null ? null : p.gps_time,
    // Set on points written because something was logged, rather than because
    // the 10 s timer came round. Lets a track be thinned back to pure cadence
    // later without losing the fact that these coincide with an observation.
    trigger: force ? 'event' : 'cadence',
  };
  await DB.put('track_points', rec);
  drawTrackPoint(rec);
}

// Drop a track point at the moment something is logged, on top of the 10 s
// cadence, so every record has a position fixed at its own timestamp rather
// than interpolated between two cadence points up to 10 s away.
//
// The position is the last fix received, not a fresh one — there is no way to
// ask for a fix synchronously. At 1 Hz off the USB receiver that is under a
// second stale. The timestamp is the EVENT time, not the fix time, so the
// forced point sorts alongside the record it accompanies in the export.
async function forceTrackPoint(ts) {
  if (!state.trackOn) return;
  const p = currentPositionOrNull();
  if (!p) return;
  await maybeLogTrackPoint({ ...p, ts: ts || Date.now() }, true);
}

function currentPositionOrNull() {
  return state.lastPosition;
}

// ---------- events (quick tags + free notes) ----------

async function logEvent(tagId, tagLabel, notes) {
  const p = currentPositionOrNull();
  const rec = {
    id: `${state.config.device_id}_${DB.uuid()}`,
    device_id: state.config.device_id,
    ts: Date.now(),
    lat: p ? p.lat : null,
    lon: p ? p.lon : null,
    tag_id: tagId || null,
    tag_label: tagLabel || 'Note',
    notes: notes || '',
    // Null outside a focal follow; lets focal notes be joined to the surfacing
    // or dive they were made during.
    focal_uuid: state.focal ? state.focal.id : null,
    interval_id: state.focalInterval ? state.focalInterval.id : null,
  };
  await DB.put('events', rec);
  drawEventMarker(rec);
  await forceTrackPoint(rec.ts);
  return rec;
}

// ---------- focal follow ----------

// "FocalA" .. "FocalZ", then "FocalAA". Bijective base-26 so the sequence never
// runs out over a season.
function focalLetters(n) {
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function lettersToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// Accepts the separator and casing the user actually typed, so renaming a focal
// to "Focal D" makes the next one "Focal E" rather than reverting to "FocalE".
// Letters are capped at two: "FocalTest" is a name, not a position in a sequence,
// and AA..ZZ already covers 702 follows.
const FOCAL_LABEL_RE = /^(focal)(\s*[-_ ]?\s*)([a-z]{1,2})$/i;

function parseFocalLabel(label) {
  const m = FOCAL_LABEL_RE.exec((label || '').trim());
  return m ? { prefix: m[1], sep: m[2], letters: m[3] } : null;
}

function formatFocalLabel(template, n) {
  const letters = focalLetters(n);
  const wasLower = template.letters === template.letters.toLowerCase();
  return template.prefix + template.sep + (wasLower ? letters.toLowerCase() : letters);
}

// Next label after the highest already issued ON THIS DEVICE. Max+1 rather than
// count+1, so re-importing this device's own export cannot reissue a label.
// Focals imported from another iPad are skipped: each device keeps its own
// sequence, and device_label on the record tells them apart after a merge.
// The style of the highest-numbered label wins, since that is the one just
// renamed if any was.
async function nextFocalLabel() {
  const all = await DB.getAll('focals');
  let max = 0;
  let template = { prefix: 'Focal', sep: '', letters: 'A' };
  for (const f of all) {
    if (f.device_id !== state.config.device_id) continue;
    const parsed = parseFocalLabel(f.focal_id);
    if (!parsed) continue;
    const n = lettersToIndex(parsed.letters.toUpperCase());
    if (n > max) {
      max = n;
      template = parsed;
    }
  }
  return formatFocalLabel(template, max + 1);
}

async function startFocal() {
  const rec = {
    id: `${state.config.device_id}_${DB.uuid()}`,
    device_id: state.config.device_id,
    device_label: state.config.device_label,
    focal_id: await nextFocalLabel(),  // the name that matches the acoustic notes
    whale_id: '',                      // blank unless the animal gets identified
    start_ts: Date.now(),
    end_ts: null,
    notes: '',
    activity: state.activity,
  };
  await DB.put('focals', rec);
  state.focal = rec;
  state.focalInterval = null;
  state.surfacingNum = 0;
  await forceTrackPoint(rec.start_ts);
  return rec;
}

// Can be set at any point in the follow, including after every blow and
// interval has already been recorded; the export joins it back on.
// The label is auto-assigned but not sacred: it has to match whatever ended up
// in the acoustic notes, so it can be corrected during the follow.
async function setFocalId(value) {
  if (!state.focal) return;
  state.focal.focal_id = (value || '').trim();
  await DB.put('focals', state.focal);
}

// Duplicate labels break the join to the acoustic data. Reported rather than
// blocked, since correcting a mis-sequence may legitimately pass through a
// temporary collision.
async function focalIdCollision(label) {
  const trimmed = (label || '').trim();
  if (!trimmed) return false;
  const mine = state.focal ? state.focal.id : null;
  const all = await DB.getAll('focals');
  return all.some((f) =>
    f.id !== mine &&
    f.device_id === state.config.device_id &&
    (f.focal_id || '') === trimmed
  );
}

async function setWhaleId(value) {
  if (!state.focal) return;
  state.focal.whale_id = (value || '').trim();
  await DB.put('focals', state.focal);
}

async function setActivity(a) {
  state.activity = a;
  if (state.focal) {
    state.focal.activity = a;
    await DB.put('focals', state.focal);
  }
}

// Switch to a new interval type (SURFACE/DIVE/UNCLEAR). Closes the previous
// interval (if any) and opens a new one, stamped with current position and
// the currently-sticky behavior value.
async function switchInterval(type) {
  if (!state.focal) return;
  const now = Date.now();
  const prev = state.focalInterval;
  const p = currentPositionOrNull();
  const rec = {
    id: `${state.config.device_id}_${DB.uuid()}`,
    device_id: state.config.device_id,
    focal_uuid: state.focal.id,
    type,
    start_ts: now,
    end_ts: null,
    quality: 'good',
    lat: p ? p.lat : null,
    lon: p ? p.lon : null,
    distance_m: null,
    bearing_to_whale: null,
    swim_direction: null,
    activity: state.activity,
  };
  state.focalInterval = rec;
  if (type === 'SURFACE') state.surfacingNum += 1;
  if (prev && !prev.end_ts) {
    prev.end_ts = now;
    await DB.put('focal_intervals', prev);
  }
  await DB.put('focal_intervals', rec);
  await forceTrackPoint(now);
  return rec;
}

async function updateCurrentInterval(patch) {
  if (!state.focalInterval) return;
  Object.assign(state.focalInterval, patch);
  await DB.put('focal_intervals', state.focalInterval);
}

// One timestamped behaviour, filed against whatever interval is open.
//
// Unlike the old blow-only version this does NOT require a SURFACE interval:
// a fluke-up or a slap seen during a dive interval is still a real observation,
// and refusing to record it would silently drop data. Only the blow button
// carries the "the whale is up" meaning, and that logic lives in main.js where
// the interval switch happens.
async function logBehavior(behavior) {
  if (!state.focal) return null;
  const p = currentPositionOrNull();
  const rec = {
    id: `${state.config.device_id}_${DB.uuid()}`,
    device_id: state.config.device_id,
    focal_uuid: state.focal.id,
    interval_id: state.focalInterval ? state.focalInterval.id : null,
    ts: Date.now(),
    behavior,
    // Stamped here as well as on the forced track point, the same way an event
    // tag is. In a single combined file a behaviour row with no position would
    // have to be joined to the track point beside it to place a breach on a
    // map, which is needless work for a value already in hand.
    lat: p ? p.lat : null,
    lon: p ? p.lon : null,
  };
  await DB.put('behaviors', rec);
  await forceTrackPoint(rec.ts);
  return rec;
}

// Blows only. The count shown in the panel is "blows this surfacing", which is
// the respiration measure; a breach in the same surfacing must not inflate it.
async function countBlows(intervalId) {
  const all = await DB.getAll('behaviors');
  return all.filter((b) => b.interval_id === intervalId && b.behavior === 'blow').length;
}

async function endFocal() {
  const now = Date.now();
  if (state.focalInterval && !state.focalInterval.end_ts) {
    state.focalInterval.end_ts = now;
    await DB.put('focal_intervals', state.focalInterval);
  }
  if (state.focal) {
    state.focal.end_ts = now;
    await DB.put('focals', state.focal);
  }
  await forceTrackPoint(now);
  state.focal = null;
  state.focalInterval = null;
  state.surfacingNum = 0;
}

// ---------- tags ----------

async function loadTags() {
  const all = await DB.getAll('tags');
  state.tags = all.filter((t) => t.active);
  return state.tags;
}

async function addTag(label) {
  await DB.put('tags', { id: DB.uuid(), label, active: true });
  return loadTags();
}

async function deactivateTag(id) {
  const t = await DB.get('tags', id);
  if (t) {
    t.active = false;
    await DB.put('tags', t);
  }
  return loadTags();
}

// ---------- clearing between surveys ----------

// Survey data only. Device identity (meta) and the tag list are configuration,
// not observations, so they survive and the next survey starts with the same
// device name and the same custom tags.
const SURVEY_STORES = ['events', 'track_points', 'focals', 'focal_intervals', 'behaviors'];

async function surveyCounts() {
  const out = {};
  for (const name of SURVEY_STORES) out[name] = await DB.count(name);
  return out;
}

async function clearSurveyData() {
  for (const name of SURVEY_STORES) await DB.clearStore(name);
  state.focal = null;
  state.focalInterval = null;
  state.surfacingNum = 0;
  state.lastTrackLogTs = 0;
}

// ---------- export / import ----------

async function exportAll() {
  const dump = {};
  for (const store of ['tags', 'events', 'track_points', 'focals', 'focal_intervals', 'behaviors']) {
    dump[store] = await DB.getAll(store);
  }
  dump._exported_by = state.config.device_id;
  dump._exported_at = new Date().toISOString();
  const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `survey-export_${state.config.device_label}_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importFile(file) {
  const text = await file.text();
  const dump = JSON.parse(text);
  let count = 0;
  for (const store of ['tags', 'events', 'track_points', 'focals', 'focal_intervals', 'behaviors']) {
    const rows = dump[store] || [];
    for (const row of rows) {
      // Pre-v2 focals and intervals call the sticky state `behavior`; it is
      // `activity` now. Same rename the IndexedDB upgrade applies.
      const needsRename = (store === 'focals' || store === 'focal_intervals') &&
        row.activity === undefined && row.behavior !== undefined;
      await DB.put(store, needsRename ? { ...row, activity: row.behavior } : row);
      count++;
    }
  }
  // A file exported before v2 has a 'blows' array and no 'behaviors'. Those rows
  // are all blows by definition, same as the on-device migration.
  for (const row of dump.blows || []) {
    await DB.put('behaviors', { ...row, behavior: row.behavior || 'blow' });
    count++;
  }
  return count;
}

// CSV export for a single table, matching the field-notebook style column names
function toCSV(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map((r) =>
    columns
      .map((c) => {
        const v = r[c] === undefined || r[c] === null ? '' : String(r[c]);
        return '"' + v.replace(/"/g, '""') + '"';
      })
      .join(',')
  );
  return [header, ...lines].join('\n');
}

// Epoch ms stays the source of truth; the ISO column is there so the CSVs load
// into R without a conversion step and without a timezone guess.
function isoOrBlank(ts) {
  return ts === null || ts === undefined || ts === '' ? '' : new Date(ts).toISOString();
}

// One long-format file holding everything: track, events, focal follows,
// intervals and blows. Sorted strictly by time, which makes each focal's rows
// contiguous for free, since a device can only run one follow at a time.
//
// The browser cannot append to a file on disk. Instead every export re-reads the
// whole local database, so each file is a strict superset of the last one and
// nothing is lost by keeping only the newest.
// The behaviours the focal panel offers, in button order. Stored verbatim in the
// `behavior` field of a behaviors record, so changing a string here changes the
// value that lands in the CSV - add to the list rather than renaming, once a
// season has data.
const BEHAVIORS = ['blow', 'breach', 'lunge', 'fluke up', 'fluke down', 'slap', 'other'];

// One file, every record type, long format. The five record types share a
// column set rather than getting a table each: a row is only ever one kind of
// thing, so the columns that do not apply are simply blank, and everything
// stays joinable by ts without a second file to line up.
//
// Order matters for reading it in a spreadsheet: identity first, then what
// happened, then where, then the ids needed to join.
const ALL_COLUMNS = [
  'seq', 'record_type', 'ts', 'time_utc',
  'focal_id', 'whale_id', 'surfacing_num', 'surfacing_id',
  'behavior', 'activity',
  'interval_type', 'end_ts', 'end_time_utc', 'duration_s',
  'quality', 'secs_into_surfacing',
  'lat', 'lon', 'gps_source', 'gps_time_utc', 'trigger',
  'tag_label', 'notes',
  'distance_m', 'bearing_to_whale', 'swim_direction',
  'device_label', 'device_id', 'record_id', 'interval_id', 'focal_uuid',
];

function downloadCSV(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportCSV() {
  const [events, tracks, intervals, behaviors, focals] = await Promise.all([
    DB.getAll('events'), DB.getAll('track_points'), DB.getAll('focal_intervals'),
    DB.getAll('behaviors'), DB.getAll('focals'),
  ]);

  const intervalById = new Map(intervals.map((i) => [i.id, i]));
  const focalByUuid = new Map(focals.map((f) => [f.id, f]));
  const uuidOf = (r) => (r ? r.focal_uuid || r.focal_id || '' : '');

  // Surfacings numbered 1..n within each focal, in time order. Derived rather
  // than stored, so it is a single source of truth and covers intervals
  // recorded before surfacing numbers existed.
  const surfacingNumById = new Map();
  const byFocal = new Map();
  for (const iv of intervals) {
    const k = uuidOf(iv);
    if (!byFocal.has(k)) byFocal.set(k, []);
    byFocal.get(k).push(iv);
  }
  for (const list of byFocal.values()) {
    list.sort((a, b) => a.start_ts - b.start_ts);
    let n = 0;
    for (const iv of list) if (iv.type === 'SURFACE') surfacingNumById.set(iv.id, ++n);
  }

  function focalCols(uuid) {
    const f = uuid ? focalByUuid.get(uuid) : null;
    return {
      focal_id: f && f.focal_id ? f.focal_id : '',
      whale_id: f && f.whale_id ? f.whale_id : '',
      focal_uuid: uuid || '',
    };
  }

  // Only focal records carry device_label, so build a lookup and stamp every
  // row from it — otherwise rows outside a follow export blank, which matters
  // once two iPads are merged into one file.
  const deviceLabelById = new Map();
  if (state.config) deviceLabelById.set(state.config.device_id, state.config.device_label);
  for (const f of focals) if (f.device_label) deviceLabelById.set(f.device_id, f.device_label);

  function surfacingCols(iv) {
    const n = iv ? surfacingNumById.get(iv.id) : undefined;
    if (!n) return { surfacing_num: '', surfacing_id: '' };
    const f = focalByUuid.get(uuidOf(iv));
    const label = f && f.focal_id ? f.focal_id : '';
    return { surfacing_num: n, surfacing_id: label ? `${label}-S${n}` : '' };
  }

  // A track point recorded between a focal's start and end belongs to that
  // follow. Same device only, and a device never runs two follows at once, so
  // the assignment is unambiguous. Focals with no end_ts (app closed mid-follow,
  // or a follow still open right now) are skipped rather than allowed to swallow
  // every later track point.
  const closedByDevice = new Map();
  for (const f of focals) {
    if (f.end_ts == null) continue;
    if (!closedByDevice.has(f.device_id)) closedByDevice.set(f.device_id, []);
    closedByDevice.get(f.device_id).push(f);
  }
  function focalAt(deviceId, ts) {
    for (const f of closedByDevice.get(deviceId) || []) {
      if (ts >= f.start_ts && ts <= f.end_ts) return f;
    }
    return null;
  }

  const rows = [];

  for (const f of focals) {
    rows.push({
      record_type: 'FOCAL',
      ts: f.start_ts,
      end_ts: f.end_ts == null ? '' : f.end_ts,
      duration_s: f.end_ts ? (f.end_ts - f.start_ts) / 1000 : '',
      // Falls back to the pre-v2 field name, so a row that missed the
      // migration still exports its activity rather than a blank.
      activity: f.activity || f.behavior || '',
      notes: f.notes || '',
      device_id: f.device_id,
      record_id: f.id,
      ...focalCols(f.id),
    });
  }

  for (const iv of intervals) {
    rows.push({
      record_type: 'INTERVAL',
      ts: iv.start_ts,
      end_ts: iv.end_ts == null ? '' : iv.end_ts,
      duration_s: iv.end_ts ? (iv.end_ts - iv.start_ts) / 1000 : '',
      interval_type: iv.type,
      quality: iv.quality || '',
      activity: iv.activity || iv.behavior || '',
      lat: iv.lat, lon: iv.lon,
      distance_m: iv.distance_m,
      bearing_to_whale: iv.bearing_to_whale,
      swim_direction: iv.swim_direction,
      device_id: iv.device_id,
      record_id: iv.id,
      interval_id: iv.id,
      ...focalCols(uuidOf(iv)),
      ...surfacingCols(iv),
    });
  }

  const behaviorFocal = (b, iv) => focalByUuid.get(b.focal_uuid || uuidOf(iv));

  for (const b of behaviors) {
    const iv = b.interval_id ? intervalById.get(b.interval_id) : null;
    rows.push({
      record_type: 'BEHAVIOR',
      ts: b.ts,
      lat: b.lat === undefined ? '' : b.lat,
      lon: b.lon === undefined ? '' : b.lon,
      // Rows migrated from the pre-v2 blows store have no behavior field.
      behavior: b.behavior || 'blow',
      secs_into_surfacing: iv ? (b.ts - iv.start_ts) / 1000 : '',
      interval_type: iv ? iv.type : '',
      // Interval first, then the focal, so a behaviour logged before any
      // interval was opened still carries the activity in force at the time.
      activity: (iv && (iv.activity || iv.behavior)) ||
                ((behaviorFocal(b, iv) && (behaviorFocal(b, iv).activity ||
                                           behaviorFocal(b, iv).behavior)) || ''),
      device_id: b.device_id,
      record_id: b.id,
      interval_id: b.interval_id || '',
      // Prefer the behaviour's own focal link; fall back to the interval's for
      // rows migrated from v1, which had no focal_uuid of their own.
      ...focalCols(b.focal_uuid || uuidOf(iv)),
      ...surfacingCols(iv),
    });
  }

  for (const e of events) {
    const iv = e.interval_id ? intervalById.get(e.interval_id) : null;
    rows.push({
      record_type: 'EVENT',
      ts: e.ts,
      lat: e.lat, lon: e.lon,
      tag_label: e.tag_label || '',
      notes: e.notes || '',
      device_id: e.device_id,
      record_id: e.id,
      interval_id: e.interval_id || '',
      ...focalCols(uuidOf(e)),
      ...surfacingCols(iv),
    });
  }

  for (const t of tracks) {
    const f = focalAt(t.device_id, t.ts);
    rows.push({
      record_type: 'TRACK',
      ts: t.ts,
      lat: t.lat, lon: t.lon,
      // Blank on points recorded before the source was tracked, rather than
      // guessed at: those predate the USB GPS entirely.
      gps_source: t.source || '',
      gps_time_utc: isoOrBlank(t.gps_time),
      trigger: t.trigger || '',
      device_id: t.device_id,
      record_id: t.id,
      ...focalCols(f ? f.id : ''),
    });
  }

  // Strict time order. The rank tiebreak keeps a focal ahead of the interval it
  // opens at the same millisecond, and the id keeps ties fully deterministic.
  const RANK = { FOCAL: 0, INTERVAL: 1, BEHAVIOR: 2, EVENT: 3, TRACK: 4 };
  rows.sort((a, b) =>
    a.ts - b.ts ||
    RANK[a.record_type] - RANK[b.record_type] ||
    String(a.record_id).localeCompare(String(b.record_id))
  );

  rows.forEach((r) => {
    r.time_utc = isoOrBlank(r.ts);
    r.end_time_utc = isoOrBlank(r.end_ts);
    r.device_label = deviceLabelById.get(r.device_id) || '';
  });

  rows.forEach((r, i) => { r.seq = i + 1; });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const name = `survey_log_${state.config.device_label}_${stamp}.csv`;

  downloadCSV(name, toCSV(rows, ALL_COLUMNS));
  // Still an array: one file today, and the callers already render a list. Also
  // means adding a second output later does not ripple back through the UI.
  return { files: [{ name, rows: rows.length }], rows: rows.length };
}

const App = {
  state,
  startPositionWatch,
  maybeLogTrackPoint,
  forceTrackPoint,
  logEvent,
  startFocal,
  setActivity,
  setWhaleId,
  setFocalId,
  focalIdCollision,
  switchInterval,
  updateCurrentInterval,
  logBehavior,
  countBlows,
  endFocal,
  loadTags,
  addTag,
  deactivateTag,
  exportAll,
  importFile,
  surveyCounts,
  clearSurveyData,
  exportCSV,
  BEHAVIORS,
};
