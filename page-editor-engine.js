// page-editor-engine.js — the editor mutation engine ("Worm Forge"): pure
// op executors (EDITOR_EXEC), undo/redo stacks, snapshot builder, and
// applyEditorOp which commits results into the Pinia store and broadcasts.
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

  addObject(data, op) {
    const rowIdx = findRowIndex(data.rows, op.rowId);
    if (rowIdx < 0) throw new Error('Target row not found: ' + op.rowId);
    const row = data.rows[rowIdx];
    const objects = Array.isArray(row.objects) ? row.objects : [];
    const obj = cloneValue(op.object);
    if (!obj.id) obj.id = newObjectId();
    const at = op.index == null || op.index < 0 || op.index > objects.length
      ? objects.length
      : op.index;
    const newRow = { ...row, objects: arrInsert(objects, at, obj) };
    return {
      rows: arrReplace(data.rows, rowIdx, newRow),
      touched: [row.id],
      remount: true,
      label: 'Added “' + (obj.title || obj.id) + '”',
      inverse: { type: 'deleteObjects', ids: [obj.id] },
      extra: { kind: 'add', object: cloneValue(obj) },
    };
  },

  moveObject(data, op) {
    const loc = findObjectLocation(data.rows, op.objId);
    if (!loc) throw new Error('Choice not found: ' + op.objId);
    const targetIdx = findRowIndex(data.rows, op.toRowId);
    if (targetIdx < 0) throw new Error('Target row not found: ' + op.toRowId);
    const destTitle = data.rows[targetIdx].title || op.toRowId;
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
      label: originalRowId === op.toRowId
        ? 'Moved “' + (loc.obj.title || op.objId) + '”'
        : 'Moved “' + (loc.obj.title || op.objId) + '” to “' + destTitle + '”',
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

let editorLastRemountAt = 0;

function applyEditorOp(op, opts = {}) {
  // Serialize heavy remounts: if another remount just ran, defer this op so
  // two-step state swaps can never interleave.
  const sinceLast = Date.now() - editorLastRemountAt;
  if (sinceLast < 120) {
    setTimeout(() => applyEditorOp(op, opts), 120 - sinceLast);
    return { ok: true, label: '', queued: true };
  }
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

  const broadcast = () => {
    try {
      window.postMessage({
        source: 'WORM_CYOA_PAGE_SCRIPT',
        type: 'EDITOR_DATA_CHANGED',
        data: {
          opType: op.type,
          op: cloneValue(op),
          label: result.label || '',
          extra: result.extra || null,
          deletedIds: op.type === 'deleteObjects' ? (op.ids || []).slice() : [],
          snapshot: buildEditorSnapshot(),
          canUndo: editorUndoStack.length > 0,
          canRedo: editorRedoStack.length > 0,
        }
      }, '*');
    } catch (err) {
      console.warn('[Worm V17 Mod] Editor snapshot broadcast failed:', err);
    }
  };

  if (result.remount && result.touched.length > 0) {
    editorLastRemountAt = Date.now();
    const restoreMap = new Map();
    const emptiedMap = new Map();
    for (const rowId of result.touched) {
      const newRow = result.rows.find(r => r.id === rowId);
      const oldRow = ctx.rows.find(r => r.id === rowId);
      if (newRow) restoreMap.set(rowId, newRow);
      if (oldRow) emptiedMap.set(rowId, { ...oldRow, objects: [] });
    }
    // CRITICAL: broadcast AFTER step 2 — between the two steps the touched
    // rows are intentionally emptied, and a snapshot taken then would tell
    // content.js the edited row has no objects (breaking card mapping).
    swapRowsWithRemount(ctx.store, emptiedMap, restoreMap, result.label || null, broadcast);
  } else {
    ctx.store.store = stateWithRows(ctx.stateVal, result.rows);
    if (result.label) console.log('[Worm V17 Mod] ' + result.label);
    broadcast();
  }

  if (opts.record !== false) {
    editorUndoStack.push({ op, inverse: result.inverse });
    if (editorUndoStack.length > 100) editorUndoStack.shift();
    editorRedoStack.length = 0;
  }

  return { ok: true, label: result.label || '' };
}

