// content-editor-dragdrop.js — pointer-based drag & drop of choices between
// rows (ghost, insertion indicator, edge auto-scroll), capture-phase click
// selection, keyboard shortcuts, duplicate/delete actions.
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


