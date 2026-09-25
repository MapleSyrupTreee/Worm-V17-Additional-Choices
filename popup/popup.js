// popup.js - Extension popup controller

document.addEventListener('DOMContentLoaded', async () => {
  const statusIndicator = document.getElementById('statusIndicator');
  const customChoicesCount = document.getElementById('customChoicesCount');
  const choicesList = document.getElementById('choicesList');
  const openInPageModalBtn = document.getElementById('openInPageModalBtn');
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');

  let activeTabId = null;

  // 1. Load custom choices
  const { customChoices = [] } = await chrome.storage.local.get('customChoices');

  renderChoicesList(customChoices);

  // 2. Open in-page modal button
  openInPageModalBtn.addEventListener('click', async () => {
    if (!activeTabId) {
      alert('No active CYOA tab found. Please navigate to the Worm CYOA page.');
      return;
    }
    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'OPEN_ADD_CHOICE_MODAL' });
      window.close(); // Close popup so user interacts with page modal
    } catch (err) {
      alert('Could not open modal on this tab. Try reloading the CYOA page.');
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
    const kindLabel = { edited: 'edited', moved: 'moved', deleted: 'deleted' };
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
  discardAllBtn.addEventListener('click', async () => {
    if (!activeTabId) {
      alert('No active CYOA tab found.');
      return;
    }
    if (!confirm('Discard ALL editor changes on this page?\n\nEvery edit, move, addition and deletion made in the editor will be wiped and the page will reload pristine. This cannot be undone.')) {
      return;
    }
    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'DISCARD_ALL_EDITS' });
      window.close();
    } catch (err) {
      alert('Could not reach the CYOA tab. Try reloading the page.');
    }
  });

  // 3. Export & Import (choices + editor overlay: edits, moves, deletions)
  exportBtn.addEventListener('click', async () => {
    const { customChoices = [], editorOverlay = null } = await chrome.storage.local.get(['customChoices', 'editorOverlay']);
    if (customChoices.length === 0 && !editorOverlay) {
      alert('Nothing to export yet — no custom choices and no editor edits.');
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
    importFileInput.click();
  });

  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      // v2 export (choices + overlay) or legacy format (bare choices array)
      let importedChoices = [];
      let importedOverlay = null;
      if (Array.isArray(parsed)) {
        importedChoices = parsed;
      } else if (parsed && typeof parsed === 'object' && parsed.version === 2) {
        importedChoices = Array.isArray(parsed.customChoices) ? parsed.customChoices : [];
        importedOverlay = (parsed.editorOverlay && parsed.editorOverlay.version === 1) ? parsed.editorOverlay : null;
      } else {
        alert('Invalid format: expected a file exported by this extension.');
        return;
      }

      const { customChoices = [], editorOverlay = null } = await chrome.storage.local.get(['customChoices', 'editorOverlay']);
      const existingIds = new Set(customChoices.map(c => c.id));

      let addedCount = 0;
      for (const item of importedChoices) {
        if (item.title && item.rowId) {
          if (!item.id || existingIds.has(item.id)) {
            item.id = 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);
          }
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
          : { version: 1, objects: {}, deleted: [], rowPatches: {}, rowOrder: {} };
        mergedOverlay = {
          version: 1,
          objects: { ...(base.objects || {}), ...(importedOverlay.objects || {}) },
          deleted: Array.from(new Set([...(base.deleted || []), ...(importedOverlay.deleted || [])])),
          rowPatches: { ...(base.rowPatches || {}), ...(importedOverlay.rowPatches || {}) },
          rowOrder: { ...(base.rowOrder || {}), ...(importedOverlay.rowOrder || {}) }
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

      alert(`Imported ${addedCount} choice(s)` + (overlayMerged ? ' and merged editor edits. The CYOA page will reload to apply them.' : '') + '!');
    } catch (err) {
      alert('Error parsing JSON file: ' + err.message);
    } finally {
      importFileInput.value = '';
    }
  });

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
      .replace(/"/g, '&quot;');
  }
});
