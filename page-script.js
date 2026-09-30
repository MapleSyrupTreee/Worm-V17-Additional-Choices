// page-script.js — MAIN-world entry: fetch interception, Pinia store hook,
// metadata emission, and the command listener. Engine/apply modules are
// listed before it in manifest.json and share this world's top-level scope.

console.log('[Worm V17 Mod] Page script initialized in MAIN world.');


// =========================================================================
// 2. Network / Fetch Interceptor (Catches project.json before viewer mounts)
// =========================================================================
const originalFetch = window.fetch;
window.fetch = async function (...args) {
  const response = await originalFetch.apply(this, args);
  const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

  if (url.includes('project') && url.endsWith('.json')) {
    try {
      const cloned = response.clone();
      const json = await cloned.json();

      if (json && Array.isArray(json.rows) && Array.isArray(json.pointTypes)) {
        console.log('[Worm V17 Mod] Intercepted CYOA project.json via fetch:', json.title || 'Untitled CYOA');
        detectedProject = json;

        // Inject editor-created rows FIRST so custom choices can target them
        // (mirrors the layering: rows → customs → overlay patches/orders).
        if (editorOverlay) {
          json.rows = injectCreatedRows(json.rows, editorOverlay);
        }

        // Merge any saved custom choices into the JSON before the viewer reads it
        if (savedCustomChoices.length > 0) {
          applyChoicesToRawProject(json, savedCustomChoices);
          customsBakedInFetch = true; // live re-injection is redundant from here on
        }

        // Apply the editor overlay (edits/moves/deletes/row edits) on top
        if (editorOverlay) {
          const res = applyOverlayToRows(json.rows, editorOverlay);
          json.rows = res.rows;
          overlayAppliedInFetch = true;
          if (res.touched.length > 0) {
            console.log('[Worm V17 Mod] Editor overlay applied to intercepted project.json:', res.touched.length + ' row(s)');
          }
        }

        // Broadcast metadata early
        emitCyoaMetadata(json.rows, json.pointTypes);

        // Return the modified response
        return new Response(JSON.stringify(json), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }
    } catch (err) {
      console.warn('[Worm V17 Mod] Fetch interception pass-through due to error:', err);
    }
  }

  return response;
};


// =========================================================================
// 4. Vue / Pinia Store Runtime Hook
// =========================================================================
function findPiniaProjectStore() {
  const nuxtEl = document.querySelector('#__nuxt');
  if (nuxtEl && nuxtEl.__vue_app__) {
    const app = nuxtEl.__vue_app__;
    const provides = app._context?.provides;
    if (provides) {
      // The Pinia instance is provided under an anonymous Symbol() in production
      // builds (no 'pinia' description), so identify it by its _s store map instead.
      for (const s of Object.getOwnPropertySymbols(provides)) {
        const v = provides[s];
        if (v && v._s && typeof v._s.has === 'function' && v._s.has('project')) {
          return v._s.get('project');
        }
      }
    }
  }

  if (window.__PINIA__ && window.__PINIA__._s && window.__PINIA__._s.has('project')) {
    return window.__PINIA__._s.get('project');
  }

  return null;
}

const hookInterval = setInterval(() => {
  hookAttempts++;

  const piniaStore = findPiniaProjectStore();
  if (piniaStore && piniaStore.store && piniaStore.store.status === 'loaded') {
    const fileData = piniaStore.store.file?.data;
    if (fileData) {
      console.log('[Worm V17 Mod] Connected to Pinia project store!');
      emitCyoaMetadata(fileData.rows, fileData.pointTypes);
      applyChoicesToPiniaStore(piniaStore, savedCustomChoices);
      applyOverlayToLiveStore();
      clearInterval(hookInterval);
      return;
    }
  }

  if (hookAttempts > 60) {
    clearInterval(hookInterval);
  }
}, 1000);


// ------------------------------------------------------------ metadata --

function emitCyoaMetadata(rows, pointTypes) {
  if (!Array.isArray(rows)) return;

  const rowList = rows.map(r => ({
    id: r.id,
    title: r.title || r.id,
    count: Array.isArray(r.objects) ? r.objects.length : 0
  }));

  const pointList = Array.isArray(pointTypes)
    ? pointTypes.map(pt => ({
        id: pt.id,
        name: pt.name || pt.id,
        startingSum: pt.startingSum || 0
      }))
    : [];

  window.postMessage({
    source: 'WORM_CYOA_PAGE_SCRIPT',
    type: 'CYOA_METADATA_LOADED',
    data: {
      detected: true,
      title: document.title,
      rows: rowList,
      pointTypes: pointList
    }
  }, '*');
}


// ------------------------------------------------------------ commands --

// =========================================================================
// 6. Message Listener (Commands from Extension / content.js)
// =========================================================================
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.target !== 'WORM_CYOA_PAGE_SCRIPT') {
    return;
  }

  const { command, payload } = event.data;

  if (command === 'SYNC_CUSTOM_CHOICES') {
    savedCustomChoices = Array.isArray(payload) ? payload : [];
    console.log('[Worm V17 Mod] Synced custom choices count:', savedCustomChoices.length);

    const piniaStore = findPiniaProjectStore();
    if (piniaStore && piniaStore.store?.file?.data) {
      applyChoicesToPiniaStore(piniaStore, savedCustomChoices);
    }
  } else if (command === 'SYNC_EDITOR_OVERLAY') {
    editorOverlay = (payload && typeof payload === 'object' && payload.version === 1) ? payload : null;
    console.log('[Worm V17 Mod] Synced editor overlay:', editorOverlay
      ? (Object.keys(editorOverlay.objects || {}).length + ' object edit(s), ' +
         (editorOverlay.deleted || []).length + ' deletion(s), ' +
         Object.keys(editorOverlay.rows || {}).length + ' created row(s), ' +
         (editorOverlay.deletedRows || []).length + ' deleted row(s), ' +
         Object.keys(editorOverlay.rowPatches || {}).length + ' row edit(s), ' +
         Object.keys(editorOverlay.rowOrder || {}).length + ' ordered row(s)')
      : 'cleared');
    // If the page loaded before this sync arrived, apply to the live store now.
    applyOverlayToLiveStore();
  } else if (command === 'REMOVE_CHOICE') {
    const choiceIds = Array.isArray(payload) ? payload : [payload].filter(Boolean);
    // Drop from the in-memory registry first so a later project.json fetch or
    // full re-sync cannot resurrect the deleted choices.
    const before = savedCustomChoices.length;
    savedCustomChoices = savedCustomChoices.filter(c => !choiceIds.includes(c.id));
    console.log('[Worm V17 Mod] Remove request for ' + choiceIds.length + ' choice(s); registry: ' + before + ' -> ' + savedCustomChoices.length);

    const piniaStore = findPiniaProjectStore();
    if (piniaStore && piniaStore.store?.file?.data) {
      removeChoicesFromPiniaStore(piniaStore, choiceIds);
    }

    window.postMessage({
      source: 'WORM_CYOA_PAGE_SCRIPT',
      type: 'CHOICE_REMOVED_SUCCESS',
      choiceIds
    }, '*');
  } else if (command === 'EDITOR_SET_MODE') {
    editorMode = !!(payload && payload.enabled);
    window.postMessage({
      source: 'WORM_CYOA_PAGE_SCRIPT',
      type: 'EDITOR_MODE_CHANGED',
      data: { enabled: editorMode, snapshot: buildEditorSnapshot() }
    }, '*');
  } else if (command === 'EDITOR_GET_DATA') {
    window.postMessage({
      source: 'WORM_CYOA_PAGE_SCRIPT',
      type: 'EDITOR_DATA',
      data: { reqId: payload && payload.reqId, snapshot: buildEditorSnapshot() }
    }, '*');
  } else if (command === 'EDITOR_OP') {
    const res = applyEditorOp(payload && payload.op);
    postEditorResult(payload && payload.reqId, res.ok, res.label, res.error);
  } else if (command === 'EDITOR_UNDO') {
    const reqId = payload && payload.reqId;
    const entry = editorUndoStack.pop();
    if (!entry) {
      postEditorResult(reqId, false, '', 'Nothing to undo');
    } else {
      const res = applyEditorOp(entry.inverse, { record: false });
      if (res.ok) { editorRedoStack.push(entry); postEditorResult(reqId, true, 'Undo'); }
      else { editorUndoStack.push(entry); postEditorResult(reqId, false, '', res.error); }
    }
  } else if (command === 'EDITOR_REDO') {
    const reqId = payload && payload.reqId;
    const entry = editorRedoStack.pop();
    if (!entry) {
      postEditorResult(reqId, false, '', 'Nothing to redo');
    } else {
      const res = applyEditorOp(entry.op, { record: false });
      if (res.ok) { editorUndoStack.push(entry); postEditorResult(reqId, true, 'Redo'); }
      else { editorRedoStack.push(entry); postEditorResult(reqId, false, '', res.error); }
    }
  } else if (command === 'EDITOR_GET_ROW') {
    const rowId = payload && payload.rowId;
    let row = null;
    const ctx = getEditorCtx();
    if (ctx && rowId) {
      const r = ctx.rows.find(x => x && x.id === rowId);
      if (r) row = cloneValue(r);
    }
    window.postMessage({
      source: 'WORM_CYOA_PAGE_SCRIPT',
      type: 'EDITOR_ROW',
      data: { reqId: payload && payload.reqId, rowId, row }
    }, '*');
  } else if (command === 'EDITOR_GET_OBJECT') {
    const objId = payload && payload.objId;
    let object = null;
    let rowId = null;
    let index = -1;
    let rowWidth = '';
    let rowTitle = '';
    let activatedRows = [];
    let rowsWithTerms = [];
    if (objId) {
      const ctx = getEditorCtx();
      if (ctx) {
        const loc = findObjectLocation(ctx.rows, objId);
        if (loc) {
          object = loc.obj;
          rowId = loc.row.id;
          index = loc.objIdx;
          rowWidth = loc.row.objectWidth || '';
          rowTitle = loc.row.title || '';
          // Rows whose visibility conditions reference this choice:
          // {type:'id', required:true} = shows when picked,
          // {type:'id', required:false} = hidden (incompatible) when picked.
          activatedRows = ctx.rows
            .map(row => {
              const terms = Array.isArray(row.requireds) ? row.requireds : [];
              const termIdx = terms.findIndex(t => t && t.type === 'id' && t.reqId === objId);
              return { row, termIdx, term: termIdx >= 0 ? terms[termIdx] : null };
            })
            .filter(x => x.term)
            .map(x => ({
              id: x.row.id,
              title: x.row.title || x.row.id,
              required: !!x.term.required,
              requireds: cloneValue(x.row.requireds || []),
            }));
          // Rows that already carry condition terms (for the add-select):
          rowsWithTerms = ctx.rows
            .filter(r => Array.isArray(r.requireds) && r.requireds.length > 0)
            .map(r => ({ id: r.id, title: r.title || r.id, requireds: cloneValue(r.requireds) }));
        }
      }
    }
    window.postMessage({
      source: 'WORM_CYOA_PAGE_SCRIPT',
      type: 'EDITOR_OBJECT',
      data: { reqId: payload && payload.reqId, objId, rowId, index, object, rowWidth, rowTitle, activatedRows, rowsWithTerms }
    }, '*');
  } else if (command === 'REQUEST_METADATA') {
    const piniaStore = findPiniaProjectStore();
    if (piniaStore && piniaStore.store?.file?.data) {
      const d = piniaStore.store.file.data;
      emitCyoaMetadata(d.rows, d.pointTypes);
    } else if (detectedProject) {
      emitCyoaMetadata(detectedProject.rows, detectedProject.pointTypes);
    }
  }
});

