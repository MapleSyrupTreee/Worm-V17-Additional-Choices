// content.js - Isolated content script bridge & UI injection

(function () {
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

  const EDITOR_OVERLAY_KEY = 'editorOverlay';
  let overlayQueue = Promise.resolve(); // serialize storage read-modify-write

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
    } else if (event.data.type === 'CHOICE_INJECTED_SUCCESS') {
      showToast('Custom choice added to CYOA!');
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
    } else if (message.action === 'INJECT_CHOICE_FROM_POPUP') {
      handleInjectChoice(message.choice);
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

  // 5. Handle choice saving and live injection
  async function handleInjectChoice(choice) {
    const { customChoices = [] } = await chrome.storage.local.get('customChoices');
    // Check if updating existing
    const existingIdx = customChoices.findIndex(c => c.id === choice.id);
    if (existingIdx >= 0) {
      customChoices[existingIdx] = choice;
    } else {
      customChoices.push(choice);
    }
    await chrome.storage.local.set({ customChoices });

    // Tell page-script to inject into live Vue/Pinia store and CollectionLoader DOM
    window.postMessage({
      target: 'WORM_CYOA_PAGE_SCRIPT',
      command: 'INJECT_SINGLE_CHOICE',
      payload: choice
    }, '*');
  }

  // 6. Toast notification helper
  function showToast(message) {
    const existing = document.querySelector('.worm-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'worm-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

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


  // =========================================================================
  // 7. Interactive Editor ("Worm Forge")
  //    Toggle button → edit mode over the live viewer. Cards are matched to
  //    store objects by unique title with an order-based fallback; the mapping
  //    lives here in the isolated world and is rebuilt after every mutation
  //    broadcast. Selection chrome is plain DOM + fixed layers.
  // =========================================================================
  const EDITOR_UI = {
    active: false,
    data: null,        // snapshot { rows, pointTypes, projectName } — ENTRY snapshot
                       // (staged editing: the DOM no longer changes per op, so
                       // position-based card mapping stays valid all session)
    stagedPrev: null,  // most recent staged snapshot (overlay bookkeeping only)
    stagedAdds: [],    // [{id,title}] choices added while staging (review chip)
    stagedChipEl: null,
    stagedPanelEl: null,
    selection: null,   // { objId }
    reqCounter: 0,
    pending: new Map(),
    layerEl: null,
    selBoxEl: null,
    toolbarEl: null,
    toggleBtn: null,
    rafId: 0,
    clickHandler: null,
    keyHandler: null,
    rowBars: [],
    observer: null,
    observerTimer: 0,
    dragState: null,   // active drag & drop session (Phase 3)
  };
  const editorCardIndex = new Map();  // objId -> card element
  const editorElIndex = new Map();    // card element -> objId

  const EDITOR_SEL = {
    rowWrapper: '.project-row-wrapper',
    rowHeader: '.row-header',
    cardGrid: '.items-container > .row',
    card: '.project-obj',
    cardTitle: '.obj-title',
  };
  // Mirrors the viewer's ObjectSizes map (app/components/viewer/style/sizes.ts).
  const EDITOR_WIDTHS = [
    ['col-12', 'Full width'], ['col-sm-11', '11/12'], ['col-sm-10', '10/12'],
    ['col-sm-9', '9/12'], ['col-sm-8', '8/12'], ['col-sm-7', '7/12'],
    ['col-sm-6', 'Half'], ['col-sm-5', '5/12'], ['col-md-4', 'Third'],
    ['col-md-3', 'Quarter'], ['w-20', 'Wide (w-20)'], ['col-lg-2', 'Sixth'],
    ['w-14', 'w-14'], ['w-12', 'w-12'], ['w-11', 'w-11'], ['w-10', 'w-10'],
    ['w-9', 'w-9'], ['col-xl-1', 'Twelfth'],
  ];

  function editorSend(command, payload) {
    window.postMessage({ target: 'WORM_CYOA_PAGE_SCRIPT', command, payload }, '*');
  }

  function editorRequest(command, payload = {}) {
    return new Promise((resolve) => {
      const reqId = 'er' + (++EDITOR_UI.reqCounter);
      EDITOR_UI.pending.set(reqId, resolve);
      editorSend(command, { ...payload, reqId });
      setTimeout(() => {
        if (EDITOR_UI.pending.has(reqId)) {
          EDITOR_UI.pending.delete(reqId);
          resolve(null);
        }
      }, 8000);
    });
  }

  function editorResolve(reqId, value) {
    if (reqId && EDITOR_UI.pending.has(reqId)) {
      const resolve = EDITOR_UI.pending.get(reqId);
      EDITOR_UI.pending.delete(reqId);
      resolve(value);
    }
  }

  // The editor toggle is only offered on the intended CYOA viewer sites, so it
  // never appears on unrelated websites the extension's content scripts touch.
  // (Custom-choice injection still runs everywhere it can; this gate is
  // editor-UI-only.)
  const EDITOR_URL_ALLOWLIST = [
    { host: 'cyoa.ltouroumov.ch', port: '', pathPrefix: '/' },
    { host: 'ltouroumov.github.io', port: '', pathPrefix: '/cyoa-editor/' },
    { host: 'localhost', port: '8123', pathPrefix: '/viewer/' },   // local dev harness
    { host: '127.0.0.1', port: '8123', pathPrefix: '/viewer/' },
  ];

  function isEditorAllowedLocation() {
    try {
      const u = new URL(window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase();
      const path = u.pathname || '/';
      return EDITOR_URL_ALLOWLIST.some(e =>
        host === e.host &&
        u.port === e.port &&
        (path === e.pathPrefix || path.startsWith(e.pathPrefix))
      );
    } catch (err) {
      return false;
    }
  }

  function ensureEditorToggle() {
    if (!isEditorAllowedLocation()) return;
    if (document.getElementById('worm-edit-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'worm-edit-toggle';
    btn.className = 'worm-editor-ui';
    btn.type = 'button';
    btn.textContent = 'Edit CYOA';
    btn.title = 'Toggle the interactive editor (Ctrl+E)';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      editorSetMode(!EDITOR_UI.active);
    });
    document.body.appendChild(btn);
    EDITOR_UI.toggleBtn = btn;

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
        e.preventDefault();
        editorSetMode(!EDITOR_UI.active);
      }
    });
  }

  function editorSetMode(enabled) {
    // The staged-vs-live editing mode is a user setting (popup → Settings);
    // read it fresh on every editor entry so a popup toggle takes effect on
    // the next Edit CYOA click without any extra sync plumbing.
    const sendWith = (staged) => editorSend('EDITOR_SET_MODE', { enabled, staged });
    chrome.storage.local.get('editorStaged')
      .then((res) => sendWith(res.editorStaged !== false)) // default: staged
      .catch(() => sendWith(true));
  }

  function editorHandleMode(data) {
    const enabled = !!(data && data.enabled);
    if (enabled === EDITOR_UI.active) {
      if (enabled && data && data.snapshot) { EDITOR_UI.data = data.snapshot; editorIndexCards(); }
      return;
    }
    EDITOR_UI.active = enabled;
    document.body.classList.toggle('worm-edit-mode', enabled);
    if (EDITOR_UI.toggleBtn) {
      EDITOR_UI.toggleBtn.classList.toggle('active', enabled);
      EDITOR_UI.toggleBtn.textContent = enabled ? '✓ Done Editing' : 'Edit CYOA';
    }
    if (enabled) {
      if (data && data.snapshot) EDITOR_UI.data = data.snapshot;
      EDITOR_UI.stagedPrev = EDITOR_UI.data; // baseline for overlay bookkeeping
      editorEnter();
      showToast('Editor on — click a choice to select it. Ctrl+E to exit.');
    } else {
      editorExit();
    }
  }

  function editorHandleDataChanged(data) {
    if (!data) return;
    if (EDITOR_UI.dragState) editorEndDrag(false); // card geometry is about to change
    // Staged editing: ops no longer touch the live DOM, so EDITOR_UI.data must
    // stay the ENTRY snapshot (position-based card mapping depends on it).
    // Dialogs read current object state via EDITOR_OBJECT; stagedPrev tracks
    // the staged state purely for overlay rowOrder bookkeeping.
    const prevData = EDITOR_UI.stagedPrev || EDITOR_UI.data;
    if (data.op && data.snapshot) overlayApplyOp(data, prevData);
    if (data.snapshot) EDITOR_UI.stagedPrev = data.snapshot;
    // Staged additions bookkeeping (review chip in the editor UI).
    if ((data.opType === 'addObject' || data.opType === 'duplicateObject') && data.extra && data.extra.object) {
      EDITOR_UI.stagedAdds.push({ id: data.extra.object.id, title: data.extra.object.title || data.extra.object.id });
    }
    if (data.opType === 'deleteObjects' && Array.isArray(data.deletedIds)) {
      const delIds = new Set(data.deletedIds);
      EDITOR_UI.stagedAdds = EDITOR_UI.stagedAdds.filter(a => !delIds.has(a.id));
    }
    editorUpdateStagedIndicator();
    // Storage bookkeeping must run even when the editor UI is off (e.g. the
    // last op before an exit, or broadcasts racing the toggle).
    if (data.opType === 'deleteObjects' && Array.isArray(data.deletedIds) && data.deletedIds.length > 0) {
      editorPurgeDeletedCustomChoices(data.deletedIds);
    } else if ((data.opType === 'duplicateObject' || data.opType === 'addObject') && data.extra && data.extra.object) {
      editorTrackNewChoice(data.extra.object);
    } else if (data.opType === 'updateObject' && data.op && data.op.objId && data.op.patch) {
      editorSyncUpdatedChoice(data.op.objId, data.op.patch);
    }
    if (!EDITOR_UI.active) return;
    const keep = EDITOR_UI.selection && EDITOR_UI.selection.objId;
    if (data.label) showToast(data.label);
    // Remounts settle in two steps (empty now, restore ~50ms later), so
    // re-index immediately AND after the DOM stabilizes.
    const reindex = () => {
      if (!EDITOR_UI.active) return;
      editorIndexCards();
      if (keep && editorCardIndex.has(keep)) {
        EDITOR_UI.selection = { objId: keep };
        editorUpdateSelectionPosition();
        if (EDITOR_UI.selBoxEl) EDITOR_UI.selBoxEl.style.display = 'block';
        if (EDITOR_UI.toolbarEl) EDITOR_UI.toolbarEl.style.display = 'flex';
      } else {
        editorDeselect();
      }
    };
    reindex();
    setTimeout(reindex, 120);
    setTimeout(reindex, 500);
  }

  async function editorPurgeDeletedCustomChoices(ids) {
    // Deleting custom choices must also remove them from saved storage,
    // otherwise the fetch interceptor would resurrect them on next load.
    try {
      if (!Array.isArray(ids) || ids.length === 0) return;
      const { customChoices = [] } = await chrome.storage.local.get('customChoices');
      const filtered = customChoices.filter(c => !ids.includes(c.id));
      if (filtered.length !== customChoices.length) {
        await chrome.storage.local.set({ customChoices: filtered });
      }
    } catch (err) {
      console.warn('[Worm V17 Mod] Failed to purge deleted custom choices:', err);
    }
  }

  async function editorTrackNewChoice(object) {
    // Choices created/duplicated in the editor are user-created: track them
    // like other custom choices so they persist across reloads.
    try {
      if (!object) return;
      const { customChoices = [] } = await chrome.storage.local.get('customChoices');
      if (!customChoices.some(c => c.id === object.id)) {
        customChoices.push(object);
        await chrome.storage.local.set({ customChoices });
      }
    } catch (err) {
      console.warn('[Worm V17 Mod] Failed to track duplicated choice:', err);
    }
  }

  async function editorSyncUpdatedChoice(objId, patch) {
    // Edits made in the editor (scores, requirements, size/width, ...) must
    // also land in the saved customChoices entry, otherwise any re-sync of
    // storage to the page (e.g. the popup's status ping → REQUEST_METADATA →
    // SYNC_CUSTOM_CHOICES) would overwrite the object with its stale pre-edit
    // copy and visibly revert the edit. The overlay already has the patch;
    // this keeps the two sources of truth consistent.
    try {
      if (!objId || !patch || typeof patch !== 'object') return;
      const { customChoices = [] } = await chrome.storage.local.get('customChoices');
      const idx = customChoices.findIndex(c => c.id === objId);
      if (idx < 0) return; // baseline (non-custom) object — overlay-only is correct
      customChoices[idx] = { ...customChoices[idx], ...JSON.parse(JSON.stringify(patch)) };
      await chrome.storage.local.set({ customChoices });
    } catch (err) {
      console.warn('[Worm V17 Mod] Failed to sync edited choice into storage:', err);
    }
  }

  // ==========================================================================
  // Editor overlay persistence (Phase 5): every engine op updates a compact
  // overlay record in chrome.storage; page-script re-applies it to the
  // freshly-fetched project.json on every page load (fetch-interceptor path,
  // with a live-store fallback if the sync arrives after load).
  // overlay = { version: 1, objects: {objId: patch}, deleted: [objId],
  //             rowPatches: {rowId: patch}, rowOrder: {rowId: [objId,...]} }
  // ==========================================================================
  function overlayRowIdOf(snapshot, objId) {
    if (!snapshot || !Array.isArray(snapshot.rows)) return null;
    for (const r of snapshot.rows) {
      if (Array.isArray(r.objects) && r.objects.some(o => o && o.id === objId)) return r.id;
    }
    return null;
  }

  function overlayIdsOfRow(snapshot, rowId) {
    const row = snapshot && Array.isArray(snapshot.rows) ? snapshot.rows.find(r => r.id === rowId) : null;
    return row && Array.isArray(row.objects) ? row.objects.map(o => o.id) : null;
  }

  function overlayApplyOp(data, prevData) {
    overlayQueue = overlayQueue.then(async () => {
      try {
        const op = data.op || {};
        const snapshot = data.snapshot || null;
        const res = await chrome.storage.local.get(EDITOR_OVERLAY_KEY);
        const raw = res[EDITOR_OVERLAY_KEY];
        const overlay = (raw && raw.version === 1) ? raw : { version: 1, objects: {}, deleted: [], rowPatches: {}, rowOrder: {} };
        overlay.objects = overlay.objects || {};
        overlay.deleted = Array.isArray(overlay.deleted) ? overlay.deleted : [];
        overlay.rowPatches = overlay.rowPatches || {};
        overlay.rowOrder = overlay.rowOrder || {};
        let touched = false;

        switch (op.type) {
          case 'updateObject':
            if (op.objId && op.patch) {
              overlay.objects[op.objId] = { ...(overlay.objects[op.objId] || {}), ...op.patch };
              touched = true;
            }
            break;
          case 'updateRow':
            if (op.rowId && op.patch) {
              overlay.rowPatches[op.rowId] = { ...(overlay.rowPatches[op.rowId] || {}), ...op.patch };
              touched = true;
            }
            break;
          case 'moveObject': {
            const destIds = overlayIdsOfRow(snapshot, op.toRowId);
            if (destIds) { overlay.rowOrder[op.toRowId] = destIds; touched = true; }
            // Source row (from the PRE-op snapshot) also needs its order refreshed.
            const srcRowId = overlayRowIdOf(prevData, op.objId);
            if (srcRowId && srcRowId !== op.toRowId) {
              const srcIds = overlayIdsOfRow(snapshot, srcRowId);
              if (srcIds) { overlay.rowOrder[srcRowId] = srcIds; touched = true; }
            }
            break;
          }
          case 'addObject':
          case 'duplicateObject': {
            const id = op.object && op.object.id;
            const rid = id ? overlayRowIdOf(snapshot, id) : null;
            if (rid) {
              const ids = overlayIdsOfRow(snapshot, rid);
              if (ids) { overlay.rowOrder[rid] = ids; touched = true; }
            }
            break;
          }
          case 'restoreObjects': {
            const ids = (op.entries || []).map(e => e.object && e.object.id).filter(Boolean);
            if (ids.length) {
              overlay.deleted = overlay.deleted.filter(id => !ids.includes(id));
              ids.forEach((id) => {
                const rid = overlayRowIdOf(snapshot, id);
                if (rid) {
                  const ordered = overlayIdsOfRow(snapshot, rid);
                  if (ordered) { overlay.rowOrder[rid] = ordered; }
                }
              });
              touched = true;
            }
            break;
          }
          case 'deleteObjects': {
            const ids = op.ids || [];
            if (ids.length) {
              overlay.deleted = Array.from(new Set([...overlay.deleted, ...ids]));
              ids.forEach((id) => { delete overlay.objects[id]; });
              Object.keys(overlay.rowOrder).forEach((rid) => {
                overlay.rowOrder[rid] = overlay.rowOrder[rid].filter(id => !ids.includes(id));
              });
              touched = true;
            }
            break;
          }
          default:
            return; // unknown ops don't touch the overlay
        }
        if (touched) {
          await chrome.storage.local.set({ [EDITOR_OVERLAY_KEY]: overlay });
        }
      } catch (err) {
        console.warn('[Worm V17 Mod] Failed to update editor overlay:', err);
      }
    });
  }

  function editorRowDataForWrapper(wrapper) {
    const wrappers = document.querySelectorAll(EDITOR_SEL.rowWrapper);
    const i = Array.prototype.indexOf.call(wrappers, wrapper);
    return i >= 0 && EDITOR_UI.data ? EDITOR_UI.data.rows[i] : null;
  }

  function editorIndexCards() {
    editorCardIndex.clear();
    editorElIndex.clear();
    if (!EDITOR_UI.data) return;
    const wrappers = document.querySelectorAll(EDITOR_SEL.rowWrapper);
    wrappers.forEach((wrapper, wIdx) => {
      const rowData = EDITOR_UI.data.rows[wIdx];
      if (!rowData) return;
      // The viewer renders cards in objects-array order (v-for), so POSITION is
      // the authoritative mapping — titles are only a sanity check.
      const cards = Array.from(wrapper.querySelectorAll(EDITOR_SEL.cardGrid + ' > .col > ' + EDITOR_SEL.card));
      if (cards.length > rowData.objects.length) {
        console.warn('[Worm Forge] Row "' + (rowData.title || rowData.id) + '": ' + cards.length + ' cards but only ' + rowData.objects.length + ' data objects (transient remount state) — extra cards unmapped.');
      }
      cards.forEach((card, cIdx) => {
        const obj = rowData.objects[cIdx];
        if (!obj) return;
        const domTitle = (card.querySelector(EDITOR_SEL.cardTitle)?.textContent || '').trim();
        if (obj.title && domTitle && obj.title !== domTitle) {
          console.warn('[Worm Forge] Title mismatch (info only) row "' + (rowData.title || rowData.id) + '": data="' + obj.title + '" dom="' + domTitle + '"');
        }
        editorCardIndex.set(obj.id, card);
        editorElIndex.set(card, obj.id);
        editorEnsureIdBadge(card, obj.id);
      });
    });
  }

  function editorObjIdForElement(el) {
    let node = el;
    while (node && node !== document.body) {
      if (editorElIndex.has(node)) return editorElIndex.get(node);
      node = node.parentElement;
    }
    return null;
  }

  function editorCopyText(text) {
    return new Promise((resolve) => {
      const done = (ok) => resolve(!!ok);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => done(true)).catch(() => done(false));
        return;
      }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        done(document.execCommand('copy'));
        ta.remove();
      } catch (err) {
        done(false);
      }
    });
  }

  // Edit mode shows each choice's data id on the card (top-right). Click = copy.
  // The badge lives inside the (viewer-owned) card element; it is (re)created on
  // every index pass so remounts and id remaps stay correct, and removed on exit.
  function editorEnsureIdBadge(card, objId) {
    if (!card || !objId) return;
    let badge = card.querySelector(':scope > .worm-obj-id-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'worm-obj-id-badge';
      badge.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = badge.dataset.objId || '';
        const ok = await editorCopyText(id);
        showToast(ok ? 'Choice ID copied: ' + id : 'Copy failed — ID: ' + id);
      });
      card.appendChild(badge);
      if (getComputedStyle(card).position === 'static') {
        card.style.position = 'relative';
        card.dataset.wormPosRel = '1';
      }
    }
    if (badge.dataset.objId !== objId) {
      badge.dataset.objId = objId;
      badge.textContent = objId.length > 22 ? objId.slice(0, 20) + '…' : objId;
      badge.title = 'Choice ID — click to copy: ' + objId;
    }
  }

  function editorRemoveIdBadges() {
    document.querySelectorAll('.worm-obj-id-badge').forEach((badge) => {
      const card = badge.parentElement;
      badge.remove();
      if (card && card.dataset && card.dataset.wormPosRel === '1') {
        card.style.position = '';
        delete card.dataset.wormPosRel;
      }
    });
  }

  function editorEnter() {
    const layer = document.createElement('div');
    layer.id = 'worm-editor-layer';
    layer.className = 'worm-editor-ui';
    const selBox = document.createElement('div');
    selBox.className = 'worm-sel-box';
    selBox.style.display = 'none';
    const toolbar = document.createElement('div');
    toolbar.className = 'worm-sel-toolbar';
    toolbar.style.display = 'none';
    toolbar.innerHTML = `
      <button type="button" data-act="edit" title="Edit this choice">✎ Edit</button>
      <button type="button" data-act="duplicate" title="Duplicate this choice">⧉</button>
      <button type="button" data-act="drag" class="worm-drag-handle" title="Drag to move this choice — hold, move, release">⠿</button>
      <button type="button" data-act="delete" title="Delete this choice (Del)">🗑</button>`;
    toolbar.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (!act || !EDITOR_UI.selection) return;
      if (act === 'edit') openChoiceModal({ objId: EDITOR_UI.selection.objId });
      else if (act === 'duplicate') editorDuplicate(EDITOR_UI.selection.objId);
      else if (act === 'delete') editorDelete(EDITOR_UI.selection.objId);
      // 'drag' is handled via pointer events, not click.
    });
    toolbar.addEventListener('pointerdown', (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (act !== 'drag' || !EDITOR_UI.selection) return;
      e.preventDefault();
      e.stopPropagation();
      editorBeginDrag(e);
    });
    layer.appendChild(selBox);
    layer.appendChild(toolbar);

    // Staged-changes review chip: visible once something was added while
    // staging. Click → review panel (edit/remove staged additions). Everything
    // becomes visible on the page only at "Done Editing".
    const stagedChip = document.createElement('div');
    stagedChip.className = 'worm-staged-chip worm-editor-ui';
    stagedChip.style.display = 'none';
    stagedChip.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = EDITOR_UI.stagedPanelEl;
      if (!panel) return;
      const showing = panel.style.display !== 'none';
      panel.style.display = showing ? 'none' : 'block';
      if (!showing) editorRenderStagedPanel();
    });
    const stagedPanel = document.createElement('div');
    stagedPanel.className = 'worm-staged-panel worm-editor-ui';
    stagedPanel.style.display = 'none';
    stagedPanel.addEventListener('click', (e) => e.stopPropagation());
    layer.appendChild(stagedChip);
    layer.appendChild(stagedPanel);
    EDITOR_UI.stagedChipEl = stagedChip;
    EDITOR_UI.stagedPanelEl = stagedPanel;

    document.body.appendChild(layer);
    EDITOR_UI.layerEl = layer;
    EDITOR_UI.selBoxEl = selBox;
    EDITOR_UI.toolbarEl = toolbar;

    editorIndexCards();
    editorAttachRowBars();

    // The viewer's CollectionLoader re-adds cards INCREMENTALLY after a
    // remount, so a fixed-delay reindex can miss late batches. Watch the DOM
    // instead: whenever card elements change, re-index (debounced).
    EDITOR_UI.observer = new MutationObserver(() => {
      if (!EDITOR_UI.active) return;
      clearTimeout(EDITOR_UI.observerTimer);
      EDITOR_UI.observerTimer = setTimeout(() => {
        if (!EDITOR_UI.active) return;
        editorIndexCards();
        if (EDITOR_UI.selection) {
          if (editorCardIndex.has(EDITOR_UI.selection.objId)) {
            editorUpdateSelectionPosition();
            if (EDITOR_UI.selBoxEl) EDITOR_UI.selBoxEl.style.display = 'block';
            if (EDITOR_UI.toolbarEl) EDITOR_UI.toolbarEl.style.display = 'flex';
          } else {
            editorDeselect();
          }
        }
      }, 150);
    });
    EDITOR_UI.observer.observe(document.body, { childList: true, subtree: true });

    EDITOR_UI.clickHandler = (e) => editorOnCaptureClick(e);
    EDITOR_UI.keyHandler = (e) => editorOnKeyDown(e);
    document.addEventListener('click', EDITOR_UI.clickHandler, true);
    document.addEventListener('keydown', EDITOR_UI.keyHandler, true);

    const frame = () => {
      if (!EDITOR_UI.active) return;
      editorUpdateSelectionPosition();
      EDITOR_UI.rafId = requestAnimationFrame(frame);
    };
    EDITOR_UI.rafId = requestAnimationFrame(frame);
  }

  function editorExit() {
    if (EDITOR_UI.rafId) cancelAnimationFrame(EDITOR_UI.rafId);
    if (EDITOR_UI.observer) { EDITOR_UI.observer.disconnect(); EDITOR_UI.observer = null; }
    clearTimeout(EDITOR_UI.observerTimer);
    if (EDITOR_UI.dragState) editorEndDrag(false);
    if (EDITOR_UI.clickHandler) document.removeEventListener('click', EDITOR_UI.clickHandler, true);
    if (EDITOR_UI.keyHandler) document.removeEventListener('keydown', EDITOR_UI.keyHandler, true);
    editorRemoveRowBars();
    editorRemoveIdBadges();
    if (EDITOR_UI.layerEl) EDITOR_UI.layerEl.remove();
    EDITOR_UI.layerEl = null;
    EDITOR_UI.selBoxEl = null;
    EDITOR_UI.toolbarEl = null;
    EDITOR_UI.stagedChipEl = null;
    EDITOR_UI.stagedPanelEl = null;
    EDITOR_UI.stagedPrev = null;
    EDITOR_UI.stagedAdds = [];
    EDITOR_UI.selection = null;
    editorCardIndex.clear();
    editorElIndex.clear();
  }

  function editorAttachRowBars() {
    editorRemoveRowBars();
    if (!EDITOR_UI.data) return;
    document.querySelectorAll(EDITOR_SEL.rowWrapper).forEach((wrapper) => {
      const rowData = editorRowDataForWrapper(wrapper);
      const header = wrapper.querySelector(EDITOR_SEL.rowHeader);
      if (!header || !rowData) return;
      const bar = document.createElement('div');
      bar.className = 'worm-row-bar worm-editor-ui';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = '＋';
      addBtn.title = 'Add a choice to this row';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openChoiceModal({ preselectedRowId: rowData.id });
      });
      bar.appendChild(addBtn);
      header.appendChild(bar);
      EDITOR_UI.rowBars.push(bar);
    });
  }

  function editorRemoveRowBars() {
    EDITOR_UI.rowBars.forEach(bar => bar.remove());
    EDITOR_UI.rowBars = [];
  }

  // Staged-changes review UI: chip shows the count of staged additions; the
  // panel lists them (click = edit in place, ✕ = remove from staging).
  function editorUpdateStagedIndicator() {
    if (!EDITOR_UI.stagedChipEl) return;
    const n = EDITOR_UI.stagedAdds.length;
    EDITOR_UI.stagedChipEl.style.display = n > 0 ? 'block' : 'none';
    if (n > 0) EDITOR_UI.stagedChipEl.textContent = n + ' staged — click to review';
    if (EDITOR_UI.stagedPanelEl && EDITOR_UI.stagedPanelEl.style.display !== 'none') editorRenderStagedPanel();
  }

  function editorRenderStagedPanel() {
    const panel = EDITOR_UI.stagedPanelEl;
    if (!panel) return;
    panel.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'worm-staged-title';
    title.textContent = 'Staged additions (applied on Done Editing)';
    panel.appendChild(title);
    if (!EDITOR_UI.stagedAdds.length) {
      const empty = document.createElement('div');
      empty.className = 'worm-staged-empty';
      empty.textContent = 'No staged additions.';
      panel.appendChild(empty);
      return;
    }
    EDITOR_UI.stagedAdds.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'worm-staged-item';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'worm-staged-open';
      open.textContent = a.title;
      open.title = 'Edit this staged choice';
      open.addEventListener('click', (e) => {
        e.stopPropagation();
        openChoiceModal({ objId: a.id });
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'worm-staged-del';
      del.textContent = '✕';
      del.title = 'Remove this staged choice';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        editorDelete(a.id);
      });
      row.appendChild(open);
      row.appendChild(del);
      panel.appendChild(row);
    });
  }

  function editorSelect(objId) {
    EDITOR_UI.selection = { objId };
    editorUpdateSelectionPosition();
    if (EDITOR_UI.selBoxEl) EDITOR_UI.selBoxEl.style.display = 'block';
    if (EDITOR_UI.toolbarEl) EDITOR_UI.toolbarEl.style.display = 'flex';
  }

  function editorDeselect() {
    EDITOR_UI.selection = null;
    if (EDITOR_UI.selBoxEl) EDITOR_UI.selBoxEl.style.display = 'none';
    if (EDITOR_UI.toolbarEl) EDITOR_UI.toolbarEl.style.display = 'none';
  }

  function editorUpdateSelectionPosition() {
    if (!EDITOR_UI.selection || !EDITOR_UI.selBoxEl || !EDITOR_UI.toolbarEl) return;
    const card = editorCardIndex.get(EDITOR_UI.selection.objId);
    if (!card || !card.isConnected) {
      editorDeselect();
      return;
    }
    const r = card.getBoundingClientRect();
    const box = EDITOR_UI.selBoxEl;
    box.style.left = (r.left - 3) + 'px';
    box.style.top = (r.top - 3) + 'px';
    box.style.width = (r.width + 6) + 'px';
    box.style.height = (r.height + 6) + 'px';
    const tb = EDITOR_UI.toolbarEl;
    const above = r.top > 56;
    tb.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px';
    tb.style.top = (above ? r.top - 44 : r.bottom + 8) + 'px';
  }

  // ==========================================================================
  // Drag & drop (Phase 3): pointer-based move of the selected choice.
  // Press ⠿ on the selection toolbar → a ghost of the card follows the pointer
  // (transform-only, layout-free), a purple insertion indicator shows the drop
  // slot via midpoint hit-testing between cards, edges auto-scroll while
  // dragging, Esc cancels. Drop emits moveObject whose index contract is the
  // insertion position AFTER removal from the source row.
  // ==========================================================================
  function editorBeginDrag(e) {
    if (EDITOR_UI.dragState) return;
    if (document.getElementById('worm-modal-overlay') || document.getElementById('worm-confirm-overlay')) return;
    const objId = EDITOR_UI.selection.objId;
    const card = editorCardIndex.get(objId);
    if (!card || !card.isConnected) return;
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.querySelectorAll('.worm-obj-id-badge').forEach((b) => b.remove());
    ghost.classList.add('worm-drag-ghost');
    ghost.style.width = rect.width + 'px';
    EDITOR_UI.layerEl.appendChild(ghost);
    const indicator = document.createElement('div');
    indicator.className = 'worm-drop-indicator';
    EDITOR_UI.layerEl.appendChild(indicator);
    document.body.classList.add('worm-dragging');
    const state = {
      objId,
      ghost,
      indicator,
      hintRow: null,
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      target: null,
      raf: 0,
      onMove: null, onUp: null, onKey: null,
    };
    EDITOR_UI.dragState = state;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* capture optional */ }
    state.onMove = (ev) => {
      state.lastX = ev.clientX;
      state.lastY = ev.clientY;
      if (Math.abs(ev.clientX - state.startX) + Math.abs(ev.clientY - state.startY) > 3) state.moved = true;
    };
    state.onUp = () => editorEndDrag(true);
    state.onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); editorEndDrag(false); }
    };
    window.addEventListener('pointermove', state.onMove, true);
    window.addEventListener('pointerup', state.onUp, true);
    window.addEventListener('pointercancel', state.onUp, true);
    window.addEventListener('keydown', state.onKey, true);
    const frame = () => {
      if (EDITOR_UI.dragState !== state) return;
      editorDragFrame(state);
      state.raf = requestAnimationFrame(frame);
    };
    state.raf = requestAnimationFrame(frame);
  }

  function editorDragFrame(state) {
    // Auto-scroll near viewport edges (rate scales with edge proximity).
    const edge = 28;
    let scrollDy = 0;
    if (state.lastY < edge) scrollDy = -Math.ceil((edge - state.lastY) * 0.6);
    else if (state.lastY > window.innerHeight - edge) scrollDy = Math.ceil((state.lastY - (window.innerHeight - edge)) * 0.6);
    if (scrollDy) window.scrollBy(0, scrollDy);
    // Ghost follows the pointer via transform (never affects layout).
    state.ghost.style.transform = 'translate(' + (state.lastX - state.offsetX) + 'px, ' + (state.lastY - state.offsetY) + 'px) scale(1.03) rotate(1.2deg)';
    // Insertion point hit-test.
    const hit = editorDragHitTest(state.lastX, state.lastY, state.objId);
    state.target = hit;
    if (hit) {
      state.indicator.style.display = 'block';
      state.indicator.style.left = hit.ix + 'px';
      state.indicator.style.top = hit.iy + 'px';
      state.indicator.style.height = hit.ih + 'px';
      if (state.hintRow !== hit.rowInner) {
        if (state.hintRow) state.hintRow.classList.remove('worm-drop-row-hint');
        if (hit.rowInner) hit.rowInner.classList.add('worm-drop-row-hint');
        state.hintRow = hit.rowInner;
      }
    } else {
      state.indicator.style.display = 'none';
      if (state.hintRow) { state.hintRow.classList.remove('worm-drop-row-hint'); state.hintRow = null; }
    }
  }

  function editorDragHitTest(x, y, objId) {
    const wrappers = document.querySelectorAll(EDITOR_SEL.rowWrapper);
    let best = null;
    wrappers.forEach((wrapper) => {
      const rowInner = wrapper.querySelector('.project-row');
      if (!rowInner || rowInner.classList.contains('hidden')) return;
      const rect = wrapper.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom < -80 || rect.top > window.innerHeight + 80) return;
      const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
      if (dy > 140) return;
      const cards = Array.from(wrapper.querySelectorAll(EDITOR_SEL.cardGrid + ' > .col > ' + EDITOR_SEL.card));
      let candidate = null;
      if (cards.length === 0) {
        const grid = wrapper.querySelector(EDITOR_SEL.cardGrid) || rowInner;
        const gridRect = grid.getBoundingClientRect();
        candidate = {
          rowWrapper: wrapper, rowInner,
          visualIndex: 0,
          ix: gridRect.left + 6,
          iy: gridRect.top + 4,
          ih: Math.max(48, Math.min(gridRect.height - 8, 160)),
          score: dy,
        };
      } else {
        // Nearest card by center distance (robust for wrapped grids).
        let nearest = null;
        let nearestDist = Infinity;
        cards.forEach((c) => {
          const cr = c.getBoundingClientRect();
          const d = Math.hypot(x - (cr.left + cr.width / 2), y - (cr.top + cr.height / 2));
          if (d < nearestDist) { nearestDist = d; nearest = { card: c, rect: cr }; }
        });
        if (!nearest) return;
        const nearestIdx = cards.indexOf(nearest.card);
        const insertBefore = x < nearest.rect.left + nearest.rect.width / 2;
        let visualIndex = nearestIdx + (insertBefore ? 0 : 1);
        if (visualIndex < 0) visualIndex = 0;
        if (visualIndex > cards.length) visualIndex = cards.length;
        const gap = 9;
        candidate = {
          rowWrapper: wrapper, rowInner,
          visualIndex,
          ix: insertBefore ? nearest.rect.left - gap : nearest.rect.right + gap,
          iy: nearest.rect.top + 2,
          ih: nearest.rect.height - 4,
          score: dy + nearestDist * 0.001,
        };
      }
      if (!best || candidate.score < best.score) best = candidate;
    });
    if (!best) return null;
    // Resolve the target row positionally (DOM wrapper order == data row order).
    const wIdx = Array.prototype.indexOf.call(wrappers, best.rowWrapper);
    const rowData = EDITOR_UI.data ? EDITOR_UI.data.rows[wIdx] : null;
    if (!rowData) return null;
    // Locate the dragged object's source position for the after-removal
    // contract (and same-row no-op detection).
    let srcRow = null;
    let srcObjIdx = -1;
    EDITOR_UI.data.rows.forEach((r) => {
      if (srcObjIdx >= 0) return;
      const oi = (r.objects || []).findIndex((o) => o.id === objId);
      if (oi >= 0) { srcRow = r; srcObjIdx = oi; }
    });
    let index = best.visualIndex;
    let noop = false;
    if (srcRow && srcRow.id === rowData.id) {
      if (best.visualIndex > srcObjIdx) index = best.visualIndex - 1;
      if (index === srcObjIdx) noop = true;
    }
    return { rowId: rowData.id, rowInner: best.rowInner, index, noop, ix: best.ix, iy: best.iy, ih: best.ih };
  }

  function editorEndDrag(commit) {
    const state = EDITOR_UI.dragState;
    if (!state) return;
    EDITOR_UI.dragState = null;
    cancelAnimationFrame(state.raf);
    window.removeEventListener('pointermove', state.onMove, true);
    window.removeEventListener('pointerup', state.onUp, true);
    window.removeEventListener('pointercancel', state.onUp, true);
    window.removeEventListener('keydown', state.onKey, true);
    state.ghost.remove();
    state.indicator.remove();
    if (state.hintRow) state.hintRow.classList.remove('worm-drop-row-hint');
    document.body.classList.remove('worm-dragging');
    const target = commit ? state.target : null;
    if (target && !target.noop && target.rowId) {
      editorRequest('EDITOR_OP', {
        op: { type: 'moveObject', objId: state.objId, toRowId: target.rowId, index: target.index },
      });
    }
  }

  function editorOnCaptureClick(e) {
    if (!EDITOR_UI.active) return;
    if (e.target.closest('.worm-editor-ui, #worm-editor-layer, #worm-modal-overlay, #worm-confirm-overlay')) return;
    if (e.target.closest('.worm-obj-id-badge')) return; // badge click = copy ID (its own handler)
    const cardEl = e.target.closest(EDITOR_SEL.card);
    if (cardEl) {
      let objId = editorObjIdForElement(cardEl);
      if (!objId) {
        // The card was re-created by a remount after our last reindex —
        // rebuild the index on the spot and retry the lookup.
        editorIndexCards();
        objId = editorObjIdForElement(cardEl);
      }
      if (objId) {
        e.preventDefault();
        e.stopPropagation();
        editorSelect(objId);
      } else {
        // Still unmapped: dump diagnostics so the console tells us exactly why.
        const wrapper = cardEl.closest(EDITOR_SEL.rowWrapper);
        const wIdx = wrapper ? Array.prototype.indexOf.call(document.querySelectorAll(EDITOR_SEL.rowWrapper), wrapper) : -1;
        const cardsInRow = wrapper ? wrapper.querySelectorAll(EDITOR_SEL.cardGrid + ' > .col > ' + EDITOR_SEL.card).length : -1;
        const cardIdx = wrapper ? Array.prototype.indexOf.call(wrapper.querySelectorAll(EDITOR_SEL.cardGrid + ' > .col > ' + EDITOR_SEL.card), cardEl) : -1;
        const rowData = EDITOR_UI.data && wIdx >= 0 ? EDITOR_UI.data.rows[wIdx] : null;
        console.warn('[Worm Forge DIAG] Click unmapped.', {
          cardTitle: (cardEl.querySelector('.obj-title')?.textContent || '').trim(),
          wrapperIndex: wIdx, cardIndex: cardIdx, cardsInRow,
          dataRowExists: !!rowData,
          dataObjects: rowData ? rowData.objects.length : -1,
          dataTitles: rowData ? rowData.objects.map(o => o.title) : null,
          indexSize: editorCardIndex.size
        });
      }
      return;
    }
    if (EDITOR_UI.selection) editorDeselect();
  }

  function editorOnKeyDown(e) {
    if (!EDITOR_UI.active) return;
    if (EDITOR_UI.dragState) return; // drag session handles its own keys (Esc)
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
    if (e.key === 'Escape') {
      if (EDITOR_UI.selection) editorDeselect();
      return;
    }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && EDITOR_UI.selection) {
      e.preventDefault();
      editorDelete(EDITOR_UI.selection.objId);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      editorRequest('EDITOR_UNDO');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'Z' || e.key === 'z')))) {
      e.preventDefault();
      editorRequest('EDITOR_REDO');
    }
  }

  async function editorDuplicate(objId) {
    await editorRequest('EDITOR_OP', { op: { type: 'duplicateObject', objId } });
  }

  async function editorDelete(objId) {
    const ok = await wormConfirm('Delete this choice? You can undo with Ctrl+Z.');
    if (!ok) return;
    await editorRequest('EDITOR_OP', { op: { type: 'deleteObjects', ids: [objId] } });
  }

  function wormConfirm(message) {
    return new Promise((resolve) => {
      if (document.getElementById('worm-confirm-overlay')) { resolve(false); return; }
      const overlay = document.createElement('div');
      overlay.id = 'worm-confirm-overlay';
      overlay.className = 'worm-editor-ui';
      const dialog = document.createElement('div');
      dialog.className = 'worm-confirm-dialog';
      const p = document.createElement('p');
      p.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'worm-confirm-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'worm-btn-secondary';
      cancelBtn.textContent = 'Cancel';
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'worm-btn-danger';
      deleteBtn.textContent = 'Delete';
      actions.appendChild(cancelBtn);
      actions.appendChild(deleteBtn);
      dialog.appendChild(p);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      const done = (val) => { overlay.remove(); resolve(val); };
      cancelBtn.addEventListener('click', () => done(false));
      deleteBtn.addEventListener('click', () => done(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
      document.body.appendChild(overlay);
      deleteBtn.focus();
    });
  }

  // Shared choice dialog — used for BOTH "Edit Choice" (editor toolbar) and
  // "Add Choice" (row ＋ button). Field parity is intentional: add simply starts
  // from a blank object and adds a Destination selector; edit additionally shows
  // the Section Activation editor (needs the choice's id to exist first).
  async function openChoiceModal(opts) {
    const isAdd = !opts || !opts.objId;
    const preselectedRowId = (opts && opts.preselectedRowId) || '';
    let resp = null;
    let obj;
    if (isAdd) {
      if (!EDITOR_UI.data) { showToast('Editor data not ready — reopen the editor.'); return; }
      obj = {
        title: '', text: '', image: '', objectWidth: '',
        scores: [], requireds: [],
        isNotSelectable: false, isSelectableMultiple: false,
        numMultipleTimesPluss: 1, numMultipleTimesMinus: 0,
        activateThisChoice: '', deactivateThisChoice: '',
        activateOtherChoice: false, deactivateOtherChoice: false,
        isVisible: true,
      };
    } else {
      resp = await editorRequest('EDITOR_GET_OBJECT', { objId: opts.objId });
      if (!resp || !resp.object) { showToast('Could not load that choice.'); return; }
      obj = resp.object;
    }
    if (document.getElementById('worm-modal-overlay')) return;
    const objId = isAdd ? '' : opts.objId;
    const original = JSON.parse(JSON.stringify(obj));
    const pointTypes = (EDITOR_UI.data && EDITOR_UI.data.pointTypes) || [];
    const allRowsList = (EDITOR_UI.data && EDITOR_UI.data.rows) || [];
    const esc = escapeHtml;
    const isEmbeddedImage = !isAdd && typeof obj.image === 'string' && obj.image.startsWith('data:');
    const imageShown = isEmbeddedImage ? '' : (obj.image || '');
    const rowWidth = (resp && resp.rowWidth) || '';
    const widthOpts = (() => {
      const opts = [];
      const rowLabel = 'Row default' + (rowWidth ? ' (' + rowWidth + ')' : '');
      opts.push('<option value=""' + ((original.objectWidth || '') === '' ? ' selected' : '') + '>' + esc(rowLabel) + '</option>');
      const known = new Set(['']);
      for (const [v, label] of EDITOR_WIDTHS) {
        known.add(v);
        opts.push('<option value="' + v + '"' + (v === (original.objectWidth || '') ? ' selected' : '') + '>' + esc(label) + '</option>');
      }
      if (original.objectWidth && !known.has(original.objectWidth)) {
        opts.push('<option value="' + esc(original.objectWidth) + '" selected>Current (' + esc(original.objectWidth) + ')</option>');
      }
      return opts.join('');
    })();
    const scoreRowHtml = (s, origIdx) => {
      const s2 = s || {};
      const val = parseInt(s2.value, 10) || 0;
      const isGain = val < 0 || s2.beforeText === 'Gain:';
      const amt = Math.abs(val) || (origIdx >= 0 ? 0 : 5);
      const eff = isGain ? 'gain' : 'cost';
      const ptOptions = (pointTypes.length > 0 ? pointTypes : [{ id: 'points', name: 'Points' }]).map(p =>
        `<option value="${esc(p.id)}"${p.id === s2.id ? ' selected' : ''}>${esc(p.name || p.id)}</option>`).join('');
      return `
        <div class="worm-score-edit" data-orig="${origIdx}">
          <select class="worm-form-select we-score-type">${ptOptions}</select>
          <div class="worm-segmented worm-seg-sm we-score-eff" role="group" aria-label="Effect">
            <button type="button" class="worm-seg-btn${eff === 'cost' ? ' is-active' : ''}" data-eff="cost">−</button>
            <button type="button" class="worm-seg-btn${eff === 'gain' ? ' is-active' : ''}" data-eff="gain">+</button>
          </div>
          <input type="number" class="worm-form-input we-score-amt" min="0" value="${amt}">
          <button type="button" class="worm-score-remove" title="Remove modifier">×</button>
        </div>`;
    };
    const scoreRowsHtml = (Array.isArray(original.scores) && original.scores.length > 0)
      ? original.scores.map((s, i) => scoreRowHtml(s, i)).join('')
      : '';

    // Section activation state (edit mode only): rows whose visibility
    // conditions reference this choice ({type:'id', reqId}). required=true →
    // row shows when this choice is picked; required=false → row hides.
    const actState = isAdd ? [] : (resp.activatedRows || []).map(a => {
      const requireds = a.requireds || [];
      let origIdx = -1;
      for (let i = 0; i < requireds.length; i++) {
        const t = requireds[i];
        if (t && t.type === 'id' && t.reqId === objId) { origIdx = i; break; }
      }
      return { rowId: a.id, title: a.title, required: !!a.required, requireds, isNew: false };
    });
    const removedActs = [];
    const rowsWithTerms = (resp && resp.rowsWithTerms) || [];

    // Requirement state (both modes): {type:'id'} terms on THIS choice gating
    // its own visibility on other choices being picked.
    const originalRequireds = Array.isArray(original.requireds) ? original.requireds : [];
    const reqState = originalRequireds
      .filter(t => t && t.type === 'id')
      .map(t => ({ term: JSON.parse(JSON.stringify(t)), required: !!t.required }));

    function choiceTitleFor(id) {
      for (const r of allRowsList) {
        for (const o of (r.objects || [])) {
          if (o.id === id) return o.title || id;
        }
      }
      return id;
    }

    // Non-id terms of the original requireds (points/multi conditions the UI
    // doesn't model) — preserved verbatim by both save paths.
    function keptOthersForAdd() {
      return originalRequireds.filter(t => !(t && t.type === 'id')).map(t => JSON.parse(JSON.stringify(t)));
    }

    const overlay = document.createElement('div');
    overlay.id = 'worm-modal-overlay';
    overlay.innerHTML = `
      <div id="worm-modal-dialog">
        <div class="worm-modal-header">
          <h3><span class="worm-modal-glyph">✎</span> ${isAdd ? 'Add Choice' : 'Edit Choice'} ${!isAdd ? `<span class="worm-id-chip" id="we-obj-id" title="Choice ID — click to copy">${esc(objId)}</span>` : ''}</h3>
          <button type="button" class="worm-modal-close-btn" id="we-close" title="Close">&times;</button>
        </div>
        <form id="we-form">
          <div class="worm-modal-body">
            ${isAdd ? `
            <div class="worm-form-group">
              <label for="we-dest">Destination</label>
              <select id="we-dest" class="worm-form-select">
                ${allRowsList.map(r => `<option value="${esc(r.id)}"${r.id === preselectedRowId ? ' selected' : ''}>${esc(r.title || r.id)} (${(r.objects || []).length} choices)</option>`).join('')}
              </select>
            </div>` : ''}
            <div class="worm-form-group">
              <label for="we-title">Choice Title</label>
              <input type="text" id="we-title" class="worm-form-input" value="${esc(original.title || '')}" required>
            </div>
            <div class="worm-form-group">
              <label for="we-text">Description</label>
              <textarea id="we-text" class="worm-form-textarea">${esc(original.text || '')}</textarea>
            </div>
            <div class="worm-form-grid2">
              <div class="worm-form-group">
                <label for="we-image">Image URL ${isEmbeddedImage ? '<span class="worm-label-soft">(embedded image kept unless replaced)</span>' : ''}</label>
                <input type="text" id="we-image" class="worm-form-input" value="${esc(imageShown)}" placeholder="https://example.com/image.webp">
              </div>
              <div class="worm-form-group">
                <label for="we-width">Card Width</label>
                <select id="we-width" class="worm-form-select">${widthOpts}</select>
              </div>
            </div>

            <div class="worm-form-group">
              <label>Point Modifiers</label>
              <div id="we-scores">${scoreRowsHtml}</div>
              <div class="worm-empty-hint" id="we-scores-hint"${scoreRowsHtml ? ' hidden' : ''}>No point modifiers on this choice — use “+ Add Modifier”.</div>
              <button type="button" id="we-add-score" class="worm-btn-ghost-sm worm-mt8">+ Add Modifier</button>
            </div>
            <div class="worm-form-group">
              <label>Requirements <span class="worm-label-soft">(this choice needs/is blocked by other choices)</span></label>
              <div id="we-req-rows"></div>
              <div class="worm-act-add worm-mt8">
                <select id="we-req-kind" class="worm-form-select">
                  <option value="required">Needs a choice</option>
                  <option value="incompatible">Blocked by a choice</option>
                </select>
                <input type="text" id="we-req-choice" class="worm-form-input" placeholder="choice id" autocomplete="off" spellcheck="false">
                <button type="button" id="we-req-add" class="worm-btn-ghost-sm">Add</button>
              </div>
            </div>
            ${!isAdd ? `
            <div class="worm-form-group">
              <label>Section Activation <span class="worm-label-soft">(rows gated by this choice)</span></label>
              <div id="we-act-rows"></div>
              <div class="worm-act-add worm-mt8">
                <select id="we-act-row" class="worm-form-select"></select>
                <select id="we-act-kind" class="worm-form-select">
                  <option value="required">Shows when picked</option>
                  <option value="incompatible">Hides when picked</option>
                </select>
                <button type="button" id="we-act-add" class="worm-btn-ghost-sm">Add</button>
              </div>
            </div>` : ''}
            <div class="worm-form-group">
              <label>Behavior</label>
              <div class="worm-check-grid">
                <label class="worm-check"><input type="checkbox" id="we-notsel"${original.isNotSelectable ? ' checked' : ''}><span>Not selectable</span></label>
                <label class="worm-check"><input type="checkbox" id="we-multi"${original.isSelectableMultiple ? ' checked' : ''}><span>Pick multiple times</span></label>
              </div>
              <div class="worm-form-grid2 worm-mt8" id="we-multi-limits"${original.isSelectableMultiple ? '' : ' hidden'}>
                <div class="worm-form-group">
                  <label for="we-maxpicks">Max picks</label>
                  <input type="number" id="we-maxpicks" class="worm-form-input" min="1" value="${esc(String(original.numMultipleTimesPluss ?? 1))}">
                </div>
                <div class="worm-form-group">
                  <label for="we-minpicks">Min picks</label>
                  <input type="number" id="we-minpicks" class="worm-form-input" min="0" value="${esc(String(original.numMultipleTimesMinus ?? 0))}">
                </div>
              </div>
              <div class="worm-form-grid2 worm-mt8">
                <div class="worm-form-group">
                  <label for="we-activatethis">Activates choice ids (comma-separated)</label>
                  <input type="text" id="we-activatethis" class="worm-form-input" value="${esc(original.activateThisChoice || '')}" placeholder="id1,id2,…">
                </div>
                <div class="worm-form-group">
                  <label for="we-deactivatethis">Deactivates choice ids (comma-separated)</label>
                  <input type="text" id="we-deactivatethis" class="worm-form-input" value="${esc(original.deactivateThisChoice || '')}" placeholder="id1,id2,…">
                </div>
              </div>
              <div class="worm-check-grid worm-mt8">
                <label class="worm-check"><input type="checkbox" id="we-actother"${original.activateOtherChoice ? ' checked' : ''}><span>When picked, activate the id above</span></label>
                <label class="worm-check"><input type="checkbox" id="we-deactother"${original.deactivateOtherChoice ? ' checked' : ''}><span>When picked, deactivate the id above</span></label>
              </div>
            </div>
          </div>
          <div class="worm-modal-footer">
            <button type="button" class="worm-btn-ghost-sm" id="we-reset">Reset</button>
            <span class="worm-footer-spacer"></span>
            <button type="button" class="worm-btn-secondary" id="we-cancel">Cancel</button>
            <button type="submit" class="worm-btn-primary">${isAdd ? 'Add to CYOA' : 'Save Changes'}</button>
          </div>
        </form>
      </div>`;

    const idChip = overlay.querySelector('#we-obj-id');
    if (idChip) idChip.addEventListener('click', async () => {
      const ok = await editorCopyText(objId);
      showToast(ok ? 'Choice ID copied: ' + objId : 'Copy failed — ID: ' + objId);
    });

    overlay.querySelector('#we-req-add').addEventListener('click', () => {
      const kindSel = overlay.querySelector('#we-req-kind');
      const choiceSel = overlay.querySelector('#we-req-choice');
      const reqId = choiceSel.value.trim();
      if (!reqId || reqState.some(e => e.term.reqId === reqId)) return;
      reqState.push({ term: buildRequirementTerm(kindSel.value === 'required'), required: kindSel.value === 'required' });
      const term = reqState[reqState.length - 1].term;
      term.reqId = reqId;
      choiceSel.value = '';
      renderReqRows();
    });

    function closeModal() { overlay.remove(); }

    function wireSegmented(container) {
      container.querySelectorAll('.worm-seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          container.querySelectorAll('.worm-seg-btn').forEach(b => b.classList.toggle('is-active', b === btn));
        });
      });
    }

    function scoreRowFromUi(row) {
      const origIdx = parseInt(row.dataset.orig, 10);
      const origScore = (origIdx >= 0 && Array.isArray(original.scores) && original.scores[origIdx]) || {};
      const ptId = row.querySelector('.we-score-type').value || 'points';
      const eff = row.querySelector('.we-score-eff .worm-seg-btn.is-active');
      const effect = eff ? eff.dataset.eff : 'cost';
      const amt = Math.abs(parseInt(row.querySelector('.we-score-amt').value, 10)) || 0;
      const pt = pointTypes.find(p => p.id === ptId);
      const abbr = abbreviatePointName(pt ? (pt.name || pt.id) : 'Points');
      // Preserve unknown/original fields (type, showScore, …) and overlay only
      // the UI-editable ones.
      return {
        ...origScore,
        id: ptId,
        value: effect === 'gain' ? String(-amt) : String(amt),
        beforeText: effect === 'gain' ? 'Gain:' : 'Cost:',
        afterText: abbr,
        requireds: Array.isArray(origScore.requireds) ? origScore.requireds : [],
      };
    }

    function buildPatch() {
      const patch = {};
      const title = overlay.querySelector('#we-title').value.trim();
      if (title !== (original.title || '')) patch.title = title;
      const text = overlay.querySelector('#we-text').value;
      if (text !== (original.text || '')) patch.text = text;
      const image = overlay.querySelector('#we-image').value.trim();
      if (!isEmbeddedImage && image !== (original.image || '')) {
        patch.image = image;
        patch.imageIsUrl = /^https?:\/\//i.test(image);
      }
      const width = overlay.querySelector('#we-width').value;
      if (width !== (original.objectWidth || '')) patch.objectWidth = width;

      const scoreRows = Array.from(overlay.querySelectorAll('.worm-score-edit'));
      const scores = scoreRows.map(scoreRowFromUi);
      if (JSON.stringify(scores) !== JSON.stringify(original.scores || [])) patch.scores = scores;

      // Requirements: rebuild this choice's {type:'id'} terms. Non-id terms are
      // kept untouched; id terms are diffed so unchanged entries emit nothing.
      const nextIds = reqState.map(e => e.term);
      const keptOthers = (Array.isArray(original.requireds) ? original.requireds : [])
        .filter(t => !(t && t.type === 'id'));
      const nextRequireds = keptOthers.concat(nextIds);
      if (stableStringify(nextRequireds) !== stableStringify(originalRequireds)) {
        patch.requireds = nextRequireds;
      }
      const notSel = overlay.querySelector('#we-notsel').checked;
      if (notSel !== !!original.isNotSelectable) patch.isNotSelectable = notSel;
      const multi = overlay.querySelector('#we-multi').checked;
      if (multi !== !!original.isSelectableMultiple) patch.isSelectableMultiple = multi;
      if (multi) {
        const maxP = String(parseInt(overlay.querySelector('#we-maxpicks').value, 10) || 1);
        const minP = String(parseInt(overlay.querySelector('#we-minpicks').value, 10) || 0);
        if (maxP !== String(original.numMultipleTimesPluss ?? '')) patch.numMultipleTimesPluss = maxP;
        if (minP !== String(original.numMultipleTimesMinus ?? '')) patch.numMultipleTimesMinus = minP;
      }

      const actOther = overlay.querySelector('#we-actother').checked;
      if (actOther !== !!original.activateOtherChoice) patch.activateOtherChoice = actOther;
      const actThis = overlay.querySelector('#we-activatethis').value.trim();
      if (actThis !== (original.activateThisChoice || '')) patch.activateThisChoice = actThis;
      const deactOther = overlay.querySelector('#we-deactother').checked;
      if (deactOther !== !!original.deactivateOtherChoice) patch.deactivateOtherChoice = deactOther;
      const deactThis = overlay.querySelector('#we-deactivatethis').value.trim();
      if (deactThis !== (original.deactivateThisChoice || '')) patch.deactivateThisChoice = deactThis;

      return patch;
    }

    function deepCloneValue(value) {
      try { return JSON.parse(JSON.stringify(value)); } catch (err) { return value; }
    }

    function buildActivationTerm(required) {
      // Mirrors the project's real ConditionTerm shape for {type:'id'} terms.
      return {
        id: '',
        type: 'id',
        required: !!required,
        reqId: objId,
        reqId1: '', reqId2: '', reqId3: '',
        reqPoints: 0,
        operator: '',
        orRequired: [{ req: '' }, { req: '' }, { req: '' }, { req: '' }],
        requireds: [],
        showRequired: false,
        beforeText: 'Required:',
        afterText: 'choice',
      };
    }

    function updateScoreHint() {
      const hint = overlay.querySelector('#we-scores-hint');
      const rows = overlay.querySelectorAll('#we-scores .worm-score-edit').length;
      if (hint) hint.hidden = rows > 0;
    }

    function renderActRows() {
      const wrap = overlay.querySelector('#we-act-rows');
      if (!wrap) return;
      wrap.innerHTML = '';
      if (actState.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'worm-empty-hint';
        hint.textContent = 'No sections are gated by this choice.';
        wrap.appendChild(hint);
        return;
      }
      actState.forEach((a) => {
        const row = document.createElement('div');
        row.className = 'worm-act-row';
        const name = document.createElement('span');
        name.className = 'worm-act-name';
        name.textContent = a.title;
        const kind = document.createElement('span');
        kind.className = 'worm-act-kind' + (a.required ? '' : ' off');
        kind.textContent = a.required ? 'shows when picked' : 'hides when picked';
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'worm-act-remove';
        rm.title = 'Remove this condition';
        rm.textContent = '×';
        rm.addEventListener('click', () => {
          const i = actState.indexOf(a);
          if (i >= 0) {
            removedActs.push({ rowId: a.rowId, requireds: deepCloneValue(a.requireds) });
            actState.splice(i, 1);
          }
          renderActRows();
          renderActRowSelect();
        });
        row.appendChild(name);
        row.appendChild(kind);
        row.appendChild(rm);
        wrap.appendChild(row);
      });
    }

    function renderActRowSelect() {
      const sel = overlay.querySelector('#we-act-row');
      if (!sel) return;
      const used = new Set(actState.map(a => a.rowId));
      const options = allRowsList
        .filter(r => !used.has(r.id))
        .map(r => `<option value="${esc(r.id)}">${esc(r.title || r.id)}</option>`)
        .join('');
      sel.innerHTML = options || '<option value="">No rows available</option>';
    }

    // Requirements section: lists this choice's {type:'id'} terms and manages
    // additions via the kind/choice dropdown pair.
    function renderReqRows() {
      const wrap = overlay.querySelector('#we-req-rows');
      if (!wrap) return;
      wrap.innerHTML = '';
      if (reqState.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'worm-empty-hint';
        hint.textContent = 'No requirements on this choice.';
        wrap.appendChild(hint);
        return;
      }
      reqState.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = 'worm-act-row';
        const name = document.createElement('span');
        name.className = 'worm-act-name';
        name.textContent = choiceTitleFor(entry.term.reqId);
        const kind = document.createElement('span');
        kind.className = 'worm-act-kind' + (entry.required ? '' : ' off');
        kind.textContent = entry.required ? 'needs' : 'blocked by';
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'worm-act-remove';
        rm.title = 'Remove this requirement';
        rm.textContent = '×';
        rm.addEventListener('click', () => {
          reqState.splice(idx, 1);
          renderReqRows();
        });
        row.appendChild(name);
        row.appendChild(kind);
        row.appendChild(rm);
        wrap.appendChild(row);
      });
    }

    function buildRequirementTerm(required) {
      // Mirrors the project's real choice-level {type:'id'} ConditionTerm shape
      // (verified against project.json data): showRequired=true + beforeText
      // "Incompatible:" for blocking terms; false + "Required:" otherwise.
      return {
        id: '',
        type: 'id',
        required: !!required,
        reqId: '',
        reqId1: '', reqId2: '', reqId3: '',
        reqPoints: 0,
        operator: '',
        orRequired: [{ req: '' }, { req: '' }, { req: '' }, { req: '' }],
        requireds: [],
        showRequired: !required,
        beforeText: required ? 'Required:' : 'Incompatible:',
        afterText: '',
      };
    }

    function stableStringify(value) {
      // Key-order-insensitive JSON for structural comparison.
      return JSON.stringify(value, (key, val) => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          return Object.keys(val).sort().reduce((acc, k) => { acc[k] = val[k]; return acc; }, {});
        }
        return val;
      });
    }

    function buildRowOps() {
      const rowMap = new Map();
      const ensure = (rowId, requireds) => {
        if (!rowMap.has(rowId)) {
          const base = deepCloneValue(requireds || []);
          rowMap.set(rowId, { requireds: deepCloneValue(base), original: base });
        }
        return rowMap.get(rowId);
      };
      // Removals first, then (re-)additions — so a remove+re-add of the same
      // row nets out to a single present term.
      for (const r of removedActs) {
        const entry = ensure(r.rowId, r.requireds);
        entry.requireds = entry.requireds.filter(t => !(t && t.type === 'id' && t.reqId === objId));
      }
      for (const a of actState) {
        const entry = ensure(a.rowId, a.requireds);
        const idx = entry.requireds.findIndex(t => t && t.type === 'id' && t.reqId === objId);
        if (idx >= 0) {
          // Already gated by this choice — only the required flag can differ;
          // touch nothing else so unchanged rows produce no op.
          if (!!entry.requireds[idx].required !== !!a.required) {
            entry.requireds[idx] = { ...entry.requireds[idx], required: !!a.required };
          }
        } else {
          entry.requireds.push(buildActivationTerm(a.required));
        }
      }
      const ops = [];
      for (const [rowId, entry] of rowMap) {
        if (stableStringify(entry.requireds) !== stableStringify(entry.original)) {
          ops.push({ type: 'updateRow', rowId, patch: { requireds: entry.requireds } });
        }
      }
      return ops;
    }

    overlay.querySelector('#we-close').addEventListener('click', closeModal);
    overlay.querySelector('#we-cancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    overlay.querySelectorAll('.worm-score-edit').forEach(row => wireSegmented(row.querySelector('.we-score-eff')));
    overlay.querySelectorAll('.worm-score-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.worm-score-edit').remove();
        updateScoreHint();
      });
    });
    overlay.querySelector('#we-add-score').addEventListener('click', () => {
      const wrap = overlay.querySelector('#we-scores');
      const temp = document.createElement('div');
      temp.innerHTML = scoreRowHtml(null, -1);
      const row = temp.firstElementChild;
      wrap.appendChild(row);
      wireSegmented(row.querySelector('.we-score-eff'));
      row.querySelector('.worm-score-remove').addEventListener('click', () => {
        row.remove();
        updateScoreHint();
      });
      updateScoreHint();
    });
    const actAddBtn = overlay.querySelector('#we-act-add');
    if (actAddBtn) actAddBtn.addEventListener('click', () => {
      const sel = overlay.querySelector('#we-act-row');
      const kind = overlay.querySelector('#we-act-kind').value;
      const rowId = sel.value;
      if (!rowId || actState.some(a => a.rowId === rowId)) return;
      const withTerms = rowsWithTerms.find(r => r.id === rowId);
      const rowInfo = allRowsList.find(r => r.id === rowId) || {};
      actState.push({
        rowId,
        title: rowInfo.title || rowId,
        required: kind === 'required',
        requireds: withTerms ? deepCloneValue(withTerms.requireds) : [],
        isNew: true,
      });
      renderActRows();
      renderActRowSelect();
    });
    overlay.querySelector('#we-multi').addEventListener('change', (e) => {
      overlay.querySelector('#we-multi-limits').hidden = !e.target.checked;
    });
    if (actAddBtn) {
      renderActRows();
      renderActRowSelect();
    }
    renderReqRows();
    updateScoreHint();
    overlay.querySelector('#we-reset').addEventListener('click', () => {
      overlay.querySelector('#we-title').value = original.title || '';
      overlay.querySelector('#we-text').value = original.text || '';
      overlay.querySelector('#we-image').value = isEmbeddedImage ? '' : (original.image || '');
      overlay.querySelector('#we-width').value = original.objectWidth || '';
      const wrap = overlay.querySelector('#we-scores');
      wrap.innerHTML = (Array.isArray(original.scores) && original.scores.length > 0)
        ? original.scores.map((s, i) => scoreRowHtml(s, i)).join('')
        : '';
      wrap.querySelectorAll('.worm-score-edit').forEach(row => wireSegmented(row.querySelector('.we-score-eff')));
      wrap.querySelectorAll('.worm-score-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          btn.closest('.worm-score-edit').remove();
          updateScoreHint();
        });
      });
      updateScoreHint();
      overlay.querySelector('#we-notsel').checked = !!original.isNotSelectable;
      overlay.querySelector('#we-multi').checked = !!original.isSelectableMultiple;
      overlay.querySelector('#we-multi-limits').hidden = !original.isSelectableMultiple;
      overlay.querySelector('#we-maxpicks').value = String(original.numMultipleTimesPluss ?? 1);
      overlay.querySelector('#we-minpicks').value = String(original.numMultipleTimesMinus ?? 0);
      overlay.querySelector('#we-activatethis').value = original.activateThisChoice || '';
      overlay.querySelector('#we-deactivatethis').value = original.deactivateThisChoice || '';
      overlay.querySelector('#we-actother').checked = !!original.activateOtherChoice;
      overlay.querySelector('#we-deactother').checked = !!original.deactivateOtherChoice;
    });
    overlay.querySelector('#we-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isAdd) {
        // ---- Add path: build a full new choice from the dialog ----
        const rowId = overlay.querySelector('#we-dest').value;
        const title = overlay.querySelector('#we-title').value.trim();
        if (!rowId || !title) return;
        const newId = 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        const newChoice = {
          ...deepCloneValue(original),
          id: newId,
          rowId,
          title,
          text: overlay.querySelector('#we-text').value,
          isCustom: true,
          template: 1,
        };
        const image = overlay.querySelector('#we-image').value.trim();
        newChoice.image = image;
        newChoice.imageIsUrl = /^https?:\/\//i.test(image);
        newChoice.objectWidth = overlay.querySelector('#we-width').value;
        const scoreRows = Array.from(overlay.querySelectorAll('.worm-score-edit'));
        newChoice.scores = scoreRows.map(scoreRowFromUi);
        const notSel = overlay.querySelector('#we-notsel').checked;
        newChoice.isNotSelectable = notSel;
        const multi = overlay.querySelector('#we-multi').checked;
        newChoice.isSelectableMultiple = multi;
        newChoice.numMultipleTimesPluss = multi ? String(parseInt(overlay.querySelector('#we-maxpicks').value, 10) || 1) : '1';
        newChoice.numMultipleTimesMinus = multi ? String(parseInt(overlay.querySelector('#we-minpicks').value, 10) || 0) : '0';
        newChoice.activateThisChoice = overlay.querySelector('#we-activatethis').value.trim();
        newChoice.deactivateThisChoice = overlay.querySelector('#we-deactivatethis').value.trim();
        newChoice.activateOtherChoice = overlay.querySelector('#we-actother').checked;
        newChoice.deactivateOtherChoice = overlay.querySelector('#we-deactother').checked;
        newChoice.requireds = keptOthersForAdd().concat(reqState.map(en => en.term));
        closeModal();
        await editorRequest('EDITOR_OP', {
          op: { type: 'addObject', rowId, index: -1, object: newChoice },
        });
        showToast('Added “' + title + '”');
        return;
      }
      // ---- Edit path (unchanged semantics) ----
      const patch = buildPatch();
      const rowOps = buildRowOps();
      if (Object.keys(patch).length > 0) {
        await editorRequest('EDITOR_OP', { op: { type: 'updateObject', objId, patch } });
      }
      for (const op of rowOps) {
        await editorRequest('EDITOR_OP', { op });
      }
      closeModal();
    });

    document.body.appendChild(overlay);
  }

  ensureEditorToggle();

  // Abbreviates a point type name: "Shard Points" → "SP", "Character Points" → "CP"
  function abbreviatePointName(name) {
    if (!name) return 'Pts';
    const words = name.trim().split(/\s+/);
    if (words.length === 1) return name; // single word kept as-is
    return words.map(w => w[0].toUpperCase()).join('');
  }
})();
