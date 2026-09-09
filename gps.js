// gps.js — position sources. No DB writes and no DOM here; this module only
// produces fixes and status strings, and hands them to callbacks.
//
// Two sources, one shape: { lat, lon, ts, source, gps_time }
//
//   'device' — navigator.geolocation.watchPosition. This is the iPad path, and
//              the only path on Safari. On a Windows laptop it is close to
//              useless offline: Windows positions from wifi and cell, not from
//              satellites, so with no internet it returns nothing or a fix that
//              is tens of kilometres out.
//
//   'serial' — a USB NMEA receiver read straight off the COM port by the page,
//              via the Web Serial API. Needs Chrome or Edge on desktop and a
//              secure context; http://localhost qualifies, http://<LAN-IP>
//              does not. No bridge process, no driver beyond the one the USB
//              puck already installs, and no internet at any point.
//
// Only one source is live at a time. Connecting serial stops the geolocation
// watch: interleaving two independent position streams into one track store
// produces a line that zigzags between them, and there is no way to
// disentangle it afterwards.

const SERIAL_BAUD = 4800;          // standard NMEA 0183 rate; the COM3 puck's rate
const FIX_STALE_MS = 15000;        // no sentence for this long = warn, feed is dead
const RECONNECT_DELAY_MS = 3000;   // between auto-reconnect attempts after a drop
const FIX_DEAD_MS = 30000;         // silent this long = force the port back open
// A receiver emitting both RMC and GGA would otherwise deliver two fixes per
// second. RMC is preferred because it is the only sentence carrying a date, so
// GGA is used only when RMC has gone quiet for longer than this — which is the
// GGA-only receiver case.
const RMC_PREFERENCE_MS = 5000;

// ---------- NMEA parsing ----------

// XOR of every character between '$' and '*'. A sentence with no checksum is
// accepted (a few cheap receivers omit it) but one with a checksum that does
// not match is dropped: at 4800 baud over USB, a corrupted sentence is a real
// event, and a corrupted longitude puts the track in the wrong ocean.
function checksumOk(sentence) {
  const star = sentence.lastIndexOf('*');
  if (star === -1) return true;
  const stated = sentence.slice(star + 1, star + 3).toUpperCase();
  if (stated.length < 2) return false;
  let sum = 0;
  for (let i = 1; i < star; i++) sum ^= sentence.charCodeAt(i);
  return sum.toString(16).toUpperCase().padStart(2, '0') === stated;
}

// NMEA packs latitude as ddmm.mmmm and longitude as dddmm.mmmm — the number of
// degree digits differs, so the split is found from the decimal point (always
// two digits of minutes before it) rather than from a fixed offset. The sign
// comes from a separate hemisphere field; at Cook Inlet's -151 deg, dropping it
// puts the track in Kazakhstan.
function nmeaToDecimal(raw, hemi) {
  if (!raw || !hemi) return null;
  const dot = raw.indexOf('.');
  const split = (dot === -1 ? raw.length : dot) - 2;
  if (split < 1) return null;
  const deg = Number(raw.slice(0, split));
  const min = Number(raw.slice(split));
  if (!Number.isFinite(deg) || !Number.isFinite(min) || min >= 60) return null;
  const dec = deg + min / 60;
  const h = hemi.toUpperCase();
  if (h === 'S' || h === 'W') return -dec;
  if (h === 'N' || h === 'E') return dec;
  return null;
}

// RMC carries date as ddmmyy and time as hhmmss.sss, both UTC. Returned as ms
// since epoch so it can sit beside the app's own Date.now() timestamps.
// Two-digit years are 20xx; NMEA has no way to say otherwise.
function rmcTimestamp(timeField, dateField) {
  if (!timeField || !dateField || timeField.length < 6 || dateField.length < 6) return null;
  const hh = Number(timeField.slice(0, 2));
  const mm = Number(timeField.slice(2, 4));
  const ss = Number(timeField.slice(4, 6));
  const frac = timeField.indexOf('.') === -1 ? 0 : Number(timeField.slice(timeField.indexOf('.')));
  const dd = Number(dateField.slice(0, 2));
  const mo = Number(dateField.slice(2, 4));
  const yy = Number(dateField.slice(4, 6));
  const parts = [hh, mm, ss, dd, mo, yy];
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mm > 59 || ss > 60) return null;
  return Date.UTC(2000 + yy, mo - 1, dd, hh, mm, ss, Math.round((frac || 0) * 1000));
}

// Returns { type, lat, lon, gps_time } or null. `type` is 'RMC' or 'GGA'.
//
// The talker ID is the two characters after '$' and varies by constellation:
// GP is GPS-only, GN is a multi-constellation fix, and GL/GA/GB/BD/QZ appear on
// some receivers. Most modern USB pucks emit GN, not GP, so matching on the
// literal '$GPRMC' is the likeliest reason a working receiver logs nothing.
// The last three characters are the sentence type regardless of talker.
function parseSentence(line) {
  const s = (line || '').trim();
  if (s.length < 7 || s[0] !== '$') return null;
  if (!checksumOk(s)) return null;

  const star = s.lastIndexOf('*');
  const body = star === -1 ? s : s.slice(0, star);
  const f = body.split(',');
  const type = f[0].slice(-3).toUpperCase();

  if (type === 'RMC') {
    // f: 0 id, 1 time, 2 status A/V, 3 lat, 4 N/S, 5 lon, 6 E/W, 7 sog, 8 cog, 9 date
    if (f.length < 10) return null;
    // 'V' is "navigation receiver warning" — no valid fix. Some receivers still
    // fill in the last known position, so logging a V sentence silently writes
    // a stale or (0,0) point into the track.
    if (f[2].toUpperCase() !== 'A') return null;
    const lat = nmeaToDecimal(f[3], f[4]);
    const lon = nmeaToDecimal(f[5], f[6]);
    if (lat === null || lon === null) return null;
    return { type: 'RMC', lat, lon, gps_time: rmcTimestamp(f[1], f[9]) };
  }

  if (type === 'GGA') {
    // f: 0 id, 1 time, 2 lat, 3 N/S, 4 lon, 5 E/W, 6 fix quality, 7 sats, 8 hdop
    if (f.length < 7) return null;
    if (!f[6] || Number(f[6]) === 0) return null;  // 0 = fix not available
    const lat = nmeaToDecimal(f[2], f[3]);
    const lon = nmeaToDecimal(f[4], f[5]);
    if (lat === null || lon === null) return null;
    return { type: 'GGA', lat, lon, gps_time: null };  // GGA carries no date
  }

  return null;
}

// ---------- module state ----------

const gpsState = {
  onFix: () => {},
  onStatus: () => {},
  source: 'none',          // 'none' | 'device' | 'serial'
  watchId: null,
  port: null,
  reader: null,
  keepReading: false,      // false once the user disconnects on purpose
  reconnectTimer: null,
  staleTimer: null,
  lastSentenceTs: 0,
  lastRmcTs: 0,
};

function report(msg) {
  gpsState.onStatus(msg);
}

function emit(fix) {
  gpsState.lastSentenceTs = Date.now();
  gpsState.onFix(fix);
}

// ---------- device geolocation ----------

function startDeviceWatch() {
  if (gpsState.source === 'serial') return false;
  if (!navigator.geolocation) {
    report('No geolocation on this device. Connect a USB GPS.');
    return false;
  }
  if (gpsState.watchId !== null) return true;
  gpsState.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (gpsState.source === 'serial') return;   // serial won the race; ignore
      gpsState.source = 'device';
      emit({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        ts: Date.now(),
        source: 'device',
        gps_time: null,
      });
    },
    (err) => report('Device GPS error: ' + err.message),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
  return true;
}

function stopDeviceWatch() {
  if (gpsState.watchId === null) return;
  navigator.geolocation.clearWatch(gpsState.watchId);
  gpsState.watchId = null;
  if (gpsState.source === 'device') gpsState.source = 'none';
}

// ---------- serial (USB NMEA) ----------

function isSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

// Splits a byte stream into NMEA sentences. Chunks off the port do not respect
// line boundaries, so a sentence routinely arrives in two pieces; anything
// after the last newline is held over for the next chunk.
function makeLineBuffer(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    // A stream that never yields a newline (wrong baud rate, or a non-NMEA
    // device) would otherwise grow without bound.
    if (buf.length > 4096) buf = buf.slice(-1024);
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}

function handleLine(line) {
  const p = parseSentence(line);
  gpsState.lastSentenceTs = Date.now();   // traffic, even if unparseable
  if (!p) return;

  // Prefer RMC. GGA is used only once RMC has gone quiet, which is the
  // GGA-only receiver case rather than a receiver that sends both.
  const now = Date.now();
  if (p.type === 'RMC') {
    gpsState.lastRmcTs = now;
  } else if (now - gpsState.lastRmcTs < RMC_PREFERENCE_MS) {
    return;
  }

  emit({
    lat: p.lat,
    lon: p.lon,
    ts: now,                 // device clock, to stay joinable with every other record
    source: 'serial',
    gps_time: p.gps_time,    // receiver clock, kept alongside; laptops drift
  });
}

// Opens the port and reads until the stream ends or errors. Returns on
// disconnect; the caller decides whether to retry.
async function readLoop(port) {
  const decoder = new TextDecoderStream();
  const closed = port.readable.pipeTo(decoder.writable).catch(() => {});
  const reader = decoder.readable.getReader();
  gpsState.reader = reader;
  const feed = makeLineBuffer(handleLine);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) feed(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) { /* already released */ }
    gpsState.reader = null;
    await closed;
  }
}

// Watches for a feed that has gone silent. A USB puck that is unplugged, or a
// laptop waking from sleep, leaves the port object alive but produces nothing —
// so silence, not an exception, is the usual way a track dies mid-survey, and
// nothing in the read loop would ever notice. Past FIX_DEAD_MS the reader is
// cancelled deliberately, which ends readLoop and drops the session into its
// reconnect path.
function startStaleWatch() {
  stopStaleWatch();
  gpsState.staleTimer = setInterval(() => {
    if (gpsState.source !== 'serial') return;
    const age = Date.now() - gpsState.lastSentenceTs;
    if (age > FIX_DEAD_MS) {
      report(`No GPS data for ${Math.round(age / 1000)} s — reopening the port.`);
      gpsState.lastSentenceTs = Date.now();   // don't fire again before the retry lands
      if (gpsState.reader) gpsState.reader.cancel().catch(() => {});
    } else if (age > FIX_STALE_MS) {
      report(`WARNING: no GPS data for ${Math.round(age / 1000)} s. Check the USB GPS.`);
    }
  }, 5000);
}

function stopStaleWatch() {
  if (gpsState.staleTimer) clearInterval(gpsState.staleTimer);
  gpsState.staleTimer = null;
}

// One attempt at opening `port` and running the read loop. Any failure here is
// reported and retried by the caller rather than thrown.
async function runPort(port) {
  await port.open({ baudRate: SERIAL_BAUD });
  gpsState.port = port;
  gpsState.source = 'serial';
  gpsState.lastSentenceTs = Date.now();
  stopDeviceWatch();
  startStaleWatch();
  report(`USB GPS connected at ${SERIAL_BAUD} baud. Waiting for a fix.`);
  await readLoop(port);
}

async function closePort() {
  if (gpsState.reader) {
    try { await gpsState.reader.cancel(); } catch (_) { /* already gone */ }
  }
  if (gpsState.port) {
    try { await gpsState.port.close(); } catch (_) { /* already closed */ }
  }
  gpsState.port = null;
}

// The retry loop. `keepReading` stays true until the user disconnects on
// purpose, so an unplug-and-replug, a sleep/wake, or a driver hiccup recovers
// on its own. Permission to use the port survives the drop, so no second
// click is needed — navigator.serial.getPorts() returns it without a gesture.
async function serialSession(port) {
  gpsState.keepReading = true;
  while (gpsState.keepReading) {
    try {
      await runPort(port);
      if (!gpsState.keepReading) break;
      report('USB GPS disconnected. Retrying...');
    } catch (err) {
      if (!gpsState.keepReading) break;
      report('USB GPS error: ' + err.message + ' — retrying...');
    }
    await closePort();
    if (!gpsState.keepReading) break;
    await new Promise((r) => { gpsState.reconnectTimer = setTimeout(r, RECONNECT_DELAY_MS); });
    // The port object is invalidated by a physical unplug, so re-fetch a
    // granted port rather than reusing the stale handle.
    const granted = await navigator.serial.getPorts();
    if (granted.length) port = granted[0];
  }
  stopStaleWatch();
  await closePort();
  if (gpsState.source === 'serial') gpsState.source = 'none';
}

// Must be called from a user gesture: requestPort() opens the browser's port
// picker, which the spec only permits in response to a click.
async function connectSerial() {
  if (!isSerialSupported()) {
    report('This browser has no Web Serial. Use Chrome or Edge on the laptop, over http://localhost.');
    return false;
  }
  try {
    // Reuse a port already granted in an earlier session, so the picker only
    // appears the first time on a given machine.
    const granted = await navigator.serial.getPorts();
    const port = granted.length ? granted[0] : await navigator.serial.requestPort();
    serialSession(port);   // deliberately not awaited: it runs for the survey
    return true;
  } catch (err) {
    // The user closing the picker without choosing throws; that is a cancel,
    // not a failure worth shouting about.
    report(err && err.name === 'NotFoundError'
      ? 'No GPS port selected.'
      : 'Could not open the USB GPS: ' + (err ? err.message : 'unknown error'));
    return false;
  }
}

async function disconnectSerial() {
  gpsState.keepReading = false;
  if (gpsState.reconnectTimer) clearTimeout(gpsState.reconnectTimer);
  gpsState.reconnectTimer = null;
  stopStaleWatch();
  await closePort();
  gpsState.source = 'none';
  report('USB GPS disconnected.');
  startDeviceWatch();
}

function activeSource() {
  return gpsState.source;
}

function init({ onFix, onStatus }) {
  gpsState.onFix = onFix || (() => {});
  gpsState.onStatus = onStatus || (() => {});
}

const GPS = {
  init,
  startDeviceWatch,
  stopDeviceWatch,
  isSerialSupported,
  connectSerial,
  disconnectSerial,
  activeSource,
  // exported for the test harness
  parseSentence,
  nmeaToDecimal,
  rmcTimestamp,
  checksumOk,
  makeLineBuffer,
  SERIAL_BAUD,
  _handleLine: handleLine,   // test hook: drives the sentence -> fix path
};

if (typeof module !== 'undefined' && module.exports) module.exports = { GPS };
