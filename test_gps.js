// Harness for gps.js NMEA parsing. Run: node test_gps.js
const { GPS } = require('./gps.js');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '   got: ' + JSON.stringify(got)); }
}
function near(a, b, tol) { return a !== null && Math.abs(a - b) < tol; }

// --- checksum, against canonical published sentences (independent of my code) ---
const WIKI_RMC = '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A';
const WIKI_GGA = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47';
ok('checksum accepts canonical RMC *6A', GPS.checksumOk(WIKI_RMC));
ok('checksum accepts canonical GGA *47', GPS.checksumOk(WIKI_GGA));
ok('checksum rejects a flipped digit', !GPS.checksumOk(WIKI_RMC.replace('4807', '4806')));

// --- canonical coordinate values ---
// 4807.038 N = 48 + 7.038/60 = 48.1173 ; 01131.000 E = 11 + 31/60 = 11.516667
const r = GPS.parseSentence(WIKI_RMC);
ok('RMC lat 48.1173', near(r && r.lat, 48.1173, 1e-6), r && r.lat);
ok('RMC lon 11.516667', near(r && r.lon, 11 + 31 / 60, 1e-9), r && r.lon);
// NMEA years are two digits. The canonical sentence is from 1994, but a
// receiver in the field emits '26' for 2026, so 20xx is the only useful
// reading. Asserting the documented behaviour, not the sentence's origin.
ok('RMC date/time parsed, year taken as 20xx',
   r && new Date(r.gps_time).toISOString() === '2094-03-23T12:35:19.000Z',
   r && new Date(r.gps_time).toISOString());
const today = GPS.parseSentence(csum('$GNRMC,180530.00,A,5937.7292,N,15136.8333,W,0,0,090926,,,A'));
ok('RMC 090926 -> 2026-09-09T18:05:30Z',
   today && new Date(today.gps_time).toISOString() === '2026-09-09T18:05:30.000Z',
   today && new Date(today.gps_time).toISOString());
ok('RMC with impossible month rejected',
   GPS.rmcTimestamp('123519', '231394') === null, GPS.rmcTimestamp('123519', '231394'));
const g = GPS.parseSentence(WIKI_GGA);
ok('GGA lat matches RMC', near(g && g.lat, 48.1173, 1e-6), g && g.lat);
ok('GGA lon matches RMC', near(g && g.lon, 11 + 31 / 60, 1e-9), g && g.lon);
ok('GGA gps_time is null (GGA has no date)', g && g.gps_time === null, g && g.gps_time);

// --- Cook Inlet round trip, against a real SeaLog row: 59.62882, -151.6138883 ---
function csum(body) {           // body includes leading '$', no '*'
  let s = 0;
  for (let i = 1; i < body.length; i++) s ^= body.charCodeAt(i);
  return body + '*' + s.toString(16).toUpperCase().padStart(2, '0');
}
function toNmea(deg, isLat) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  return String(d).padStart(isLat ? 2 : 3, '0') + m.toFixed(4).padStart(7, '0');
}
const CI_LAT = 59.62882, CI_LON = -151.6138883;
const ci = csum(`$GNRMC,152706.00,A,${toNmea(CI_LAT, true)},N,${toNmea(CI_LON, false)},W,3.2,178.0,170721,,,A`);
const c = GPS.parseSentence(ci);
ok('Cook Inlet lat round trip', near(c && c.lat, CI_LAT, 1e-6), c && c.lat);
ok('Cook Inlet lon round trip (negative, W)', near(c && c.lon, CI_LON, 1e-6), c && c.lon);
ok('Cook Inlet lon is west of 151', c && c.lon < -151 && c.lon > -152, c && c.lon);
ok('$GN talker ID accepted', c !== null, c);
ok('3-digit longitude degrees parsed as 151 not 15',
   c && Math.floor(Math.abs(c.lon)) === 151, c && c.lon);

// --- rejections ---
ok('RMC with status V rejected', GPS.parseSentence(csum('$GPRMC,123519,V,4807.038,N,01131.000,E,0,0,230394,,')) === null);
ok('GGA with fix quality 0 rejected', GPS.parseSentence(csum('$GPGGA,123519,4807.038,N,01131.000,E,0,00,,,M,,M,,')) === null);
ok('GSV ignored', GPS.parseSentence(csum('$GPGSV,3,1,11,03,03,111,00')) === null);
ok('truncated RMC rejected', GPS.parseSentence('$GPRMC,123519,A,4807.038,N') === null);
ok('empty line rejected', GPS.parseSentence('') === null);
ok('garbage rejected', GPS.parseSentence('hello world') === null);
ok('bad checksum rejected', GPS.parseSentence(WIKI_RMC.slice(0, -2) + 'FF') === null);
ok('minutes >= 60 rejected', GPS.nmeaToDecimal('4861.000', 'N') === null, GPS.nmeaToDecimal('4861.000', 'N'));
ok('bad hemisphere rejected', GPS.nmeaToDecimal('4807.038', 'X') === null);
ok('empty lat field rejected', GPS.nmeaToDecimal('', 'N') === null);

// --- southern / eastern hemispheres ---
ok('S hemisphere negative', near(GPS.nmeaToDecimal('3352.000', 'S'), -(33 + 52 / 60), 1e-9));
ok('E hemisphere positive', near(GPS.nmeaToDecimal('15112.000', 'E'), 151 + 12 / 60, 1e-9));

// --- line buffer: sentences split across chunks, CRLF, leading noise ---
const lines = [];
const feed = GPS.makeLineBuffer((l) => lines.push(l));
feed('$GPRMC,123519,A,4807.0');
feed('38,N,01131.000,E,022.4,084.4,230394,003.1,W*6A\r\n$GPGGA,1');
feed('23519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n');
ok('line buffer reassembled 2 sentences', lines.length === 2, lines.length);
ok('reassembled RMC parses', GPS.parseSentence(lines[0]) !== null, lines[0]);
ok('CRLF stripped by parser', near(GPS.parseSentence(lines[1]).lat, 48.1173, 1e-6));

// buffer must not grow without bound on a stream with no newlines (wrong baud)
const noise = GPS.makeLineBuffer(() => { throw new Error('should not emit'); });
for (let i = 0; i < 50; i++) noise('x'.repeat(200));
ok('no-newline stream does not emit or throw', true);


// --- end-to-end: sentences in, fixes out through the module's own callbacks ---
const fixes = [], msgs = [];
GPS.init({ onFix: (f) => fixes.push(f), onStatus: (m) => msgs.push(m) });
const pipe = GPS.makeLineBuffer(GPS._handleLine);

pipe(ci + '\r\n');
ok('e2e: RMC produced one fix', fixes.length === 1, fixes.length);
ok('e2e: fix carries source=serial', fixes[0] && fixes[0].source === 'serial', fixes[0]);
ok('e2e: fix carries gps_time', fixes[0] && typeof fixes[0].gps_time === 'number', fixes[0]);
ok('e2e: ts is device clock, not GPS clock',
   fixes[0] && Math.abs(fixes[0].ts - Date.now()) < 5000, fixes[0] && fixes[0].ts);
ok('e2e: lon still negative through the pipeline',
   near(fixes[0] && fixes[0].lon, CI_LON, 1e-6), fixes[0] && fixes[0].lon);

// A receiver sending both must not double-log: GGA right after RMC is dropped.
pipe(WIKI_GGA + '\r\n');
ok('e2e: GGA suppressed while RMC is live', fixes.length === 1, fixes.length);

// Noise between sentences must not break reassembly of the next one.
pipe(csum('$GPGSV,3,1,11,03,03,111,00') + '\r\n' + 'garbage\r\n' + ci + '\r\n');
ok('e2e: parses a valid RMC after noise', fixes.length === 2, fixes.length);

// --- the COM port is held by another program ---
// A Windows COM port is exclusive: one process at a time. If a chart plotter or
// another tab already has the receiver, open() rejects and there is nothing to
// retry. connectSerial must say so once, not disappear into the reconnect loop.
function stubSerial(openImpl, portCount) {
  const port = { open: openImpl, close: async () => {}, getInfo: () => ({}), readable: null };
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      serial: {
        getPorts: async () => new Array(portCount === undefined ? 1 : portCount).fill(port),
        requestPort: async () => port,
      },
    },
    configurable: true, writable: true,
  });
  return port;
}

(async () => {
  const notes = [];
  GPS.init({ onFix() {}, onStatus: (m) => notes.push(m) });

  const busy = new Error('Failed to open serial port.');
  stubSerial(async () => { throw busy; });
  const connected = await GPS.connectSerial();

  ok('busy port: connectSerial reports failure', connected === false, connected);
  ok('busy port: source is not left as serial', GPS.activeSource() !== 'serial', GPS.activeSource());
  ok('busy port: message names the real cause',
     notes.some((m) => /only be held by one program/.test(m)), notes);
  ok('busy port: message includes the browser error',
     notes.some((m) => m.includes('Failed to open serial port.')), notes);

  // Must be past RECONNECT_DELAY_MS (3 s), or a retry loop would not have had
  // time to fire and this assertion would pass vacuously.
  const before = notes.length;
  await new Promise((r) => setTimeout(r, 3500));
  ok('busy port: stopped retrying rather than looping', notes.length === before,
     notes.slice(before));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
