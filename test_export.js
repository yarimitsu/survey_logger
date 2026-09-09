// Harness for the CSV export split. Run: node test_export.js
//
// app.js is a browser script that talks to IndexedDB and the DOM, so it is
// evaluated here against stubs: an in-memory DB, no-op map drawing, and a
// downloadCSV that captures the file text instead of hitting the disk.

const vm = require('vm');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '   got: ' + JSON.stringify(got)); }
}

const stores = {
  meta: [], tags: [], events: [], track_points: [], focals: [], focal_intervals: [],
  behaviors: [], blows: [],
};
let n = 0;
const DB = {
  uuid: () => 'u' + (++n),
  put: async (s, r) => {
    const i = stores[s].findIndex((x) => x.id === r.id);
    if (i === -1) stores[s].push(r); else stores[s][i] = r;
    return r;
  },
  getAll: async (s) => stores[s].slice(),
  get: async (s, id) => stores[s].find((x) => x.id === id),
  clearStore: async (s) => { stores[s].length = 0; },
  count: async (s) => stores[s].length,
  getConfig: async () => null,
  setConfig: async () => ({}),
  ensureDefaultTags: async () => {},
};

const saved = [];   // { name, text }
const ctx = {
  DB, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  GPS: { init() {}, startDeviceWatch() {}, activeSource: () => 'serial' },
  setStatus() {}, updatePositionUI() {}, updateGpsUI() {},
  drawTrackPoint() {}, drawEventMarker() {},
  navigator: {}, document: {}, window: {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);

let src = fs.readFileSync('app.js', 'utf8');
// downloadCSV touches Blob/URL/<a>; replace it with a capture.
src = src.replace(
  /function downloadCSV\(name, text\) \{[\s\S]*?\n\}/,
  'function downloadCSV(name, text) { __saved.push({ name, text }); }'
);
ctx.__saved = saved;
src += '\n;globalThis.__App = App;';
vm.runInContext(src, ctx);
const App = ctx.__App;

// ---------- build a survey ----------
App.state.config = { device_id: 'dev1', device_label: 'Laptop' };
App.state.trackOn = true;

const T0 = Date.UTC(2026, 8, 9, 18, 0, 0);
let clock = T0;
ctx.Date = class extends Date {
  constructor(...a) { super(...(a.length ? a : [clock])); }
  static now() { return clock; }
};

async function build() {
  App.state.lastPosition = { lat: 60.6, lon: -147.0, ts: clock, source: 'serial', gps_time: clock - 500 };

  // two cadence track points
  await App.maybeLogTrackPoint({ ...App.state.lastPosition, ts: clock });
  clock += 10000;
  await App.maybeLogTrackPoint({ lat: 60.61, lon: -147.01, ts: clock, source: 'serial', gps_time: clock });

  // an event tag (forces a track point)
  clock += 3000;
  App.state.lastPosition = { lat: 60.62, lon: -147.02, ts: clock, source: 'serial', gps_time: clock };
  await App.logEvent('t1', 'CTD', 'cast 1');

  // a focal follow: start, surface, two blows, dive, end
  clock += 5000;
  const focal = await App.startFocal();
  await App.setWhaleId('PWS-014');
  clock += 1000;
  await App.switchInterval('SURFACE');
  clock += 2000;
  await App.logBehavior('blow');
  clock += 2000;
  await App.logBehavior('blow');
  clock += 1000;
  await App.logBehavior('breach');
  clock += 1000;
  await App.logBehavior('fluke up');
  clock += 4000;
  await App.switchInterval('DIVE');
  // A behaviour seen mid-dive must still be recorded, not dropped.
  clock += 5000;
  await App.logBehavior('slap');
  clock += 60000;
  await App.endFocal();
  return focal;
}

function parse(text) {
  const lines = text.trim().split('\n');
  const cols = lines[0].split(',');
  return { cols, rows: lines.slice(1).map((l) => {
    // fields here contain no embedded commas except quoted notes; good enough
    const v = l.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
    return Object.fromEntries(cols.map((c, i) => [c, (v[i] || '').replace(/^"|"$/g, '')]));
  }) };
}

build().then(async () => {
  const res = await App.exportCSV();

  ok('two files written', saved.length === 2, saved.map((f) => f.name));
  ok('survey log filename', /^survey_log_Laptop_\d{8}-\d{4}\.csv$/.test(saved[0].name), saved[0].name);
  ok('focal filename', /^focal_follows_Laptop_\d{8}-\d{4}\.csv$/.test(saved[1].name), saved[1].name);

  const survey = parse(saved[0].text);
  const focal = parse(saved[1].text);
  const types = (p) => [...new Set(p.rows.map((r) => r.record_type))].sort();

  ok('survey log holds only EVENT and TRACK',
     JSON.stringify(types(survey)) === '["EVENT","TRACK"]', types(survey));
  ok('focal file holds only BEHAVIOR, FOCAL, INTERVAL',
     JSON.stringify(types(focal)) === '["BEHAVIOR","FOCAL","INTERVAL"]', types(focal));

  // nothing lost in the split
  const total = survey.rows.length + focal.rows.length;
  ok('every row landed in exactly one file', total === res.rows, [total, res.rows]);

  // the join between the two files
  ok('survey log keeps focal_id', survey.cols.includes('focal_id'));
  ok('survey log keeps focal_uuid', survey.cols.includes('focal_uuid'));
  const trackInFocal = survey.rows.filter((r) => r.record_type === 'TRACK' && r.focal_id);
  ok('track points inside the follow carry its focal_id',
     trackInFocal.length > 0 && trackInFocal.every((r) => r.focal_id === 'FocalA'),
     trackInFocal.map((r) => r.focal_id));

  // forced points
  const forced = survey.rows.filter((r) => r.trigger === 'event');
  const cadence = survey.rows.filter((r) => r.trigger === 'cadence');
  ok('forced track points recorded', forced.length >= 5, forced.length);
  ok('cadence track points recorded', cadence.length === 2, cadence.length);
  ok('an event forced a point at the event timestamp',
     forced.some((r) => survey.rows.some((e) => e.record_type === 'EVENT' && e.ts === r.ts)),
     forced.map((r) => r.ts));

  // cadence floor still holds between forced writes
  ok('no two cadence points closer than 10 s',
     cadence.every((r, i) => i === 0 || Number(r.ts) - Number(cadence[i - 1].ts) >= 10000),
     cadence.map((r) => r.ts));

  // column hygiene
  ok('survey log has no surfacing_num', !survey.cols.includes('surfacing_num'));
  ok('focal file has no tag_label', !focal.cols.includes('tag_label'));
  ok('survey log carries gps_source/gps_time_utc',
     survey.cols.includes('gps_source') && survey.cols.includes('gps_time_utc'));
  ok('gps_source populated on track rows',
     survey.rows.filter((r) => r.record_type === 'TRACK').every((r) => r.gps_source === 'serial'));

  // seq is per file and complete
  ok('survey seq is 1..n', survey.rows.every((r, i) => Number(r.seq) === i + 1));
  ok('focal seq is 1..n', focal.rows.every((r, i) => Number(r.seq) === i + 1));

  // time order within each file
  const ordered = (p) => p.rows.every((r, i) => i === 0 || Number(r.ts) >= Number(p.rows[i - 1].ts));
  ok('survey log in time order', ordered(survey));
  ok('focal file in time order', ordered(focal));

  // whale id assigned mid-follow reaches every focal row
  ok('whale_id joined onto all focal rows',
     focal.rows.every((r) => r.whale_id === 'PWS-014'),
     [...new Set(focal.rows.map((r) => r.whale_id))]);

  // surfacing numbering survives the split
  const surfacings = focal.rows.filter((r) => r.record_type === 'INTERVAL' && r.interval_type === 'SURFACE');
  ok('surfacing_num derived', surfacings.every((r) => Number(r.surfacing_num) >= 1), surfacings.map((r) => r.surfacing_num));

  // ---------- timestamped behaviours ----------
  const beh = focal.rows.filter((r) => r.record_type === 'BEHAVIOR');
  ok('every behaviour exported', beh.length === 5, beh.length);
  ok('behaviour values round trip',
     JSON.stringify(beh.map((r) => r.behavior)) ===
       JSON.stringify(['blow', 'blow', 'breach', 'fluke up', 'slap']),
     beh.map((r) => r.behavior));
  ok('behaviour names with a space survive the CSV',
     beh.some((r) => r.behavior === 'fluke up'), beh.map((r) => r.behavior));
  ok('every behaviour has its own timestamp',
     new Set(beh.map((r) => r.ts)).size === beh.length, beh.map((r) => r.ts));
  ok('behaviours are in time order',
     beh.every((r, i) => i === 0 || Number(r.ts) > Number(beh[i - 1].ts)), beh.map((r) => r.ts));

  const blows = beh.filter((r) => r.behavior === 'blow');
  ok('blows carry surfacing_id', blows.every((r) => r.surfacing_id === 'FocalA-S1'),
     blows.map((r) => r.surfacing_id));
  // The whole point of allowing a behaviour outside a surfacing.
  const slap = beh.find((r) => r.behavior === 'slap');
  ok('a behaviour logged during a dive is kept', slap !== undefined);
  ok('a dive behaviour records the DIVE interval', slap && slap.interval_type === 'DIVE',
     slap && slap.interval_type);

  // activity (the sticky state) and behavior (the event) are separate columns
  ok('focal file has an activity column', focal.cols.includes('activity'));
  ok('focal file has a behavior column', focal.cols.includes('behavior'));
  ok('activity and behavior are different columns',
     focal.cols.indexOf('activity') !== focal.cols.indexOf('behavior'));
  ok('FOCAL rows carry activity, not behavior',
     focal.rows.filter((r) => r.record_type === 'FOCAL').every((r) => r.behavior === ''),
     focal.rows.filter((r) => r.record_type === 'FOCAL').map((r) => r.behavior));

  // every behaviour also forced a track point at its own timestamp
  const behTs = new Set(beh.map((r) => r.ts));
  const forcedAtBehaviour = survey.rows.filter(
    (r) => r.record_type === 'TRACK' && r.trigger === 'event' && behTs.has(r.ts));
  ok('every behaviour forced a track point at its timestamp',
     forcedAtBehaviour.length === beh.length, [forcedAtBehaviour.length, beh.length]);

  // ---------- a survey day with no focal follows ----------
  // The likely first day out, and the clear-data dialog exports on an empty
  // database too. Both files must still be written, with headers, or the
  // missing one reads as "the export failed" rather than "nothing to report".
  for (const k of ['focals', 'focal_intervals', 'behaviors']) stores[k].length = 0;
  saved.length = 0;
  const noFocal = await App.exportCSV();
  ok('no follows: still two files', saved.length === 2, saved.map((f) => f.name));
  const nf = parse(saved[1].text);
  ok('no follows: focal file has a header row',
     saved[1].text.trim().split('\n')[0].startsWith('seq,record_type'),
     saved[1].text.slice(0, 40));
  ok('no follows: focal file has zero data rows', nf.rows.length === 0, nf.rows.length);
  ok('no follows: survey log still populated',
     parse(saved[0].text).rows.length === noFocal.rows, noFocal.rows);

  // ---------- a completely empty database ----------
  for (const k of Object.keys(stores)) stores[k].length = 0;
  saved.length = 0;
  const empty = await App.exportCSV();
  ok('empty db: still two files', saved.length === 2, saved.map((f) => f.name));
  ok('empty db: both files are header-only',
     saved.every((f) => f.text.trim().split('\n').length === 1),
     saved.map((f) => f.text.trim().split('\n').length));
  ok('empty db: reports zero rows',
     empty.rows === 0 && empty.files.every((f) => f.rows === 0),
     [empty.rows, empty.files.map((f) => f.rows)]);

  // ---------- importing a pre-v2 export ----------
  // Files exported before the blow button became a behaviour set carry a
  // 'blows' array and no 'behaviors'. Those rows are all blows by definition.
  // This is the same rule the IndexedDB v1->v2 upgrade applies, exercised here
  // against the real importFile rather than a mock of the upgrade transaction.
  for (const k of Object.keys(stores)) stores[k].length = 0;
  const legacy = {
    tags: [], events: [], track_points: [], focal_intervals: [],
    focals: [{ id: 'dev9_f1', device_id: 'dev9', device_label: 'iPad-1',
               focal_id: 'FocalA', whale_id: 'OLD-1', start_ts: 1, end_ts: 2 }],
    blows: [
      { id: 'dev9_b1', device_id: 'dev9', interval_id: 'dev9_i1', ts: 10 },
      { id: 'dev9_b2', device_id: 'dev9', interval_id: 'dev9_i1', ts: 20 },
    ],
  };
  const imported = await App.importFile({ text: async () => JSON.stringify(legacy) });

  ok('legacy import: counted every row', imported === 3, imported);
  ok('legacy import: blows landed in behaviors', stores.behaviors.length === 2,
     stores.behaviors.length);
  ok('legacy import: each is labelled blow',
     stores.behaviors.every((b) => b.behavior === 'blow'),
     stores.behaviors.map((b) => b.behavior));
  ok('legacy import: ids preserved, so a re-import cannot duplicate',
     stores.behaviors.map((b) => b.id).join(',') === 'dev9_b1,dev9_b2',
     stores.behaviors.map((b) => b.id));

  saved.length = 0;
  await App.exportCSV();
  const relegacy = parse(saved[1].text).rows.filter((r) => r.record_type === 'BEHAVIOR');
  ok('legacy import: exports as BEHAVIOR rows', relegacy.length === 2, relegacy.length);
  ok('legacy import: behavior column reads blow',
     relegacy.every((r) => r.behavior === 'blow'), relegacy.map((r) => r.behavior));

  // re-importing the same file must not double up
  await App.importFile({ text: async () => JSON.stringify(legacy) });
  ok('legacy import: re-import is idempotent', stores.behaviors.length === 2,
     stores.behaviors.length);

  // ---------- the behavior -> activity rename on pre-v2 rows ----------
  // Focals and intervals recorded before 2026-09-09 call the sticky
  // transit/foraging state `behavior`. Nothing reads that name any more, so
  // without both a migration and a read-side fallback they export a blank
  // activity column with no error at all.
  for (const k of Object.keys(stores)) stores[k].length = 0;
  const preV2 = {
    focals: [{ id: 'dev8_f1', device_id: 'dev8', device_label: 'iPad-2',
               focal_id: 'FocalQ', whale_id: 'OLD-9',
               start_ts: 100, end_ts: 900, behavior: 'foraging' }],
    focal_intervals: [{ id: 'dev8_i1', device_id: 'dev8', focal_uuid: 'dev8_f1',
                        type: 'SURFACE', start_ts: 100, end_ts: 400,
                        behavior: 'foraging', quality: 'good' }],
    blows: [{ id: 'dev8_b1', device_id: 'dev8', interval_id: 'dev8_i1', ts: 150 }],
  };
  await App.importFile({ text: async () => JSON.stringify(preV2) });

  ok('rename: import moved focal behavior -> activity',
     stores.focals[0].activity === 'foraging', stores.focals[0]);
  ok('rename: import moved interval behavior -> activity',
     stores.focal_intervals[0].activity === 'foraging', stores.focal_intervals[0]);

  saved.length = 0;
  await App.exportCSV();
  const rn = parse(saved[1].text);
  const byType = (t) => rn.rows.filter((r) => r.record_type === t);
  ok('rename: FOCAL row exports its activity',
     byType('FOCAL').every((r) => r.activity === 'foraging'),
     byType('FOCAL').map((r) => r.activity));
  ok('rename: INTERVAL row exports its activity',
     byType('INTERVAL').every((r) => r.activity === 'foraging'),
     byType('INTERVAL').map((r) => r.activity));
  ok('rename: migrated blow exports as a BEHAVIOR row carrying activity',
     byType('BEHAVIOR').every((r) => r.behavior === 'blow' && r.activity === 'foraging'),
     byType('BEHAVIOR').map((r) => [r.behavior, r.activity]));

  // The read-side fallback must hold even for a row the migration never touched.
  stores.focals[0] = { ...stores.focals[0] };
  delete stores.focals[0].activity;
  stores.focals[0].behavior = 'transit';
  saved.length = 0;
  await App.exportCSV();
  ok('rename: unmigrated row still exports activity via the fallback',
     parse(saved[1].text).rows.filter((r) => r.record_type === 'FOCAL')
       .every((r) => r.activity === 'transit'),
     parse(saved[1].text).rows.filter((r) => r.record_type === 'FOCAL').map((r) => r.activity));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
