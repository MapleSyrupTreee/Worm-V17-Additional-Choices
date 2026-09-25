// content.js — isolated-world entry: storage <-> page-script bridge, popup
// messaging, scroll restore, and boot. The editor/dialog modules it drives
// are listed in manifest.json and share this isolated world's top-level scope.

console.log('[Worm V17 Mod] Content script loaded on:', window.location.href);

let detectedMetadata = {
  detected: false,
  rows: [],
  pointTypes: []
};
// The CYOA_METADATA_LOADED → syncSavedChoicesToPage re-sync must run only
// ONCE per page load (when point types become known). Every later metadata
// emission — e.g. the popup's status ping (REQUEST_METADATA) — must be a
// pure read: re-syncing would re-inject the stored customChoices into the
// live store and could revert editor changes. Popup open ≠ page change.
let metadataSyncDone = false;

// 1. On startup, fetch saved choices from chrome.storage, normalize and pass to page-script
async function syncSavedChoicesToPage() {
  try {
    const { customChoices = [], lastDetectedCYOA = null } = await chrome.storage.local.get(['customChoices', 'lastDetectedCYOA']);
    const pts = lastDetectedCYOA?.pointTypes || [];

    // Normalize existing choices in case they were saved with older schema
    let modified = false;
    const normalizedList = customChoices.map(choice => {
      if (Array.isArray(choice.scores)) {
        choice.scores = choice.scores.map(s => {
          const pt = pts.find(p => p.id === s.id);
          const ptName = pt ? (pt.name || pt.id) : (s.afterText || 'Points');
          const abbr = abbreviatePointName(ptName);
          const rawVal = parseInt(s.value, 10) || 0;
          // Detect gain: negative value OR formerly '+' beforeText
          const isGain = s.beforeText === '+' || s.beforeText === 'Gain:' || (rawVal < 0 && s.beforeText !== '-' && s.beforeText !== 'Cost:');
          const absVal = Math.abs(rawVal);

          const normalized = {
            id: s.id,
            value: isGain ? String(-absVal) : String(absVal),
            beforeText: isGain ? 'Gain:' : 'Cost:',
            afterText: abbr,
            requireds: Array.isArray(s.requireds) ? s.requireds : []
          };

          if (s.beforeText !== normalized.beforeText || s.afterText !== normalized.afterText || !s.requireds) {
            modified = true;
          }
          return normalized;
        });
      }
      return choice;
    });

    if (modified) {
      await chrome.storage.local.set({ customChoices: normalizedList });
    }

    window.postMessage({
      target: 'WORM_CYOA_PAGE_SCRIPT',
      command: 'SYNC_CUSTOM_CHOICES',
      payload: normalizedList
    }, '*');
  } catch (err) {
    console.warn('[Worm V17 Mod] Failed to sync saved choices on load:', err);
  }
}



syncSavedChoicesToPage();

// Sync the editor overlay to page-script for the fetch-interceptor path.
chrome.storage.local.get(EDITOR_OVERLAY_KEY).then((res) => {
  const overlay = res[EDITOR_OVERLAY_KEY] || null;
  window.postMessage({ target: 'WORM_CYOA_PAGE_SCRIPT', command: 'SYNC_EDITOR_OVERLAY', payload: overlay }, '*');
}).catch(() => {});

// 2. Listen for messages from page-script.js (MAIN world)
window.addEventListener('message', async (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'WORM_CYOA_PAGE_SCRIPT') {
    return;
  }

  if (event.data.type === 'CYOA_METADATA_LOADED') {
    const data = event.data.data;
    detectedMetadata = {
      detected: true,
      rows: data.rows || [],
      pointTypes: data.pointTypes || []
    };

    console.log('[Worm V17 Mod] Metadata received:', detectedMetadata);

    // Save to chrome.storage for popup access
    await chrome.storage.local.set({ lastDetectedCYOA: detectedMetadata });

    // Re-sync choices with new point types to ensure clean afterText —
    // only on the FIRST metadata load of this page (see metadataSyncDone).
    if (!metadataSyncDone) {
      metadataSyncDone = true;
      syncSavedChoicesToPage();
    }
  } else if (event.data.type === 'CHOICE_REMOVED_SUCCESS') {
    showToast('Custom choice removed from CYOA!');
  } else if (event.data.type === 'EDITOR_MODE_CHANGED') {
    editorHandleMode(event.data.data);
  } else if (event.data.type === 'EDITOR_DATA') {
    editorResolve(event.data.data && event.data.data.reqId, event.data.data);
  } else if (event.data.type === 'EDITOR_OBJECT') {
    editorResolve(event.data.data && event.data.data.reqId, event.data.data);
  } else if (event.data.type === 'EDITOR_RESULT') {
    editorResolve(event.data.data && event.data.data.reqId, event.data.data);
    if (event.data.data && !event.data.data.ok && event.data.data.error) {
      showToast('Editor: ' + event.data.data.error);
    }
  } else if (event.data.type === 'EDITOR_DATA_CHANGED') {
    editorHandleDataChanged(event.data.data);
  }
});

// 3. Listen for requests from popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_PAGE_STATUS') {
    window.postMessage({
      target: 'WORM_CYOA_PAGE_SCRIPT',
      command: 'REQUEST_METADATA'
    }, '*');

    sendResponse({ status: 'ok', metadata: detectedMetadata });
    return true;
  } else if (message.action === 'OPEN_ADD_CHOICE_MODAL') {
    // Popup-triggered Add: pull a fresh editor snapshot first so the dialog
    // has current rows/choices, then open the shared choice dialog.
    (async () => {
      const snap = await editorRequest('EDITOR_GET_DATA');
      if (snap && snap.snapshot) EDITOR_UI.data = snap.snapshot;
      await openChoiceModal({});
    })();
    sendResponse({ status: 'ok' });
    return true;
  } else if (message.action === 'CHOICE_DELETED') {
    // Relay the deletion to page-script so the live page drops the choice
    // without a page reload.
    window.postMessage({
      target: 'WORM_CYOA_PAGE_SCRIPT',
      command: 'REMOVE_CHOICE',
      payload: message.choiceId
    }, '*');
    sendResponse({ status: 'ok' });
    return true;
  } else if (message.action === 'STORAGE_IMPORTED') {
    // Popup imported choices/overlay into storage: re-sync to page-script and
    // reload so the fetch interceptor applies everything cleanly.
    (async () => {
      try {
        const { customChoices = [], editorOverlay = null } = await chrome.storage.local.get(['customChoices', 'editorOverlay']);
        window.postMessage({ target: 'WORM_CYOA_PAGE_SCRIPT', command: 'SYNC_CUSTOM_CHOICES', payload: customChoices }, '*');
        window.postMessage({ target: 'WORM_CYOA_PAGE_SCRIPT', command: 'SYNC_EDITOR_OVERLAY', payload: editorOverlay }, '*');
        showToast('Imported — reloading…');
        setTimeout(() => window.location.reload(), 700);
      } catch (err) {
        showToast('Import sync failed: ' + (err && err.message ? err.message : err));
      }
    })();
    sendResponse({ status: 'ok' });
    return true;
  } else if (message.action === 'GET_EDITS_SUMMARY') {
    // Popup asks for a human-readable list of editor edits on existing
    // (non-custom) choices: field edits, moves, deletions. Titles resolve
    // from a live EDITOR_GET_DATA snapshot when the CYOA is loaded.
    (async () => {
      try {
        const { editorOverlay = null, customChoices = [] } = await chrome.storage.local.get(['editorOverlay', 'customChoices']);
        let snapshot = null;
        const resp = await editorRequest('EDITOR_GET_DATA');
        if (resp && resp.snapshot) snapshot = resp.snapshot;
        // Row titles from cached metadata keep move entries readable even when
        // the live snapshot isn't available.
        const rowTitleFallback = {};
        (detectedMetadata.rows || []).forEach(r => { if (r && r.id) rowTitleFallback[r.id] = r.title || r.id; });
        sendResponse({
          status: 'ok',
          live: !!snapshot,
          items: overlaySummarizeEdits(editorOverlay, customChoices, snapshot, rowTitleFallback),
        });
      } catch (err) {
        sendResponse({ status: 'error', error: String((err && err.message) || err), items: [] });
      }
    })();
    return true;
  } else if (message.action === 'SHOW_EDITOR_TOGGLE') {
    // Popup settings toggle: show/hide the floating Edit CYOA button live.
    const btn = document.getElementById('worm-edit-toggle');
    if (btn) btn.hidden = !message.visible;
    sendResponse({ status: 'ok' });
  } else if (message.action === 'DISCARD_ALL_EDITS') {
    // Safety hatch: wipe the overlay + custom choices, then reload so the
    // page comes back pristine from the original project.json.
    (async () => {
      try {
        await chrome.storage.local.set({ editorOverlay: null, customChoices: [] });
        window.postMessage({ target: 'WORM_CYOA_PAGE_SCRIPT', command: 'SYNC_EDITOR_OVERLAY', payload: null }, '*');
        window.postMessage({ target: 'WORM_CYOA_PAGE_SCRIPT', command: 'SYNC_CUSTOM_CHOICES', payload: [] }, '*');
        showToast('All edits discarded — reloading…');
        setTimeout(() => window.location.reload(), 700);
      } catch (err) {
        showToast('Discard failed: ' + (err && err.message ? err.message : err));
      }
    })();
    sendResponse({ status: 'ok' });
    return true;
  }
});


// 6b. Scroll-position preservation across reloads: the extension reloads the
// page in a few flows (import, discard) and the user may refresh manually —
// in all cases they should come back at the exact spot they left. Kept in
// sessionStorage (per-tab, survives reload, dies with the tab).
(function initScrollRestore() {
  const KEY = 'wormScrollY:' + window.location.pathname;
  let saveTimer = 0;
  let userTookOver = false; // stop retry-restore once the user scrolls again
  const save = () => {
    try { sessionStorage.setItem(KEY, String(Math.round(window.scrollY))); } catch (err) {}
  };
  window.addEventListener('scroll', () => {
    userTookOver = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 150);
  }, { passive: true });
  window.addEventListener('beforeunload', save);
  window.addEventListener('pagehide', save);

  const restoreOnce = () => {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw == null) return false;
      const y = parseInt(raw, 10) || 0;
      if (y > 0 && Math.abs(window.scrollY - y) > 2) {
        window.scrollTo(0, y);
        return true;
      }
    } catch (err) {}
    return false;
  };
  // Restore on load, then retry a few times: images/lazy remounts change the
  // page height after load and can push the restored offset back to 0.
  if (restoreOnce()) {
    let attempts = 0;
    const retry = () => {
      if (userTookOver || attempts >= 6) return;
      attempts++;
      if (window.scrollY === 0) restoreOnce();
      setTimeout(retry, 700);
    };
    setTimeout(retry, 700);
  }
})();


// ------------------------------------------------------------------ boot --

ensureEditorToggle();

