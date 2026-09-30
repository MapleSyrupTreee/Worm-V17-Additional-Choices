// content-overlay-store.js — persistence layer for editor mutations.
// Keeps the compact editorOverlay record and the customChoices registry in
// chrome.storage.local in sync with what the editor engine did.
const EDITOR_OVERLAY_KEY = 'editorOverlay';
let overlayQueue = Promise.resolve(); // serialize storage read-modify-write

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

async function editorPurgeCustomChoicesInRow(rowId) {
  // Deleting a custom row removes its custom choices too — otherwise the
  // fetch interceptor would re-bake them into a row that no longer exists.
  try {
    if (!rowId) return;
    const { customChoices = [] } = await chrome.storage.local.get('customChoices');
    const filtered = customChoices.filter(c => c && c.rowId !== rowId);
    if (filtered.length !== customChoices.length) {
      await chrome.storage.local.set({ customChoices: filtered });
    }
  } catch (err) {
    console.warn('[Worm V17 Mod] Failed to purge custom choices of deleted row:', err);
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

// Local deep clone — content-overlay-store runs in the ISOLATED world where
// page-shared's cloneValue() is NOT available.
function overlayClone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (err) { return value; }
}

// ==========================================================================
// Editor overlay persistence (Phase 5): every engine op updates a compact
// overlay record in chrome.storage; page-script re-applies it to the
// freshly-fetched project.json on every page load (fetch-interceptor path,
// with a live-store fallback if the sync arrives after load).
// overlay = { version: 1, objects: {objId: patch}, deleted: [objId],
//             rowPatches: {rowId: patch}, rowOrder: {rowId: [objId,...]},
//             rows: {rowId: {row, afterRowId}},            (created rows; '' anchor = top)
//             deletedRows: [rowId], moves: [...] }
// ==========================================================================

function overlayRowIdOf(snapshot, objId) {
  if (!snapshot || !Array.isArray(snapshot.rows)) return null;
  for (const r of snapshot.rows) {
    if (Array.isArray(r.objects) && r.objects.some(o => o && o.id === objId)) return r.id;
  }
  return null;
}

// Row insertion anchor for a created/moved row: the id of the row that now
// precedes it in the post-op snapshot ('' = row sits at the very top).
function overlayRowAnchorFromSnapshot(snapshot, rowId) {
  if (!snapshot || !Array.isArray(snapshot.rows)) return '';
  const idx = snapshot.rows.findIndex(r => r && r.id === rowId);
  if (idx <= 0) return '';
  return snapshot.rows[idx - 1].id || '';
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
      const overlay = (raw && raw.version === 1) ? raw : { version: 1, objects: {}, deleted: [], rowPatches: {}, rowOrder: {}, rows: {}, deletedRows: [] };
      overlay.objects = overlay.objects || {};
      overlay.deleted = Array.isArray(overlay.deleted) ? overlay.deleted : [];
      overlay.rowPatches = overlay.rowPatches || {};
      overlay.rowOrder = overlay.rowOrder || {};
      overlay.rows = (overlay.rows && typeof overlay.rows === 'object') ? overlay.rows : {}; // created rows
      overlay.deletedRows = Array.isArray(overlay.deletedRows) ? overlay.deletedRows : [];
      overlay.moves = Array.isArray(overlay.moves) ? overlay.moves : []; // {id, from, to} move log
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
            // A created (custom) row keeps its full definition in overlay.rows:
            // merge the patch there too so re-application stays current.
            if (overlay.rows[op.rowId] && overlay.rows[op.rowId].row) {
              overlay.rows[op.rowId].row = { ...overlay.rows[op.rowId].row, ...overlayClone(op.patch) };
            }
            touched = true;
          }
          break;
        case 'addRow': {
          const row = op.row || null;
          const rid = row && row.id;
          if (rid) {
            overlay.rows[rid] = { row: overlayClone(row), afterRowId: overlayRowAnchorFromSnapshot(snapshot, rid) };
            touched = true;
          }
          break;
        }
        case 'deleteRow': {
          const rid = op.rowId;
          if (rid) {
            if (overlay.rows[rid]) delete overlay.rows[rid];
            else if (!overlay.deletedRows.includes(rid)) overlay.deletedRows.push(rid);
            delete overlay.rowPatches[rid];
            delete overlay.rowOrder[rid];
            // Scrub object patches/moves for choices that lived in this row.
            const objIds = (data.extra && data.extra.deletedObjectIds) || [];
            objIds.forEach((id) => { delete overlay.objects[id]; });
            overlay.moves = overlay.moves.filter(m => !objIds.includes(m.id));
            touched = true;
          }
          break;
        }
        case 'restoreRow': {
          const row = op.row || null;
          const rid = row && row.id;
          if (rid) {
            overlay.deletedRows = overlay.deletedRows.filter(id => id !== rid);
            // Re-created custom rows must re-enter overlay.rows so they
            // survive a reload (undo of a custom-row delete).
            if (row.isCustom) {
              overlay.rows[rid] = { row: overlayClone(row), afterRowId: overlayRowAnchorFromSnapshot(snapshot, rid) };
            }
            touched = true;
          }
          break;
        }
        case 'moveRow': {
          const rid = op.rowId;
          // Only created rows need a recorded anchor — baseline row moves are
          // not currently offered in the UI.
          if (rid && overlay.rows[rid]) {
            overlay.rows[rid].afterRowId = overlayRowAnchorFromSnapshot(snapshot, rid);
            touched = true;
          }
          break;
        }
        case 'moveObject': {
          const destIds = overlayIdsOfRow(snapshot, op.toRowId);
          if (destIds) { overlay.rowOrder[op.toRowId] = destIds; touched = true; }
          // Source row (from the PRE-op snapshot) also needs its order refreshed.
          const srcRowId = overlayRowIdOf(prevData, op.objId);
          if (srcRowId && srcRowId !== op.toRowId) {
            const srcIds = overlayIdsOfRow(snapshot, srcRowId);
            if (srcIds) { overlay.rowOrder[srcRowId] = srcIds; touched = true; }
          }
          // Record the move for the popup's "Editor Edits" list. An exact
          // reverse of the previous move (undo) pops the entry instead.
          if (srcRowId) {
            const lastMove = overlay.moves[overlay.moves.length - 1];
            if (lastMove && lastMove.id === op.objId && lastMove.from === op.toRowId && lastMove.to === srcRowId) {
              overlay.moves.pop();
            } else {
              overlay.moves.push({ id: op.objId, from: srcRowId, to: op.toRowId });
              if (overlay.moves.length > 200) overlay.moves = overlay.moves.slice(-200);
            }
            touched = true;
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
          // Custom choices (user-created) are purged from customChoices by
          // editorPurgeDeletedCustomChoices instead — they must NOT enter
          // overlay.deleted, or the Editor Edits list would report them as
          // deleted original choices (their id no longer resolves as custom
          // once purged). Also scrub ids of previously-recorded customs to
          // heal overlays written before this rule existed.
          const customIds = new Set((data.extra && Array.isArray(data.extra.customIds)) ? data.extra.customIds : []);
          if (ids.length) {
            const baselineIds = ids.filter(id => !customIds.has(id));
            overlay.deleted = Array.from(new Set([...overlay.deleted, ...baselineIds]));
            overlay.deleted = overlay.deleted.filter(id => !customIds.has(id));
            baselineIds.forEach((id) => { delete overlay.objects[id]; });
            customIds.forEach((id) => { delete overlay.objects[id]; });
            overlay.moves = overlay.moves.filter(m => !ids.includes(m.id));
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


