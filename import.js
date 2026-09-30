// import.js — dedicated Firefox import window (opened by the popup, see
// popup.js). Firefox closes the toolbar popup when a native file dialog
// opens (Bugzilla 1459380), so importing happens here instead. This mirrors
// popup.js's import pipeline: size cap → JSON parse → shape check →
// WormImportSanitizer → warning gate → merge into chrome.storage →
// STORAGE_IMPORTED ping. The window closes itself on success.

(async function () {
  'use strict';

  const dropZone = document.getElementById('dropZone');
  const chooseBtn = document.getElementById('chooseBtn');
  const fileInput = document.getElementById('fileInput');
  const warnBox = document.getElementById('warnBox');
  const warnList = document.getElementById('warnList');
  const importAnywayBtn = document.getElementById('importAnywayBtn');
  const warnCancelBtn = document.getElementById('warnCancelBtn');
  const statusEl = document.getElementById('status');

  let pendingImport = null;

  const WARN_LABELS = {
    'html-scrubbed': 'Script tags, event handlers or javascript: links were found and stripped',
    'unknown-field': 'Unrecognized fields were found and removed',
    'proto-key': 'Prototype-pollution style keys (__proto__/constructor/prototype) were found and removed',
    'unsafe-data': 'Unusual or oversized nested data was found and removed',
    'invalid-id': 'Invalid identifiers were found and replaced',
    'choice-rejected': 'Malformed choice entries were skipped',
    'value-clamped': 'Overlong or oddly-typed values were shortened',
    'count-capped': 'The file contained more entries than allowed — only the first ones were kept',
    'overlay-invalid-key': 'Suspicious editor-edit entries were removed',
  };

  function setStatus(msg, tone) {
    statusEl.textContent = msg;
    statusEl.className = tone || '';
  }

  function showWarn(warningCodes) {
    warnList.innerHTML = warningCodes
      .map(code => `<li>${(WARN_LABELS[code] || code).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</li>`)
      .join('');
    warnBox.style.display = 'block';
    dropZone.style.display = 'none';
  }
  function hideWarn() {
    warnBox.style.display = 'none';
    dropZone.style.display = 'flex';
    pendingImport = null;
  }

  function findCyoaTabId() {
    // Active tab of any window whose URL matches the CYOA hosts.
    const matches = ['https://cyoa.ltouroumov.ch/*', 'https://ltouroumov.github.io/*', 'http://localhost:8123/*'];
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, url: matches }, (tabs) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve((tabs && tabs[0]) ? tabs[0].id : null);
        });
      } catch (err) { resolve(null); }
    });
  }

  // Merge logic mirrors popup.js performImport(): union of objects/deleted/
  // rowPatches/rowOrder, move log deduped with deleted-choice purge.
  async function performImport(sanitized, tabId) {
    const importedChoices = sanitized.choices;
    const importedOverlay = sanitized.overlay;
    const rejectedCount = sanitized.rejected;

    const { customChoices = [], editorOverlay = null } = await chrome.storage.local.get(['customChoices', 'editorOverlay']);
    const existingIds = new Set(customChoices.map(c => c.id));

    let addedCount = 0;
    for (const item of importedChoices) {
      if (!existingIds.has(item.id)) {
        customChoices.push(item);
        existingIds.add(item.id);
        addedCount++;
      }
    }

    let overlayMerged = false;
    let mergedOverlay = editorOverlay || null;
    if (importedOverlay) {
      const base = (editorOverlay && editorOverlay.version === 1)
        ? editorOverlay
        : { version: 1, objects: {}, deleted: [], rowPatches: {}, rowOrder: {}, moves: [] };
      const mergedDeleted = Array.from(new Set([...(base.deleted || []), ...(importedOverlay.deleted || [])]));
      const seenMoves = new Set();
      const mergedMoves = [];
      [...(base.moves || []), ...(importedOverlay.moves || [])].forEach((mv) => {
        if (!mv || !mv.id || mergedDeleted.includes(mv.id)) return;
        const key = JSON.stringify(mv);
        if (seenMoves.has(key)) return;
        seenMoves.add(key);
        mergedMoves.push(mv);
      });
      mergedOverlay = {
        version: 1,
        objects: { ...(base.objects || {}), ...(importedOverlay.objects || {}) },
        deleted: mergedDeleted,
        rowPatches: { ...(base.rowPatches || {}), ...(importedOverlay.rowPatches || {}) },
        rowOrder: { ...(base.rowOrder || {}), ...(importedOverlay.rowOrder || {}) },
        moves: mergedMoves,
      };
      overlayMerged = true;
    }

    await chrome.storage.local.set({ customChoices, editorOverlay: mergedOverlay });

    if (tabId) {
      try { await chrome.tabs.sendMessage(tabId, { action: 'STORAGE_IMPORTED' }); } catch (err) { /* page may not be open */ }
    }

    return { addedCount, overlayMerged, rejectedCount };
  }

  async function importFile(file) {
    if (!file) return;
    hideWarn();
    try {
      if (file.size > WormImportSanitizer.MAX_FILE_BYTES) {
        setStatus('Import blocked: file too large (max ' + Math.round(WormImportSanitizer.MAX_FILE_BYTES / 1024 / 1024) + ' MB).', 'error');
        return;
      }
      setStatus('Reading file…', '');
      const text = await file.text();
      const parsed = JSON.parse(text);

      const isV2 = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version === 2;
      if (!Array.isArray(parsed) && !isV2) {
        setStatus('Import blocked: invalid format — expected a file exported by this extension.', 'error');
        return;
      }

      setStatus('Sanitizing…', '');
      const sanitized = WormImportSanitizer.sanitizeImportPayload(parsed);
      if (!sanitized) {
        setStatus('Import blocked: no valid choices or editor edits found in that file.', 'warn');
        return;
      }

      if (sanitized.warnings && sanitized.warnings.length > 0) {
        pendingImport = sanitized;
        showWarn(sanitized.warnings);
        setStatus('');
        return;
      }

      await finishImport(sanitized);
    } catch (err) {
      setStatus('Import failed: ' + ((err && err.message) || err), 'error');
    }
  }

  async function finishImport(sanitized) {
    const tabId = await findCyoaTabId();
    const { addedCount, overlayMerged, rejectedCount } = await performImport(sanitized, tabId);
    setStatus('Imported ' + addedCount + ' choice(s)'
      + (overlayMerged ? ' and merged editor edits.' : '')
      + (rejectedCount > 0 ? ' (' + rejectedCount + ' malformed skipped.)' : '')
      + ' Closing…', 'ok');
    hideWarn();
    setTimeout(() => window.close(), 1300);
  }

  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    importFile(file);
  });
  importAnywayBtn.addEventListener('click', async () => {
    if (!pendingImport) { hideWarn(); return; }
    const sanitized = pendingImport;
    setStatus('Importing…', '');
    try { await finishImport(sanitized); } catch (err) { setStatus('Import failed: ' + ((err && err.message) || err), 'error'); hideWarn(); }
  });
  warnCancelBtn.addEventListener('click', hideWarn);

  ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  }));
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) importFile(file);
  });

  chooseBtn.focus();
})();
