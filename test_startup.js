// Harness for app startup. Run: node test_startup.js
//
// main.js does its whole startup inside one async init(), and a rejection
// anywhere in it is caught by a single handler at the bottom that writes a
// status message and stops. Everything after the failure point is skipped -
// including wireControls(), which attaches EVERY button handler. So one broken
// await during startup makes the entire UI silently inert: the page renders,
// nothing responds, and the only clue is one line of status text.
//
// This loads gps.js, app.js, ui.js and main.js into one context against stubs,
// runs startup, and asserts that the buttons actually got wired.

const vm = require('vm');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (got === undefined ? '' : '   got: ' + JSON.stringify(got))); }
}

// ---------- stubs ----------

const wired = {};          // selector -> [event names]
const elements = {};
let created = 0;

function fakeEl(sel) {
  if (elements[sel]) return elements[sel];
  const e = {
    _sel: sel,
    textContent: '', value: '', title: '', disabled: false, innerHTML: '',
    dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _children: [], _events: [],
    addEventListener(ev) { this._events.push(ev); (wired[sel] = wired[sel] || []).push(ev); },
    appendChild(c) { this._children.push(c); },
    focus() {}, click() {}, querySelector: () => fakeEl(sel + ' *'),
    setAttribute() {}, getBoundingClientRect: () => ({ width: 800, height: 600 }),
  };
  elements[sel] = e;
  return e;
}

const leafletLayer = () => ({
  addTo() { return this; }, setLatLng() { return this; }, addLatLng() { return this; },
  bindPopup() { return this; }, getBounds: () => ({}), remove() {},
});

const L = {
  map: () => ({
    setView() { return this; }, addLayer() {}, removeLayer() {},
    fitBounds() {}, on() {}, invalidateSize() {},
  }),
  tileLayer: Object.assign(() => leafletLayer(), { wms: () => leafletLayer() }),
  polyline: () => leafletLayer(),
  circleMarker: () => leafletLayer(),
  control: { layers: () => ({ addTo() {} }) },
};

const stores = {
  meta: [], tags: [], events: [], track_points: [], focals: [], focal_intervals: [],
  behaviors: [], blows: [],
};
const DB = {
  uuid: () => 'u' + Math.random().toString(36).slice(2),
  openDB: async () => {},
  ensureDefaultTags: async () => {},
  put: async (s, r) => { stores[s].push(r); return r; },
  getAll: async (s) => stores[s].slice(),
  get: async (s, id) => stores[s].find((x) => x.id === id),
  clearStore: async (s) => { stores[s].length = 0; },
  count: async (s) => stores[s].length,
  // A configured device, so startup does not block on the first-run modal.
  getConfig: async () => ({ id: 'config', device_id: 'dev1', device_label: 'Laptop' }),
  setConfig: async (p) => p,
};

// The scenario that matters: a manifest is present (the fetcher has been run).
const manifest = {
  layers: {
    noaa: {
      title: 'NOAA ENC chart', attribution: 'NOAA ENC',
      minzoom: 8, maxzoom: 13, tiles: 680, complete: false,
      bbox: [59.3, -149.2, 61.45, -145.2],
    },
  },
};

function makeContext({ withManifest = true, withSerial = true } = {}) {
  Object.keys(wired).forEach((k) => delete wired[k]);
  const ctx = {
    console, L, DB,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      querySelector: fakeEl,
      querySelectorAll: () => [],
      createElement: () => fakeEl('created-' + (created++)),
      addEventListener() {},
    },
    window: { addEventListener() {} },
    location: { hostname: 'localhost', reload() {} },
    navigator: {
      geolocation: { watchPosition: () => 1, clearWatch() {} },
      storage: { persisted: async () => true, persist: async () => true },
      ...(withSerial ? { serial: { getPorts: async () => [], requestPort: async () => ({}) } } : {}),
    },
    fetch: async (url) => (withManifest && String(url).includes('manifest.json')
      ? { ok: true, json: async () => manifest }
      : { ok: false, json: async () => ({}) }),
    crypto: { randomUUID: () => 'uuid' },
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  return vm.createContext(ctx);
}

async function startup(opts) {
  const ctx = makeContext(opts);
  const errors = [];
  ctx.console = { ...console, error: (...a) => errors.push(a.join(' ')) };
  for (const f of ['gps.js', 'app.js', 'ui.js', 'main.js']) {
    let src = fs.readFileSync(f, 'utf8');
    // top-level const does not land on the context object, so publish the
    // namespaces the assertions need to inspect
    if (f === 'app.js') src += ';globalThis.__App = App;';
    if (f === 'gps.js') src += ';globalThis.__GPS = GPS;';
    vm.runInContext(src, ctx, { filename: f });
  }
  // init() is async and started at the bottom of main.js; let it settle.
  await new Promise((r) => setTimeout(r, 60));
  return { ctx, errors };
}

(async () => {
  const { ctx, errors } = await startup();

  ok('startup raised no errors', errors.length === 0, errors);
  ok('status line is not a startup error',
     !String(fakeEl('#status-line').textContent).startsWith('Startup error'),
     fakeEl('#status-line').textContent);

  // The actual regression: does anything get wired at all?
  ok('Connect GPS button was wired', (wired['#gps-btn'] || []).includes('click'), wired['#gps-btn']);
  ok('track toggle was wired', (wired['#track-toggle'] || []).includes('click'));
  ok('focal button was wired', (wired['#focal-btn'] || []).includes('click'));
  ok('export CSV button was wired', (wired['#export-csv-btn'] || []).includes('click'));
  ok('clear data button was wired', (wired['#clear-data-btn'] || []).includes('click'));

  // The behaviour grid is built in JS from App.BEHAVIORS, so unlike every other
  // control it can be missing without index.html changing.
  const grid = fakeEl('#behavior-grid');
  ok('behaviour grid was rendered', grid._children.length === 7, grid._children.length);
  ok('behaviour grid matches App.BEHAVIORS',
     JSON.stringify(grid._children.map((c) => c.dataset.behavior)) ===
       JSON.stringify(ctx.__App.BEHAVIORS),
     grid._children.map((c) => c.dataset.behavior));
  ok('every behaviour button is clickable',
     grid._children.every((c) => (c._events || []).includes('click')));
  ok('blow is the primary button',
     grid._children[0].className.includes('primary'), grid._children[0].className);

  ok('map was created', ctx.__App.state.map !== null);
  ok('offline manifest was read', ctx.__App.state.tileManifest !== null);

  // Same again with no cached tiles and no Web Serial (the iPad shape).
  const bare = await startup({ withManifest: false, withSerial: false });
  ok('no manifest: startup still raised no errors', bare.errors.length === 0, bare.errors);
  ok('no manifest: Connect GPS button still wired',
     (wired['#gps-btn'] || []).includes('click'), wired['#gps-btn']);
  ok('no manifest: map still created', bare.ctx.__App.state.map !== null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
