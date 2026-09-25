// content-edits-summary.js — resolves the persisted editorOverlay +
// customChoices into a human-readable "editor edits" summary for the popup
// (edited fields, moved choices, deleted choices). Titles come from a live
// EDITOR_GET_DATA snapshot when a loaded CYOA page is reachable; without one,
// deletions and field edits still resolve from storage alone, while move
// detection needs the snapshot and is skipped (ids would be meaningless).
// Classic script — loaded by BOTH the content-script world (manifest) and the
// popup (script tag), so the exact same logic serves both callers.
function overlaySummarizeEdits(overlay, customChoices, snapshot, rowTitleFallback) {
  const ov = (overlay && overlay.version === 1)
    ? overlay
    : { objects: {}, deleted: [], rowPatches: {}, rowOrder: {}, moves: [] };
  const objects = ov.objects || {};
  const deleted = Array.isArray(ov.deleted) ? ov.deleted : [];
  const moves = Array.isArray(ov.moves) ? ov.moves : [];
  const customIds = new Set((Array.isArray(customChoices) ? customChoices : []).map(c => c && c.id));

  // id → title lookups from the live snapshot (when available)
  const titles = new Map();
  const rowTitles = new Map();
  if (rowTitleFallback) {
    Object.keys(rowTitleFallback).forEach((rid) => rowTitles.set(rid, rowTitleFallback[rid]));
  }
  if (snapshot && Array.isArray(snapshot.rows)) {
    snapshot.rows.forEach((r) => {
      if (!r || !r.id) return;
      rowTitles.set(r.id, r.title || r.id);
      titles.set(r.id, r.title || r.id);
      (Array.isArray(r.objects) ? r.objects : []).forEach((o) => {
        if (!o || !o.id) return;
        titles.set(o.id, o.title || o.id);
      });
    });
  }
  const titleOf = (id) => titles.get(id) || String(id || '');
  const rowTitleOf = (id) => rowTitles.get(id) || String(id || '');

  const items = [];

  // Human labels for what a stored object patch touches.
  const patchParts = (patch) => {
    if (!patch) return ['fields'];
    const parts = [];
    if (patch.title != null) parts.push('renamed');
    if (patch.text != null) parts.push('description');
    if (patch.image != null) parts.push('image');
    if (patch.objectWidth != null) parts.push('width');
    if (patch.scores != null) parts.push('points');
    if (patch.requireds != null) parts.push('requirements');
    if (patch.addons != null) parts.push('addons');
    if (patch.isNotSelectable != null) parts.push(patch.isNotSelectable ? 'not selectable' : 'selectable');
    if (patch.isSelectableMultiple != null) parts.push(patch.isSelectableMultiple ? 'multi-pick' : 'single-pick');
    if (patch.numMultipleTimesPluss != null || patch.numMultipleTimesMinus != null) parts.push('pick limits');
    if (patch.activateThisChoice != null || patch.deactivateThisChoice != null) parts.push('activation ids');
    if (parts.length === 0) parts.push('fields');
    return parts;
  };

  // 1) Edited choices (field patches on baseline objects)
  Object.keys(objects).forEach((objId) => {
    if (customIds.has(objId)) return;
    const patch = objects[objId];
    // Skip pure ordering side effects: some flows store an id-only patch.
    if (!patch || Object.keys(patch).length === 0) return;
    items.push({ kind: 'edited', title: titleOf(objId), detail: 'edited: ' + patchParts(patch).join(', ') });
  });

  // 2) Moved choices — from the overlay's move log (recorded per moveObject
  // op; an undo pops the reverse entry). Latest move per object wins.
  const deletedSet = new Set(deleted);
  const moveMap = new Map();
  moves.forEach((m) => {
    if (m && m.id && !customIds.has(m.id)) moveMap.set(m.id, m);
  });
  moveMap.forEach((m, id) => {
    if (deletedSet.has(id)) return; // moved then deleted → the deleted entry covers it
    const fromRow = rowTitleOf(m.from);
    const toRow = m.to === m.from ? fromRow : rowTitleOf(m.to);
    items.push({
      kind: 'moved',
      title: titleOf(id),
      detail: m.to === m.from
        ? 'reordered within “' + fromRow + '”'
        : 'moved: ' + fromRow + ' → ' + toRow,
    });
  });

  // 3) Deleted choices
  deleted.forEach((id) => {
    if (!id || customIds.has(id)) return;
    items.push({ kind: 'deleted', title: titleOf(id), detail: 'deleted choice' });
  });

  return items;
}
