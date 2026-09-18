// page-script.js - Runs in the page's MAIN execution world (has direct access to window.app, Vue 3, Pinia)

(function () {
  console.log('[Worm V17 Mod] Page script initialized in MAIN world.');

  // In-memory registry of custom choices and detected project reference
  let savedCustomChoices = [];
  let detectedProject = null;
  let hookAttempts = 0;
  let activeProjectStore = null;

  // =========================================================================
  // 1. Normalization & Formatting Helpers
  // =========================================================================
  // Abbreviates a point type name: "Shard Points" → "SP", "Character Points" → "CP"
  function abbreviatePointName(name) {
    if (!name) return 'Pts';
    const words = name.trim().split(/\s+/);
    if (words.length === 1) return name;
    return words.map(w => w[0].toUpperCase()).join('');
  }

  function normalizeScore(score, pointTypes = []) {
    if (!score || !score.id) return null;
    const pt = pointTypes.find(p => p.id === score.id);
    const ptName = pt ? (pt.name || pt.id) : (score.afterText || 'Points');
    const abbr = abbreviatePointName(ptName);

    const rawVal = typeof score.value === 'string' ? parseInt(score.value, 10) : (score.value || 0);
    // Positive value = cost, negative value = gain (ICC Neo convention)
    // Also respect explicit beforeText hints from old and new formats
    const isGain = score.isGain !== undefined
      ? score.isGain
      : (score.beforeText === '+' || score.beforeText === 'Gain:' || (rawVal < 0 && score.beforeText !== '-' && score.beforeText !== 'Cost:'));
    const absVal = Math.abs(rawVal) || 0;

    return {
      id: score.id,
      value: isGain ? String(-absVal) : String(absVal),
      beforeText: isGain ? 'Gain:' : 'Cost:',
      afterText: abbr,
      requireds: Array.isArray(score.requireds) ? score.requireds : []
    };
  }

  function normalizeChoice(choice, pointTypes = []) {
    const rawScores = Array.isArray(choice.scores) ? choice.scores : [];
    const normalizedScores = rawScores.map(s => normalizeScore(s, pointTypes)).filter(Boolean);

    return {
      ...choice,
      id: choice.id || 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
      title: choice.title || 'Untitled Choice',
      text: choice.text || '',
      image: choice.image || '',
      scores: normalizedScores,
      requireds: Array.isArray(choice.requireds) ? choice.requireds : [],
      addons: Array.isArray(choice.addons) ? choice.addons : [],
      groups: Array.isArray(choice.groups) ? choice.groups : [],
      isSelectableMultiple: Boolean(choice.isSelectableMultiple),
      isNotSelectable: false,
      isVisible: true,
      isDefault: false,
      isPrivateStyling: false,
      styling: null,
      template: 1,
      isCustom: true
    };
  }

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

          // Merge any saved custom choices into the JSON before the viewer reads it
          if (savedCustomChoices.length > 0) {
            applyChoicesToRawProject(json, savedCustomChoices);
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
  // 3. (removed) The old DOM-level updater relied on `__vueParentComponent`,
  //    which production Vue builds do not attach to elements. Live updates are
  //    handled entirely through the Pinia "project" store in
  //    applyChoicesToPiniaStore() below.
  // =========================================================================

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

  function findVue2App() {
    if (window.app && Array.isArray(window.app.rows)) {
      return window.app;
    }
    const appEl = document.querySelector('#app');
    if (appEl && appEl.__vue__ && Array.isArray(appEl.__vue__.rows)) {
      return appEl.__vue__;
    }
    return null;
  }

  const hookInterval = setInterval(() => {
    hookAttempts++;

    const piniaStore = findPiniaProjectStore();
    if (piniaStore && piniaStore.store && piniaStore.store.status === 'loaded') {
      activeProjectStore = piniaStore;
      const fileData = piniaStore.store.file?.data;
      if (fileData) {
        console.log('[Worm V17 Mod] Connected to Pinia project store!');
        emitCyoaMetadata(fileData.rows, fileData.pointTypes);
        applyChoicesToPiniaStore(piniaStore, savedCustomChoices);
        clearInterval(hookInterval);
        return;
      }
    }

    const vue2 = findVue2App();
    if (vue2) {
      console.log('[Worm V17 Mod] Connected to Vue 2 CYOA app!');
      emitCyoaMetadata(vue2.rows, vue2.pointTypes || vue2.scores);
      applyChoicesToVue2(vue2, savedCustomChoices);
      clearInterval(hookInterval);
      return;
    }

    if (hookAttempts > 60) {
      clearInterval(hookInterval);
    }
  }, 1000);

  function applyChoicesToRawProject(projectData, choices) {
    if (!projectData || !Array.isArray(projectData.rows)) return;
    const pointTypes = projectData.pointTypes || [];

    for (const raw of choices) {
      const choice = normalizeChoice(raw, pointTypes);
      const row = projectData.rows.find(r => r.id === choice.rowId);
      if (row) {
        if (!Array.isArray(row.objects)) row.objects = [];
        const existingIdx = row.objects.findIndex(o => o.id === choice.id);
        if (existingIdx >= 0) {
          row.objects[existingIdx] = choice;
        } else {
          row.objects.push(choice);
        }
      }
    }
  }

  // Shared two-step row remount used by both injection (add/update) and removal.
  // CollectionLoader renders each row's items incrementally with a timer that
  // PAUSES once complete; it only resumes when the row's `isVisible` prop flips,
  // so simply changing `objects` leaves the loader's internal list stale.
  // Trick: empty the affected rows (their loader unmounts via v-if="objects.length>0"),
  // then restore the full row copies 50ms later — the loader remounts and re-renders
  // every item. Selection state lives in the store (`selected`/`selectedIds`), so it
  // survives the remount. Row maps: rowId -> full replacement row object.
  function swapRowsWithRemount(store, emptiedMap, restoreMap, successLog) {
    const replaceRows = (stateVal, rowMap) => {
      const file = stateVal.file;
      const data = file.data;
      store.store = {
        ...stateVal,
        file: {
          ...file,
          data: {
            ...data,
            rows: data.rows.map(r => rowMap.get(r.id) || r)
          }
        }
      };
    };

    // Step 1: empty the affected rows -> CollectionLoader unmounts.
    replaceRows(store.store, emptiedMap);

    // Step 2: restore the pre-built full rows. Re-read state in case the app
    // changed it in the interim; never merge with the live rows — they are the
    // emptied copies written by step 1 (merging would corrupt object lists).
    setTimeout(() => {
      try {
        const cur = store.store;
        const curRows = cur?.file?.data?.rows;
        if (!Array.isArray(curRows)) return;
        replaceRows(cur, restoreMap);
        if (successLog) console.log(successLog);
      } catch (err) {
        console.error('[Worm V17 Mod] Error during row remount (step 2):', err);
      }
    }, 50);
  }

  // Live-removes custom choices from the Pinia "project" store by id.
  function removeChoicesFromPiniaStore(store, choiceIds) {
    try {
      const ids = new Set(choiceIds);
      const stateVal = store.store;
      if (!stateVal || stateVal.status !== 'loaded' || !stateVal.file?.data || !Array.isArray(stateVal.file.data.rows)) {
        return false;
      }
      const rows = stateVal.file.data.rows;

      // Build replacement copies only for rows that actually contain a target id;
      // untouched rows keep their original object references.
      const newRowById = new Map();
      for (const row of rows) {
        if (!Array.isArray(row.objects) || !row.objects.some(o => o && ids.has(o.id))) continue;
        newRowById.set(row.id, { ...row, objects: row.objects.filter(o => !(o && ids.has(o.id))) });
      }
      if (newRowById.size === 0) return false;

      const emptiedMap = new Map();
      for (const rowId of newRowById.keys()) {
        const origRow = rows.find(r => r.id === rowId);
        emptiedMap.set(rowId, { ...origRow, objects: [] });
      }
      swapRowsWithRemount(store, emptiedMap, newRowById, '[Worm V17 Mod] Removed custom choices from Pinia store: ' + choiceIds.length);
      return true;
    } catch (err) {
      console.error('[Worm V17 Mod] Error removing choices from Pinia store:', err);
      return false;
    }
  }

  // Legacy Vue 2 fallback: remove choices from the live app rows.
  function removeChoicesFromVue2(app, choiceIds) {
    try {
      if (!Array.isArray(app.rows)) return;
      const ids = new Set(choiceIds);
      for (const row of app.rows) {
        if (!Array.isArray(row.objects)) continue;
        row.objects = row.objects.filter(o => !(o && ids.has(o.id)));
      }
    } catch (err) {
      console.error('[Worm V17 Mod] Error removing choices from Vue 2:', err);
    }
  }

  function applyChoicesToPiniaStore(store, choices) {
    try {
      // On the Pinia store proxy, refs are unwrapped: `store.store` IS the raw
      // shallowRef value ({ status, file: { data: { rows, pointTypes } }, ... }).
      // Writing via plain assignment (`store.store = {...}`) routes through the
      // proxy setter into the underlying shallowRef and triggers reactivity.
      const stateVal = store.store;
      if (!stateVal || stateVal.status !== 'loaded' || !stateVal.file?.data || !Array.isArray(stateVal.file.data.rows)) {
        return false;
      }
      const file = stateVal.file;
      const data = file.data;
      const rows = data.rows;

      // Merge the normalized choices into COPIES of their target rows, keyed by rowId.
      // Untouched rows keep their original object references.
      const newRowById = new Map();
      for (const raw of choices) {
        const choice = normalizeChoice(raw, data.pointTypes || []);
        const origRow = rows.find(r => r.id === choice.rowId);
        if (!origRow) {
          console.warn('[Worm V17 Mod] rowId not found for choice:', choice.rowId);
          continue;
        }
        const target = newRowById.get(choice.rowId) || origRow;
        const objects = Array.isArray(target.objects) ? target.objects.slice() : [];
        const existingIdx = objects.findIndex(o => o.id === choice.id);
        if (existingIdx >= 0) {
          objects[existingIdx] = choice;
        } else {
          objects.push(choice);
        }
        newRowById.set(choice.rowId, { ...target, objects });
      }
      if (newRowById.size === 0) return false;

      const emptiedMap = new Map();
      for (const rowId of newRowById.keys()) {
        const origRow = rows.find(r => r.id === rowId);
        emptiedMap.set(rowId, { ...origRow, objects: [] });
      }
      swapRowsWithRemount(
        store,
        emptiedMap,
        newRowById,
        '[Worm V17 Mod] Injected & updated Pinia store with custom choices: ' + choices.length
      );

      return true;
    } catch (err) {
      console.error('[Worm V17 Mod] Error applying choices to Pinia store:', err);
      return false;
    }
  }

  function applyChoicesToVue2(app, choices) {
    try {
      if (!Array.isArray(app.rows)) return;
      const pointTypes = app.pointTypes || app.scores || [];
      for (const raw of choices) {
        const choice = normalizeChoice(raw, pointTypes);
        const row = app.rows.find(r => r.id === choice.rowId);
        if (row) {
          if (!Array.isArray(row.objects)) row.objects = [];
          const existingIdx = row.objects.findIndex(o => o.id === choice.id);
          if (existingIdx >= 0) {
            row.objects.splice(existingIdx, 1, choice);
          } else {
            row.objects.push(choice);
          }
        }
      }
      console.log('[Worm V17 Mod] Injected custom choices into Vue 2 app:', choices.length);
    } catch (err) {
      console.error('[Worm V17 Mod] Error applying choices to Vue 2:', err);
    }
  }

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

  // =========================================================================
  // 5. Interactive Editor — Mutation Engine ("Worm Forge")
  //    Every edit is a small serializable op applied as a pure function over
  //    file.data. The whole shallowRef state is replaced, and only the affected
  //    rows go through the two-step CollectionLoader remount. Each op yields an
  //    inverse op, which powers undo/redo.
  // =========================================================================
  let editorMode = false;
  const editorUndoStack = [];
  const editorRedoStack = [];
  let editorReqCounter = 0;

  function getEditorCtx() {
    const store = findPiniaProjectStore();
    if (!store) return null;
    const stateVal = store.store;
    if (!stateVal || stateVal.status !== 'loaded' || !stateVal.file?.data || !Array.isArray(stateVal.file.data.rows)) return null;
    return { store, stateVal, data: stateVal.file.data, rows: stateVal.file.data.rows };
  }

  function stateWithRows(stateVal, rows) {
    return { ...stateVal, file: { ...stateVal.file, data: { ...stateVal.file.data, rows } } };
  }

  const arrReplace = (arr, i, v) => { const out = arr.slice(); out[i] = v; return out; };
  const arrInsert = (arr, i, v) => { const out = arr.slice(); out.splice(i, 0, v); return out; };
  const arrRemove = (arr, i) => { const out = arr.slice(); out.splice(i, 1); return out; };

  function findObjectLocation(rows, objId) {
    for (let i = 0; i < rows.length; i++) {
      const objects = rows[i].objects;
      if (!Array.isArray(objects)) continue;
      const j = objects.findIndex(o => o && o.id === objId);
      if (j >= 0) return { rowIdx: i, row: rows[i], objIdx: j, obj: objects[j] };
    }
    return null;
  }

  function findRowIndex(rows, rowId) {
    return rows.findIndex(r => r.id === rowId);
  }

  function cloneValue(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (err) { return value; }
  }

  function newObjectId() {
    return 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function newRowId() {
    return 'wrow_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function buildEditorSnapshot() {
    const ctx = getEditorCtx();
    if (!ctx) return null;
    const safeImage = (img) => (typeof img === 'string' && img.length > 0 && img.length <= 300 && !img.startsWith('data:')) ? img : '';
    return {
      projectName: ctx.stateVal.file.projectName || ctx.stateVal.file.fileName || 'CYOA',
      rows: ctx.rows.map(r => ({
        id: r.id,
        title: r.title || '',
        titleText: r.titleText || '',
        objectWidth: r.objectWidth || '',
        allowedChoices: r.allowedChoices ?? 0,
        isInfoRow: !!r.isInfoRow,
        isButtonRow: !!r.isButtonRow,
        isResultRow: !!r.isResultRow,
        rowJustify: r.rowJustify || '',
        objects: (Array.isArray(r.objects) ? r.objects : []).map(o => ({
          id: o.id,
          title: o.title || '',
          image: safeImage(o.image),
          width: o.objectWidth || '',
          isCustom: !!o.isCustom,
        })),
      })),
      pointTypes: (ctx.data.pointTypes || []).map(p => ({ id: p.id, name: p.name || p.id })),
    };
  }

  function postEditorResult(reqId, ok, label, error) {
    window.postMessage({
      source: 'WORM_CYOA_PAGE_SCRIPT',
      type: 'EDITOR_RESULT',
      data: { reqId: reqId || null, ok: !!ok, label: label || '', error: error || '' }
    }, '*');
  }

  const EDITOR_EXEC = {
    updateObject(data, op) {
      const loc = findObjectLocation(data.rows, op.objId);
      if (!loc) throw new Error('Choice not found: ' + op.objId);
      const original = loc.obj;
      const updated = { ...original, ...op.patch };
      const newRow = { ...loc.row, objects: arrReplace(loc.row.objects, loc.objIdx, updated) };
      return {
        rows: arrReplace(data.rows, loc.rowIdx, newRow),
        touched: [loc.row.id],
        remount: true,
        label: 'Saved “' + (op.patch && op.patch.title != null ? op.patch.title : original.title || op.objId) + '”',
        inverse: { type: 'updateObject', objId: op.objId, patch: cloneValue(original) },
      };
    },

    moveObject(data, op) {
      const loc = findObjectLocation(data.rows, op.objId);
      if (!loc) throw new Error('Choice not found: ' + op.objId);
      const targetIdx = findRowIndex(data.rows, op.toRowId);
      if (targetIdx < 0) throw new Error('Target row not found: ' + op.toRowId);
      const originalRowId = loc.row.id;
      const originalIndex = loc.objIdx;

      // Remove from source, then insert into target. `op.index` is the
      // insertion position AFTER the removal (the caller computes it that way).
      let newRows = arrReplace(data.rows, loc.rowIdx, { ...loc.row, objects: arrRemove(loc.row.objects, loc.objIdx) });
      const targetRow = newRows[targetIdx];
      const targetObjects = Array.isArray(targetRow.objects) ? targetRow.objects : [];
      const insertIdx = Math.max(0, Math.min(Number.isFinite(op.index) ? op.index : targetObjects.length, targetObjects.length));
      newRows = arrReplace(newRows, targetIdx, { ...targetRow, objects: arrInsert(targetObjects, insertIdx, loc.obj) });

      const touched = originalRowId === op.toRowId ? [originalRowId] : [originalRowId, op.toRowId];
      return {
        rows: newRows,
        touched,
        remount: true,
        label: 'Moved “' + (loc.obj.title || op.objId) + '”',
        inverse: { type: 'moveObject', objId: op.objId, toRowId: originalRowId, index: originalIndex },
      };
    },

    duplicateObject(data, op) {
      const loc = findObjectLocation(data.rows, op.objId);
      if (!loc) throw new Error('Choice not found: ' + op.objId);
      const copy = cloneValue(loc.obj);
      copy.id = newObjectId();
      copy.isCustom = true;
      copy.title = (loc.obj.title || 'Choice') + ' (copy)';
      const newRow = { ...loc.row, objects: arrInsert(loc.row.objects, loc.objIdx + 1, copy) };
      return {
        rows: arrReplace(data.rows, loc.rowIdx, newRow),
        touched: [loc.row.id],
        remount: true,
        label: 'Duplicated “' + (loc.obj.title || op.objId) + '”',
        inverse: { type: 'deleteObjects', ids: [copy.id] },
        extra: { kind: 'duplicate', object: cloneValue(copy) },
      };
    },

    deleteObjects(data, op) {
      const ids = new Set(op.ids || []);
      if (ids.size === 0) throw new Error('Nothing to delete');
      const entries = [];
      const touched = [];
      const newRows = data.rows.map(row => {
        if (!Array.isArray(row.objects)) return row;
        const kept = [];
        let removedHere = false;
        row.objects.forEach((o, i) => {
          if (o && ids.has(o.id)) { entries.push({ rowId: row.id, index: i, object: o }); removedHere = true; }
          else kept.push(o);
        });
        if (!removedHere) return row;
        touched.push(row.id);
        return { ...row, objects: kept };
      });
      if (entries.length === 0) throw new Error('No matching choices found');
      return {
        rows: newRows,
        touched,
        remount: true,
        label: 'Deleted choice' + (ids.size === 1 ? '' : 's'),
        inverse: { type: 'restoreObjects', entries },
      };
    },

    restoreObjects(data, op) {
      const entries = (op.entries || []).slice().sort((a, b) => a.index - b.index);
      let newRows = data.rows;
      const touched = [];
      for (const entry of entries) {
        const idx = findRowIndex(newRows, entry.rowId);
        if (idx < 0) continue;
        const row = newRows[idx];
        const objects = Array.isArray(row.objects) ? row.objects : [];
        const insertIdx = Math.max(0, Math.min(entry.index, objects.length));
        newRows = arrReplace(newRows, idx, { ...row, objects: arrInsert(objects, insertIdx, entry.object) });
        if (!touched.includes(entry.rowId)) touched.push(entry.rowId);
      }
      if (touched.length === 0) throw new Error('Original rows no longer exist');
      return {
        rows: newRows,
        touched,
        remount: true,
        label: 'Restored choice(s)',
        inverse: { type: 'deleteObjects', ids: entries.map(e => e.object.id) },
      };
    },

    addRow(data, op) {
      const row = { ...(op.row || {}) };
      if (!row.id) row.id = newRowId();
      if (!Array.isArray(row.objects)) row.objects = [];
      const rowsCount = data.rows.length;
      const at = op.afterRowId ? findRowIndex(data.rows, op.afterRowId) + 1 : rowsCount;
      return {
        rows: arrInsert(data.rows, Math.max(0, Math.min(at, rowsCount)), row),
        touched: [],
        remount: false,
        label: 'Added row “' + (row.title || row.id) + '”',
        inverse: { type: 'deleteRow', rowId: row.id },
      };
    },

    restoreRow(data, op) {
      const index = Math.max(0, Math.min(op.index == null ? data.rows.length : op.index, data.rows.length));
      return {
        rows: arrInsert(data.rows, index, cloneValue(op.row)),
        touched: [],
        remount: false,
        label: 'Restored row',
        inverse: { type: 'deleteRow', rowId: op.row.id },
      };
    },

    updateRow(data, op) {
      const idx = findRowIndex(data.rows, op.rowId);
      if (idx < 0) throw new Error('Row not found: ' + op.rowId);
      const original = data.rows[idx];
      const originalFields = { ...original };
      delete originalFields.objects;
      const updated = { ...original, ...op.patch };
      return {
        rows: arrReplace(data.rows, idx, updated),
        touched: [],
        remount: false,
        label: 'Saved row “' + (op.patch && op.patch.title != null ? op.patch.title : original.title || op.rowId) + '”',
        inverse: { type: 'updateRow', rowId: op.rowId, patch: originalFields },
      };
    },

    deleteRow(data, op) {
      const idx = findRowIndex(data.rows, op.rowId);
      if (idx < 0) throw new Error('Row not found: ' + op.rowId);
      const row = data.rows[idx];
      return {
        rows: arrRemove(data.rows, idx),
        touched: [],
        remount: false,
        label: 'Deleted row “' + (row.title || op.rowId) + '”',
        inverse: { type: 'restoreRow', index: idx, row: cloneValue(row) },
      };
    },

    moveRow(data, op) {
      const idx = findRowIndex(data.rows, op.rowId);
      if (idx < 0) throw new Error('Row not found: ' + op.rowId);
      const rowsWithout = arrRemove(data.rows, idx);
      const finalIdx = Math.max(0, Math.min(op.index == null ? rowsWithout.length : op.index, rowsWithout.length));
      return {
        rows: arrInsert(rowsWithout, finalIdx, data.rows[idx]),
        touched: [],
        remount: false,
        label: 'Moved row “' + (data.rows[idx].title || op.rowId) + '”',
        inverse: { type: 'moveRow', rowId: op.rowId, index: idx },
      };
    },
  };

  function applyEditorOp(op, opts = {}) {
    const ctx = getEditorCtx();
    if (!ctx) return { ok: false, error: 'CYOA is not loaded yet.' };
    const exec = EDITOR_EXEC[op.type];
    if (!exec) return { ok: false, error: 'Unknown editor op: ' + op.type };

    let result;
    try {
      result = exec(ctx.data, op);
    } catch (err) {
      console.warn('[Worm V17 Mod] Editor op failed:', err.message);
      return { ok: false, error: err.message };
    }

    if (result.remount && result.touched.length > 0) {
      const restoreMap = new Map();
      const emptiedMap = new Map();
      for (const rowId of result.touched) {
        const newRow = result.rows.find(r => r.id === rowId);
        const oldRow = ctx.rows.find(r => r.id === rowId);
        if (newRow) restoreMap.set(rowId, newRow);
        if (oldRow) emptiedMap.set(rowId, { ...oldRow, objects: [] });
      }
      swapRowsWithRemount(ctx.store, emptiedMap, restoreMap, result.label || null);
    } else {
      ctx.store.store = stateWithRows(ctx.stateVal, result.rows);
      if (result.label) console.log('[Worm V17 Mod] ' + result.label);
    }

    if (opts.record !== false) {
      editorUndoStack.push(result.inverse);
      if (editorUndoStack.length > 100) editorUndoStack.shift();
      editorRedoStack.length = 0;
    }

    try {
      window.postMessage({
        source: 'WORM_CYOA_PAGE_SCRIPT',
        type: 'EDITOR_DATA_CHANGED',
        data: {
          opType: op.type,
          label: result.label || '',
          extra: result.extra || null,
          snapshot: buildEditorSnapshot(),
          canUndo: editorUndoStack.length > 0,
          canRedo: editorRedoStack.length > 0,
        }
      }, '*');
    } catch (err) {
      console.warn('[Worm V17 Mod] Editor snapshot broadcast failed:', err);
    }

    return { ok: true, label: result.label || '' };
  }

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
      } else {
        const vue2 = findVue2App();
        if (vue2) applyChoicesToVue2(vue2, savedCustomChoices);
      }
    } else if (command === 'INJECT_SINGLE_CHOICE') {
      const choice = payload;
      const idx = savedCustomChoices.findIndex(c => c.id === choice.id);
      if (idx >= 0) savedCustomChoices[idx] = choice;
      else savedCustomChoices.push(choice);

      const piniaStore = findPiniaProjectStore();
      if (piniaStore && piniaStore.store?.file?.data) {
        applyChoicesToPiniaStore(piniaStore, [choice]);
      } else {
        const vue2 = findVue2App();
        if (vue2) applyChoicesToVue2(vue2, [choice]);
      }

      window.postMessage({
        source: 'WORM_CYOA_PAGE_SCRIPT',
        type: 'CHOICE_INJECTED_SUCCESS',
        choiceId: choice.id
      }, '*');
    } else if (command === 'REMOVE_CHOICE') {
      const choiceIds = Array.isArray(payload) ? payload : [payload].filter(Boolean);
      // Drop from the in-memory registry first so a later project.json fetch or
      // full re-sync cannot resurrect the deleted choices.
      const before = savedCustomChoices.length;
      savedCustomChoices = savedCustomChoices.filter(c => !choiceIds.includes(c.id));
      console.log('[Worm V17 Mod] Remove request for ' + choiceIds.length + ' choice(s); registry: ' + before + ' -> ' + savedCustomChoices.length);

      let removedLive = false;
      const piniaStore = findPiniaProjectStore();
      if (piniaStore && piniaStore.store?.file?.data) {
        removedLive = removeChoicesFromPiniaStore(piniaStore, choiceIds);
      }
      if (!removedLive) {
        const vue2 = findVue2App();
        if (vue2) removeChoicesFromVue2(vue2, choiceIds);
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
      const inv = editorUndoStack.pop();
      if (!inv) {
        postEditorResult(reqId, false, '', 'Nothing to undo');
      } else {
        const res = applyEditorOp(inv, { record: false });
        if (res.ok) { editorRedoStack.push(inv); postEditorResult(reqId, true, 'Undo'); }
        else { editorUndoStack.push(inv); postEditorResult(reqId, false, '', res.error); }
      }
    } else if (command === 'EDITOR_REDO') {
      const reqId = payload && payload.reqId;
      const redoOp = editorRedoStack.pop();
      if (!redoOp) {
        postEditorResult(reqId, false, '', 'Nothing to redo');
      } else {
        const res = applyEditorOp(redoOp, { record: false });
        if (res.ok) { editorUndoStack.push(redoOp); postEditorResult(reqId, true, 'Redo'); }
        else { editorRedoStack.push(redoOp); postEditorResult(reqId, false, '', res.error); }
      }
    } else if (command === 'EDITOR_GET_OBJECT') {
      const objId = payload && payload.objId;
      let object = null;
      let rowId = null;
      let index = -1;
      if (objId) {
        const ctx = getEditorCtx();
        if (ctx) {
          const loc = findObjectLocation(ctx.rows, objId);
          if (loc) { object = loc.obj; rowId = loc.row.id; index = loc.objIdx; }
        }
      }
      window.postMessage({
        source: 'WORM_CYOA_PAGE_SCRIPT',
        type: 'EDITOR_OBJECT',
        data: { reqId: payload && payload.reqId, objId, rowId, index, object }
      }, '*');
    } else if (command === 'REQUEST_METADATA') {
      const piniaStore = findPiniaProjectStore();
      if (piniaStore && piniaStore.store?.file?.data) {
        const d = piniaStore.store.file.data;
        emitCyoaMetadata(d.rows, d.pointTypes);
      } else if (detectedProject) {
        emitCyoaMetadata(detectedProject.rows, detectedProject.pointTypes);
      } else {
        const vue2 = findVue2App();
        if (vue2) emitCyoaMetadata(vue2.rows, vue2.pointTypes || vue2.scores);
      }
    }
  });
})();
