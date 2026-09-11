// main.js — startup + event wiring

async function init() {
  await DB.openDB();
  await DB.ensureDefaultTags();

  let config = await DB.getConfig();
  if (!config || !config.device_id) {
    UI.$('#setup-modal').classList.remove('hidden');
    config = await new Promise((resolve) => {
      UI.$('#setup-save').addEventListener('click', async () => {
        const label = UI.$('#setup-input').value.trim() || 'iPad-1';
        const cfg = await DB.setConfig({ device_id: DB.uuid(), device_label: label });
        UI.$('#setup-modal').classList.add('hidden');
        resolve(cfg);
      });
    });
  }
  App.state.config = config;
  UI.$('#device-label').textContent = config.device_label;

  await UI.initMap();
  await UI.loadExistingIntoMap();

  App.state.tags = await App.loadTags();
  await UI.renderTagGrid();

  App.startPositionWatch();
  wireControls();
  UI.setStatus('Ready.');
  await requestPersistentStorage();
}

// Every export re-reads the local database, so that database is the only copy
// until a file is saved. Browsers may evict it under storage pressure unless it
// is marked persistent.
async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    if (await navigator.storage.persisted()) return;
    const granted = await navigator.storage.persist();
    if (!granted) {
      UI.setStatus('WARNING: browser did not grant persistent storage. Export often.');
    }
  } catch (err) {
    console.error('Persistent storage request failed:', err);
  }
}

function wireControls() {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.addEventListener('click', () => UI.showTab(btn.dataset.tab));
  }

  // Track toggle
  UI.$('#track-toggle').addEventListener('click', () => {
    App.state.trackOn = !App.state.trackOn;
    UI.setTrackToggle(App.state.trackOn);
    UI.setStatus(App.state.trackOn ? 'Track logging started.' : 'Track logging stopped.');
  });

  // USB GPS. requestPort() only opens the browser's port picker from inside a
  // user gesture, so this cannot be done automatically at startup — the click
  // is a requirement of the API, not a design choice.
  UI.$('#gps-btn').addEventListener('click', async () => {
    if (GPS.activeSource() === 'serial') {
      await GPS.disconnectSerial();
    } else if (GPS.isSerialSupported()) {
      await GPS.connectSerial();
    } else {
      // No Web Serial (iPad/Safari): the button has nothing to connect, but
      // retrying the device watch lets a survey recover from an earlier
      // permission denial without a full page reload.
      GPS.startDeviceWatch();
    }
    UI.updateGpsUI();
  });

  // Free note
  UI.$('#note-btn').addEventListener('click', () => UI.openNotesPrompt(null));
  UI.$('#notes-cancel').addEventListener('click', () => UI.$('#notes-modal').classList.add('hidden'));

  // Focal follow
  UI.$('#focal-btn').addEventListener('click', async () => {
    const focal = await App.startFocal();
    // A follow without a vessel track is not much use, so tracking is turned on
    // here. It stays on afterwards until toggled off.
    if (!App.state.trackOn) {
      App.state.trackOn = true;
      UI.setTrackToggle(true);
    }
    UI.setFocalHeader(focal);
    UI.setActivityButtons('unknown');
    UI.showFocalPanel(true);
    // Open the first surface interval up front so the blow button is present
    // the moment the panel opens, not only after tapping Surface.
    await App.switchInterval('SURFACE');
    UI.setActiveIntervalButton('SURFACE');
    UI.clearOptionalFields();
    await UI.refreshBlowCount();
    UI.startIntervalTimer();
    UI.setStatus(`${focal.focal_id} started — surface interval open, track on.`);
  });

  // Saved on every keystroke rather than on 'change'. 'change' only fires on
  // blur, which would lose an ID typed and then followed straight by a blow tap
  // — the tap does not blur the field reliably enough to bet field data on it.
  // The record is tiny and typed once per follow, so the write cost is nil.
  UI.$('#field-whale-id').addEventListener('input', (e) => App.setWhaleId(e.target.value));

  // Same save-on-keystroke reason as whale ID: 'change' only fires on blur, and
  // a blow tap does not blur reliably enough to bet field data on.
  UI.$('#field-focal-id').addEventListener('input', async (e) => {
    await App.setFocalId(e.target.value);
    await UI.refreshFocalIdState(e.target.value);
  });

  UI.$('#end-focal-btn').addEventListener('click', async () => {
    await App.setWhaleId(UI.$('#field-whale-id').value);
    await App.setFocalId(UI.$('#field-focal-id').value);
    await App.endFocal();
    UI.stopIntervalTimer();
    UI.showFocalPanel(false);
    UI.setActiveIntervalButton(null);
    UI.setFocalHeader(null);
    await UI.refreshBlowCount();
    UI.setStatus('Focal follow ended.');
  });

  // Notes made during a focal; logEvent stamps them with the current focal
  // and interval so they can be joined back to the surfacing.
  UI.$('#focal-note-btn').addEventListener('click', () => UI.openNotesPrompt(null));

  for (const btn of document.querySelectorAll('.activity-btn')) {
    btn.addEventListener('click', async () => {
      await App.setActivity(btn.dataset.activity);
      UI.setActivityButtons(btn.dataset.activity);
    });
  }

  for (const btn of document.querySelectorAll('.interval-btn')) {
    btn.addEventListener('click', async () => {
      await App.switchInterval(btn.dataset.type);
      UI.setActiveIntervalButton(btn.dataset.type);
      UI.clearOptionalFields();
      UI.startIntervalTimer();
      await UI.refreshBlowCount();
    });
  }

  // Behaviour buttons. Three behaviours auto-open an interval:
  //
  //   blow      → SURFACE. The first blow is "whale is up", so during a dive it
  //               closes the dive and opens a new surfacing before the blow lands.
  //
  //   fluke up  → DIVE. A fluke-up is the start of a dive; if not already in a
  //   fluke down   dive it closes the surfacing and opens one before the record
  //               is written.
  //
  // switchInterval sets App.state.focalInterval synchronously, so a second tap
  // arriving mid-write sees the new interval and neither switches again nor
  // files its observation against the closed interval.
  //
  // All other behaviours are filed against whatever interval is already open.
  UI.renderBehaviorGrid(async (behavior) => {
    if (!App.state.focal) return;
    if (behavior === 'blow') {
      const needsNewSurfacing =
        !App.state.focalInterval || App.state.focalInterval.type !== 'SURFACE';
      if (needsNewSurfacing) {
        await App.switchInterval('SURFACE');
        UI.setActiveIntervalButton('SURFACE');
        UI.clearOptionalFields();
        UI.startIntervalTimer();
        await UI.refreshBlowCount();
      }
      // Bumped locally before the write so the number moves on the tap;
      // countBlows() scans the whole store and must not sit in between.
      UI.bumpBlowCount();
    } else if (behavior === 'fluke up' || behavior === 'fluke down') {
      const needsNewDive =
        !App.state.focalInterval || App.state.focalInterval.type !== 'DIVE';
      if (needsNewDive) {
        await App.switchInterval('DIVE');
        UI.setActiveIntervalButton('DIVE');
        UI.clearOptionalFields();
        UI.startIntervalTimer();
      }
    }
    UI.flashBehavior(behavior);
    await App.logBehavior(behavior);
  });

  for (const btn of document.querySelectorAll('.quality-btn')) {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.quality-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      await App.updateCurrentInterval({ quality: btn.dataset.q });
    });
  }

  UI.$('#field-distance').addEventListener('change', (e) =>
    App.updateCurrentInterval({ distance_m: e.target.value ? Number(e.target.value) : null })
  );
  UI.$('#field-bearing').addEventListener('change', (e) =>
    App.updateCurrentInterval({ bearing_to_whale: e.target.value ? Number(e.target.value) : null })
  );
  UI.$('#field-direction').addEventListener('change', (e) =>
    App.updateCurrentInterval({ swim_direction: e.target.value || null })
  );

  // Tag manager
  UI.$('#manage-tags-btn').addEventListener('click', async () => {
    await UI.renderTagManager();
    UI.$('#tag-manager-modal').classList.remove('hidden');
  });
  UI.$('#tag-manager-close').addEventListener('click', () =>
    UI.$('#tag-manager-modal').classList.add('hidden')
  );
  UI.$('#add-tag-btn').addEventListener('click', async () => {
    const input = UI.$('#new-tag-input');
    const label = input.value.trim();
    if (!label) return;
    input.value = '';
    App.state.tags = await App.addTag(label);
    await UI.renderTagGrid();
    await UI.renderTagManager();
  });

  // Clear all survey data. Blocked mid-follow so a running focal cannot be
  // half-deleted out from under the open interval.
  UI.$('#clear-data-btn').addEventListener('click', async () => {
    if (App.state.focal) {
      UI.setStatus('End the focal follow before clearing data.');
      return;
    }
    UI.$('#clear-export-result').textContent = '';
    await UI.openClearModal();
  });
  UI.$('#clear-input').addEventListener('input', (e) => {
    UI.$('#clear-confirm').disabled = e.target.value.trim().toUpperCase() !== 'CLEAR';
  });
  UI.$('#clear-export-btn').addEventListener('click', async () => {
    const out = UI.$('#clear-export-result');
    out.textContent = 'Exporting...';
    try {
      // Both files, always. Clearing after exporting only one would silently
      // discard the other.
      const { files } = await App.exportCSV();
      const summary = files.map((f) => `${f.name} (${f.rows} rows)`).join(', ');
      out.textContent = `Saved ${summary}`;
      UI.setStatus(`Exported ${summary}`);
    } catch (err) {
      out.textContent = 'Export FAILED: ' + err.message + ' — do not clear.';
      console.error(err);
    }
  });
  UI.$('#clear-cancel').addEventListener('click', () =>
    UI.$('#clear-modal').classList.add('hidden')
  );
  UI.$('#clear-confirm').addEventListener('click', async () => {
    UI.$('#clear-confirm').disabled = true;
    await App.clearSurveyData();
    // Reload rather than tear down the map layers and in-memory state by hand;
    // guarantees nothing stale survives into the new survey.
    location.reload();
  });

  // Export / import
  UI.$('#export-json-btn').addEventListener('click', () => App.exportAll());
  UI.$('#export-csv-btn').addEventListener('click', async () => {
    const { files } = await App.exportCSV();
    UI.setStatus('Exported ' + files.map((f) => `${f.name} (${f.rows} rows)`).join(', '));
  });
  UI.$('#import-json-btn').addEventListener('click', () => UI.$('#import-file-input').click());
  UI.$('#import-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const count = await App.importFile(file);
    UI.setStatus(`Imported ${count} records.`);
    location.reload();
  });
}

// The service worker is cache-first over the whole app shell, which is right in
// the field and wrong while developing: after an edit, reload #1 serves the old
// files and reload #2 the new ones, because the page that triggers the update
// has already fetched its HTML/CSS/JS from the old cache. Worse, a mixed load
// (old HTML, new CSS) reads as a broken layout rather than a stale one.
// So: no service worker on localhost. Offline behaviour is unchanged wherever
// this is actually deployed.
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

if ('serviceWorker' in navigator) {
  if (IS_LOCAL) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
  } else {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .catch((err) => console.error('Service worker registration failed:', err));
    });
  }
}

init().catch((err) => {
  console.error(err);
  UI.setStatus('Startup error: ' + err.message);
});
