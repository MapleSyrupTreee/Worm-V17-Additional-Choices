// popup.js - Extension popup controller

document.addEventListener('DOMContentLoaded', async () => {
  const statusIndicator = document.getElementById('statusIndicator');
  const customChoicesCount = document.getElementById('customChoicesCount');
  const choicesList = document.getElementById('choicesList');
  const openInPageModalBtn = document.getElementById('openInPageModalBtn');
  const openRowModalBtn = document.getElementById('openRowModalBtn');
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');

  let activeTabId = null;

  // Firefox closes the extension popup when a native file dialog opens
  // (Bugzilla 1459380/1366330), destroying the popup's JS context before the
  // <input type="file"> change event can fire. Workaround: run the import in
  // a standalone popup window (popup.html?import=1), which stays open during
  // the file picker. Chrome keeps its popup open, so the in-popup picker is
  // kept there.
  const IS_FIREFOX = navigator.userAgent.includes('Firefox/');
  const IMPORT_TAB = new URLSearchParams(location.search).get('import') === '1';

  // 1. Load custom choices
  const { customChoices = [] } = await chrome.storage.local.get('customChoices');

  renderChoicesList(customChoices);

  // 2. Open in-page modal buttons (Add Row / Add Choice)
  openRowModalBtn.addEventListener('click', async () => {
    if (!activeTabId) {
      showNotice('No CYOA tab', 'No active CYOA tab found. Please navigate to the Worm CYOA page.', 'warn');
      return;
    }
    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'OPEN_ADD_ROW_MODAL' });
      window.close(); // Close popup so user interacts with page modal
    } catch (err) {
      await showNotice('Not connected', 'Could not open the row modal on this tab. Try reloading the CYOA page.', 'error');
    }
  });

  openInPageModalBtn.addEventListener('click', async () => {
    if (!activeTabId) {
      showNotice('No CYOA tab', 'No active CYOA tab found. Please navigate to the Worm CYOA page.', 'warn');
      return;
    }
    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'OPEN_ADD_CHOICE_MODAL' });
      window.close(); // Close popup so user interacts with page modal
    } catch (err) {
      await showNotice('Not connected', 'Could not open modal on this tab. Try reloading the CYOA page.', 'error');
    }
  });

  // 2b. Show/hide the on-page "Edit CYOA" button (persisted setting)
  const showEditorToggle = document.getElementById('showEditorToggle');
  chrome.storage.local.get('showEditorToggle').then((res) => {
    showEditorToggle.checked = res.showEditorToggle !== false; // default: visible
  }).catch(() => {});
  showEditorToggle.addEventListener('change', async () => {
    try {
      await chrome.storage.local.set({ showEditorToggle: showEditorToggle.checked });
    } catch (err) { /* storage unavailable — ignore */ }
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { action: 'SHOW_EDITOR_TOGGLE', visible: showEditorToggle.checked })
        .catch(() => { /* page not open — next load reads the setting */ });
    }
  });

  // 2c. Editor edits on existing choices (moved / edited / deleted)
  const editsList = document.getElementById('editsList');
  const editsCount = document.getElementById('editsCount');
  const editsHint = document.getElementById('editsHint');
  async function loadEditsSummary(tabId) {
    let items = [];
    let live = false;
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { action: 'GET_EDITS_SUMMARY' });
      if (resp && resp.status === 'ok') { items = resp.items || []; live = !!resp.live; }
    } catch (err) {
      // No reachable content script (page closed / internal page): fall back
      // to a storage-only summary — deletions and field edits still resolve,
      // but moved-choice detection needs a live snapshot and is skipped.
      try {
        const { editorOverlay = null, customChoices = [], lastDetectedCYOA = null } = await chrome.storage.local.get(['editorOverlay', 'customChoices', 'lastDetectedCYOA']);
        const rowTitleFallback = {};
        ((lastDetectedCYOA && lastDetectedCYOA.rows) || []).forEach(r => { if (r && r.id) rowTitleFallback[r.id] = r.title || r.id; });
        items = overlaySummarizeEdits(editorOverlay, customChoices, null, rowTitleFallback);
      } catch (err2) { items = []; }
    }
    editsCount.textContent = String(items.length);
    editsHint.hidden = live || items.length === 0;
    if (items.length === 0) {
      editsList.innerHTML = '<div class="empty-state">No edits to existing choices.</div>';
      return;
    }
    const kindLabel = { edited: 'edited', moved: 'moved', changed: 'edited+moved', deleted: 'deleted', added: 'added' };
    editsList.innerHTML = items.map(it => `
      <div class="choice-item">
        <span class="edit-kind kind-${it.kind}">${kindLabel[it.kind] || it.kind}</span>
        <div class="choice-info">
          <span class="choice-title" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</span>
          <span class="choice-meta" title="${escapeHtml(it.detail)}">${escapeHtml(it.detail)}</span>
        </div>
      </div>
    `).join('');
  }

  // 2d. Discard all edits (overlay + custom choices) and reload the page
  const discardAllBtn = document.getElementById('discardAllBtn');
  const discardModal = document.getElementById('discardModal');
  const discardCancelBtn = document.getElementById('discardCancelBtn');
  const discardConfirmBtn = document.getElementById('discardConfirmBtn');
  let discardPending = false; // guard against double-firing while the op runs

  function openDiscardModal() {
    discardPending = false;
    discardModal.hidden = false;
    discardCancelBtn.focus(); // safe default focus
  }
  function closeDiscardModal() { discardModal.hidden = true; }

  discardAllBtn.addEventListener('click', async () => {
    if (!activeTabId) {
      showNotice('No CYOA tab', 'No active CYOA tab found.', 'warn');
      return;
    }
    openDiscardModal();
  });
  discardCancelBtn.addEventListener('click', closeDiscardModal);
  discardModal.addEventListener('click', (e) => { if (e.target === discardModal) closeDiscardModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !discardModal.hidden) closeDiscardModal();
  });
  discardConfirmBtn.addEventListener('click', async () => {
    if (discardPending) return;
    discardPending = true;
    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'DISCARD_ALL_EDITS' });
      window.close();
    } catch (err) {
      discardPending = false;
      closeDiscardModal();
      await showNotice('Not connected', 'Could not reach the CYOA tab. Try reloading the page.', 'error');
    }
  });

  // 3. Export & Import (choices + editor overlay: edits, moves, deletions)
  exportBtn.addEventListener('click', async () => {
    const { customChoices = [], editorOverlay = null } = await chrome.storage.local.get(['customChoices', 'editorOverlay']);
    if (customChoices.length === 0 && !editorOverlay) {
      showNotice('Nothing to export', 'No custom choices and no editor edits yet.', 'warn');
      return;
    }

    const payload = {
      version: 2,
      exported: Date.now(),
      customChoices,
      editorOverlay: (editorOverlay && editorOverlay.version === 1) ? editorOverlay : null
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `worm_v17_editor_data_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', () => {
    if (IS_FIREFOX && !IMPORT_TAB) {
      // Firefox: relaunch the popup UI as a standalone window so the file
      // picker doesn't kill the page (see note at top of file).
      try {
        const p = chrome.windows.create({ url: 'popup.html?import=1', type: 'popup', width: 480, height: 720 });
        if (p && p.then) p.catch(() => {});
      } catch (err) { /* ignore */ }
      window.close();
      return;
    }
    importFileInput.click();
    if (IMPORT_TAB) importBtn.blur();
  });

  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // Security: the file is UNTRUSTED input. Enforce a raw size limit,
      // then run it through the sanitizer (shape/field allowlist, type and
      // length caps, HTML scrubbing) before it touches storage.
      if (file.size > WormImportSanitizer.MAX_FILE_BYTES) {
        showNotice('Import blocked', 'File too large (max ' + Math.round(WormImportSanitizer.MAX_FILE_BYTES / 1024 / 1024) + ' MB).', 'error');
        return;
      }
      const text = await file.text();
      const parsed = JSON.parse(text);

      // v2 export (choices + overlay) or legacy format (bare choices array)
      const isV2 = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version === 2;
      if (!Array.isArray(parsed) && !isV2) {
        showNotice('Import blocked', 'Invalid format: expected a file exported by this extension.', 'error');
        return;
      }

      const sanitized = WormImportSanitizer.sanitizeImportPayload(parsed);
      if (!sanitized) {
        showNotice('Import blocked', 'No valid choices or editor edits found in that file.', 'warn');
        return;
      }
      // If the sanitizer flagged anything strange, warn the user in a styled
      // dialog and require explicit confirmation before importing.
      if (sanitized.warnings && sanitized.warnings.length > 0) {
        pendingImport = sanitized;
        openImportWarnModal(sanitized.warnings);
        return;
      }

      await performImport(sanitized);
    } catch (err) {
      showNotice('Import failed', 'Error parsing JSON file: ' + err.message, 'error');
    } finally {
      importFileInput.value = '';
    }
  });

  async function performImport(sanitized) {
    const importedChoices = sanitized.choices;
    const importedOverlay = sanitized.overlay;
    const rejectedCount = sanitized.rejected;

    const { customChoices = [], editorOverlay = null } = await chrome.storage.local.get(['customChoices', 'editorOverlay']);
    const existingIds = new Set(customChoices.map(c => c.id));

    let addedCount = 0;
    for (const item of importedChoices) {
      // Items arrive pre-sanitized (valid title/rowId/id); only id-collision
      // handling remains.
      if (!existingIds.has(item.id)) {
        customChoices.push(item);
        existingIds.add(item.id);
        addedCount++;
      }
    }

      // Merge the overlay: patches/row patches from the file win for the ids
      // they cover, deletion sets union, existing row orders not in the file
      // are kept.
      let overlayMerged = false;
      let mergedOverlay = editorOverlay || null;
      if (importedOverlay) {
        const base = (editorOverlay && editorOverlay.version === 1)
          ? editorOverlay
          : { version: 1, objects: {}, deleted: [], rowPatches: {}, rowOrder: {}, moves: [] };
        const mergedDeleted = Array.from(new Set([...(base.deleted || []), ...(importedOverlay.deleted || [])]));
        // Merge move logs (dedupe exact repeats), dropping moves of deleted choices.
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
      renderChoicesList(customChoices);

      // Tell the CYOA tab to re-sync storage and reload so the overlay is
      // applied cleanly by the fetch interceptor.
      if (activeTabId) {
        try { await chrome.tabs.sendMessage(activeTabId, { action: 'STORAGE_IMPORTED' }); } catch (err) { /* page may not be open */ }
      }

    await showNotice('Import complete',
      `Imported ${addedCount} choice(s)` + (overlayMerged ? ' and merged editor edits. The CYOA page will reload to apply them.' : '') + '.'
      + (rejectedCount > 0 ? ` (${rejectedCount} malformed entr${rejectedCount === 1 ? 'y' : 'ies'} skipped.)` : ''),
      'ok');

    // Standalone import window: we're done here, close it.
    if (IMPORT_TAB) window.close();
  }

  // Suspicious-import warning dialog (styled, non-native).
  const importWarnModal = document.getElementById('importWarnModal');
  const importWarnList = document.getElementById('importWarnList');
  const importWarnCancelBtn = document.getElementById('importWarnCancelBtn');
  const importWarnConfirmBtn = document.getElementById('importWarnConfirmBtn');
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

  function openImportWarnModal(warningCodes) {
    importWarnList.innerHTML = warningCodes
      .map(code => `<li>${escapeHtml(WARN_LABELS[code] || code)}</li>`)
      .join('');
    importWarnModal.hidden = false;
    importWarnCancelBtn.focus();
  }
  function closeImportWarnModal() { importWarnModal.hidden = true; }
  importWarnCancelBtn.addEventListener('click', closeImportWarnModal);
  importWarnModal.addEventListener('click', (e) => { if (e.target === importWarnModal) closeImportWarnModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !importWarnModal.hidden) closeImportWarnModal();
  });
  importWarnConfirmBtn.addEventListener('click', async () => {
    if (!pendingImport) { closeImportWarnModal(); return; }
    const sanitized = pendingImport;
    pendingImport = null;
    closeImportWarnModal();
    await performImport(sanitized);
  });

  // Styled notice dialog — replaces every native alert() in the popup.
  const noticeModal = document.getElementById('noticeModal');
  const noticeTitle = document.getElementById('noticeTitle');
  const noticeTitleText = document.getElementById('noticeTitleText');
  const noticeMessage = document.getElementById('noticeMessage');
  const noticeIconPath = document.getElementById('noticeIconPath');
  const noticeOkBtn = document.getElementById('noticeOkBtn');
  const NOTICE_ICONS = {
    ok: 'M2 8.5 6 12.5 14 3.5',
    warn: 'M8 2 1.5 13.5h13L8 2Zm0 4.5v3.5M8 12.2v.3',
    error: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM5.5 5.5l5 5m0-5-5 5',
  };
  let noticeQueue = Promise.resolve();

  function showNotice(title, message, tone) {
    noticeQueue = noticeQueue.then(() => new Promise((resolve) => {
      noticeTitleText.textContent = title;
      noticeMessage.textContent = message;
      noticeIconPath.setAttribute('d', NOTICE_ICONS[tone] || NOTICE_ICONS.warn);
      noticeTitle.className = 'tone-' + (tone || 'warn');
      noticeModal.hidden = false;
      noticeOkBtn.focus();
      const done = () => {
        noticeOkBtn.removeEventListener('click', done);
        noticeModal.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onEscape);
        noticeModal.hidden = true;
        resolve();
      };
      const onBackdrop = (e) => { if (e.target === noticeModal) done(); };
      const onEscape = (e) => { if (e.key === 'Escape') done(); };
      noticeOkBtn.addEventListener('click', done);
      noticeModal.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onEscape);
    }));
    return noticeQueue;
  }

  // 4. Connect to active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setInactive('No active tab');
      return;
    }

    activeTabId = tab.id;
    loadEditsSummary(activeTabId);

    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
      setInactive('Internal page');
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_STATUS' });
      if (response && response.metadata) {
        statusIndicator.className = 'status-indicator active';
        statusIndicator.title = 'Worm CYOA Active';
      } else {
        statusIndicator.className = 'status-indicator';
        statusIndicator.title = 'Connected (waiting for metadata)';
      }
    } catch (msgErr) {
      statusIndicator.className = 'status-indicator';
      statusIndicator.title = 'Reload CYOA page to connect';
    }
  } catch (err) {
    console.error('Error connecting to tab:', err);
    setInactive('Connection error');
  }

  function setInactive(msg) {
    statusIndicator.className = 'status-indicator inactive';
    statusIndicator.title = msg;
  }

  function renderChoicesList(choices) {
    customChoicesCount.textContent = choices.length;

    if (!choices || choices.length === 0) {
      choicesList.innerHTML = '<div class="empty-state">No custom choices added yet. Click above to create one!</div>';
      return;
    }

    choicesList.innerHTML = choices.map((c, idx) => `
      <div class="choice-item">
        <div class="choice-info">
          <span class="choice-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</span>
          <span class="choice-meta">Row: ${escapeHtml(c.rowId)} ${c.scores?.length ? '• Score: ' + c.scores[0].value : ''}</span>
        </div>
        <button class="choice-del-btn" data-index="${idx}" title="Delete choice">&times;</button>
      </div>
    `).join('');

    choicesList.querySelectorAll('.choice-del-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const index = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        const { customChoices = [] } = await chrome.storage.local.get('customChoices');
        const [removed] = customChoices.splice(index, 1);
        await chrome.storage.local.set({ customChoices });
        renderChoicesList(customChoices);

        // Tell the live page to drop the choice (no reload needed)
        if (activeTabId) {
          chrome.tabs.sendMessage(activeTabId, {
            action: 'CHOICE_DELETED',
            choiceId: removed.id
          }).catch(() => {});
        }
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
});
