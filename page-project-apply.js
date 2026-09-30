// page-project-apply.js — getting custom choices and the editor overlay onto
// the project: merge into raw project.json (fetch path), pure overlay-to-rows
// transform, live Pinia-store injection/removal, and the serialized two-step
// row remount every row-changing path funnels through.
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

// Injects rows created in the editor (overlay.rows = {rowId: {row,
// afterRowId}}) into a rows array. Idempotent: a row id already present is
// skipped. Anchors chain (a row inserted after another created row), so
// passes repeat until no more can be placed; top-anchored rows ('' = top)
// go in first in op order; entries whose anchor vanished append at the end.
function injectCreatedRows(rows, overlay) {
  const created = (overlay && overlay.rows) || {};
  const entries = Object.keys(created)
    .map(id => ({ id, entry: created[id] }))
    .filter(e => e.entry && e.entry.row && typeof e.entry.row === 'object' && e.id);
  if (!entries.length || !Array.isArray(rows)) return rows;
  let newRows = rows;
  const present = (id) => newRows.some(r => r && r.id === id);
  const inject = (e) => newRows = arrInsert(newRows, 0, { ...cloneValue(e.entry.row), id: e.id });
  // 1) anchor-chained entries (afterRowId !== '')
  let progress = true;
  while (progress) {
    progress = false;
    for (const e of entries) {
      if (!e.entry.afterRowId || present(e.id)) continue;
      const ai = newRows.findIndex(r => r && r.id === e.entry.afterRowId);
      if (ai < 0) continue; // anchor not placed yet — try again next pass
      newRows = arrInsert(newRows, ai + 1, { ...cloneValue(e.entry.row), id: e.id });
      progress = true;
    }
  }
  // 2) top-anchored entries, op order preserved (insert-at-0 in reverse)
  entries.filter(e => !e.entry.afterRowId).reverse().forEach((e) => {
    if (!present(e.id)) inject(e);
  });
  // 3) orphans (anchor row no longer exists) → append at the end, op order
  entries.forEach((e) => { if (!present(e.id)) newRows = arrInsert(newRows, newRows.length, { ...cloneValue(e.entry.row), id: e.id }); });
  return newRows;
}

// Applies the editor overlay to a rows array PURELY (no in-place mutation):
// returns { rows: newRows, touched: [rowId,...] }. Order of application:
// created rows → object field patches → deletions → row field patches →
// row orders (row orders last, so custom choices baked in beforehand get
// positioned).
function applyOverlayToRows(rows, overlay) {
  const touched = [];
  if (!overlay || !Array.isArray(rows)) return { rows, touched };
  // 0) rows created by the editor (idempotent — already-present ids skip)
  let newRows = injectCreatedRows(rows, overlay);
  // 0b) rows deleted in the editor (baseline rows only — created rows were
  // removed from overlay.rows by the recorder instead)
  const deletedRows = Array.isArray(overlay.deletedRows) ? overlay.deletedRows : [];
  if (deletedRows.length) {
    const deadRows = new Set(deletedRows);
    newRows = newRows.filter(r => !(r && deadRows.has(r.id)));
  }
  const replaceRow = (rowId, build) => {
    const idx = newRows.findIndex(r => r.id === rowId);
    if (idx < 0) return;
    const updated = build(newRows[idx]);
    if (updated) {
      newRows = arrReplace(newRows, idx, updated);
      if (!touched.includes(rowId)) touched.push(rowId);
    }
  };
  // 1) per-object field patches
  const objPatches = overlay.objects || {};
  const patchByRow = new Map();
  Object.keys(objPatches).forEach((objId) => {
    for (const row of newRows) {
      if (!Array.isArray(row.objects)) continue;
      if (row.objects.some(o => o && o.id === objId)) {
        if (!patchByRow.has(row.id)) patchByRow.set(row.id, []);
        patchByRow.get(row.id).push(objId);
        break;
      }
    }
  });
  patchByRow.forEach((ids, rowId) => {
    replaceRow(rowId, (row) => ({
      ...row,
      objects: row.objects.map(o => (o && ids.includes(o.id)) ? { ...o, ...cloneValue(objPatches[o.id]) } : o),
    }));
  });
  // 2) deletions
  const deleted = Array.isArray(overlay.deleted) ? overlay.deleted : [];
  if (deleted.length) {
    const dead = new Set(deleted);
    newRows = newRows.map(row => {
      if (!Array.isArray(row.objects)) return row;
      const kept = row.objects.filter(o => !(o && dead.has(o.id)));
      if (kept.length !== row.objects.length) {
        if (!touched.includes(row.id)) touched.push(row.id);
        return { ...row, objects: kept };
      }
      return row;
    });
  }
  // 3) per-row field patches (requireds etc.)
  const rowPatches = overlay.rowPatches || {};
  Object.keys(rowPatches).forEach((rowId) => {
    replaceRow(rowId, (row) => ({ ...row, ...cloneValue(rowPatches[rowId]) }));
  });
  // 4) row orders — GLOBAL pass: order lists may relocate objects across
  // rows (drag & drop between rows), so a listed id is pulled from ANY
  // ordered row; objects listed nowhere keep their original row/tail order.
  const rowOrder = overlay.rowOrder || {};
  const orderRowIds = Object.keys(rowOrder).filter(rid => Array.isArray(rowOrder[rid]) && rowOrder[rid].length > 0);
  if (orderRowIds.length) {
    const allListed = new Set();
    orderRowIds.forEach(rid => rowOrder[rid].forEach(id => allListed.add(id)));
    const pool = new Map(); // id -> object (from any ordered row)
    orderRowIds.forEach((rid) => {
      const row = newRows.find(r => r.id === rid);
      if (!row || !Array.isArray(row.objects)) return;
      row.objects.forEach(o => { if (o && o.id) pool.set(o.id, o); });
    });
    const desired = new Map(); // rowId -> final object list
    orderRowIds.forEach((rid) => {
      const list = rowOrder[rid].map(id => pool.get(id)).filter(Boolean);
      const row = newRows.find(r => r.id === rid);
      (row && Array.isArray(row.objects) ? row.objects : []).forEach(o => {
        if (o && o.id && !allListed.has(o.id)) list.push(o); // unlisted leftovers stay here
      });
      desired.set(rid, list);
    });
    orderRowIds.forEach((rid) => {
      replaceRow(rid, (row) => {
        const list = desired.get(rid) || [];
        const cur = Array.isArray(row.objects) ? row.objects : [];
        if (list.length !== cur.length || list.some((o, i) => cur[i] !== o)) return { ...row, objects: list };
        return null; // already correct
      });
    });
  }
  return { rows: newRows, touched };
}

// Fallback for the race where the page loaded before the overlay sync
// arrived: apply the overlay straight to the hooked live store (once).
// DEFERRED past any in-flight two-step remount (custom injection empties
// rows for 50ms) — applying mid-remount would snapshot emptied rows and
// lose the objects. Re-checks and retries a few times for safety.
function applyOverlayToLiveStore(attempt = 0) {
  try {
    if (!editorOverlay || overlayAppliedInFetch || overlayAppliedToLive) return;
    const store = findPiniaProjectStore();
    if (!store || !store.store || store.store.status !== 'loaded' || !store.store.file?.data || !Array.isArray(store.store.file.data.rows)) {
      if (attempt < 30) setTimeout(() => applyOverlayToLiveStore(attempt + 1), 1000);
      return;
    }
    const data = store.store.file.data;
    const rowOrder = editorOverlay.rowOrder || {};
    // Mid-remount guard: an ordered row that is empty while its order list
    // has entries means a two-step swap is in flight — wait for it.
    const midRemount = Object.keys(rowOrder).some(rid => {
      const row = data.rows.find(r => r.id === rid);
      return row && Array.isArray(row.objects) && row.objects.length === 0 && rowOrder[rid].length > 0;
    });
    if (midRemount && attempt < 6) { setTimeout(() => applyOverlayToLiveStore(attempt + 1), 120); return; }
    overlayAppliedToLive = true;
    const res = applyOverlayToRows(data.rows, editorOverlay);
    if (res.touched.length === 0 && res.rows.length === data.rows.length) return;
    const existed = new Set(data.rows.map(r => r && r.id));
    // New/deleted rows change the rows array itself: a plain full replacement
    // (new v-for entries mount fresh; removed entries unmount). Existing rows
    // whose objects changed still go through the two-step remount below.
    if (res.rows.length !== data.rows.length) {
      store.store = {
        ...store.store,
        file: { ...store.store.file, data: { ...data, rows: res.rows } },
      };
    }
    const existingTouched = res.touched.filter(rowId => existed.has(rowId));
    if (existingTouched.length === 0) return;
    const emptiedMap = new Map();
    const restoreMap = new Map();
    existingTouched.forEach((rowId) => {
      const origRow = data.rows.find(r => r.id === rowId);
      const newRow = res.rows.find(r => r.id === rowId);
      if (origRow) emptiedMap.set(rowId, { ...origRow, objects: [] });
      if (newRow) restoreMap.set(rowId, newRow);
    });
    swapRowsWithRemount(store, emptiedMap, restoreMap, '[Worm V17 Mod] Editor overlay applied to live store: ' + existingTouched.length + ' row(s)');
  } catch (err) {
    console.warn('[Worm V17 Mod] Failed to apply editor overlay to live store:', err);
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
// Every row swap (customs injection, removal, editor ops, overlay apply)
// funnels through here and is SERIALIZED: an in-flight two-step swap must
// never interleave with another (a restore built from emptied rows would
// corrupt the object lists). Deferred swaps re-run with identical args.
let lastRowSwapAt = 0;
function swapRowsWithRemount(store, emptiedMap, restoreMap, successLog, onDone) {
  const since = Date.now() - lastRowSwapAt;
  if (since < 120) {
    setTimeout(() => swapRowsWithRemount(store, emptiedMap, restoreMap, successLog, onDone), 120 - since);
    return;
  }
  lastRowSwapAt = Date.now();
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
      lastRowSwapAt = Date.now(); // keep the next swap from racing this restore
      const cur = store.store;
      const curRows = cur?.file?.data?.rows;
      if (!Array.isArray(curRows)) return;
      replaceRows(cur, restoreMap);
      if (successLog) console.log(successLog);
      if (onDone) onDone();
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

function applyChoicesToPiniaStore(store, choices, opts = {}) {
  try {
    // When the fetch interceptor already baked the customs into project.json,
    // re-injecting them live is redundant — and the extra remount can race
    // the overlay application. Single-choice popup adds pass { force: true }.
    if (customsBakedInFetch && !(opts && opts.force)) return false;
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
    let rows = data.rows;

    // Custom choices may target rows created in the editor: those rows only
    // exist via the overlay (overlay.rows). Inject them before merging so
    // their destination resolves (mirrors the fetch-interceptor ordering).
    if (editorOverlay && editorOverlay.rows) {
      const missing = choices.some(raw => raw && raw.rowId && !rows.some(r => r.id === raw.rowId) && editorOverlay.rows[raw.rowId]);
      if (missing) {
        rows = injectCreatedRows(rows, editorOverlay);
        store.store = {
          ...store.store,
          file: { ...file, data: { ...data, rows } },
        };
      }
    }

    // Merge the normalized choices into COPIES of their target rows, keyed by rowId.
    // Untouched rows keep their original object references.
    const newRowById = new Map();
    for (const raw of choices) {
      let choice = normalizeChoice(raw, data.pointTypes || []);
      // Layer consistency: the fetch-interceptor path bakes customs first and
      // applies editorOverlay.objects[id] patches second. Live re-injection
      // (SYNC_CUSTOM_CHOICES, single-choice adds, the store-hook fallback)
      // must reproduce that ordering, or a stale saved copy would clobber
      // editor edits (scores, requireds, width…).
      const ovlPatch = editorOverlay && editorOverlay.objects ? editorOverlay.objects[choice.id] : null;
      if (ovlPatch) choice = { ...choice, ...cloneValue(ovlPatch) };
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


