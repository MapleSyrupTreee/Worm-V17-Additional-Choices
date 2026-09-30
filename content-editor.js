// content-editor.js — interactive editor shell ("Worm Forge"): mode
// toggling, postMessage transport with request ids, DOM<->data card indexing,
// id badges, selection chrome, row add-bars, enter/exit lifecycle.

// =========================================================================
// 7. Interactive Editor ("Worm Forge")
//    Toggle button → edit mode over the live viewer. Cards are matched to
//    store objects by unique title with an order-based fallback; the mapping
//    lives here in the isolated world and is rebuilt after every mutation
//    broadcast. Selection chrome is plain DOM + fixed layers.
// =========================================================================

const EDITOR_UI = {
  active: false,
  data: null,        // snapshot { rows, pointTypes, projectName }
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

async function ensureEditorToggle() {
  if (!isEditorAllowedLocation()) return;
  if (document.getElementById('worm-edit-toggle')) return;
  // Visibility is user-controlled from the popup (chrome.storage key
  // 'showEditorToggle', default visible). Ctrl+E keeps working even when the
  // button is hidden.
  let showToggle = true;
  try {
    const res = await chrome.storage.local.get('showEditorToggle');
    showToggle = res.showEditorToggle !== false;
  } catch (err) { /* storage unavailable — default to visible */ }
  const btn = document.createElement('button');
  btn.id = 'worm-edit-toggle';
  btn.className = 'worm-editor-ui';
  btn.type = 'button';
  btn.textContent = 'Edit CYOA';
  btn.title = 'Toggle the interactive editor (Ctrl+E)';
  btn.hidden = !showToggle;
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
  editorSend('EDITOR_SET_MODE', { enabled });
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
    editorEnter();
    showToast('Editor on — click a choice to select it. Ctrl+E to exit.');
  } else {
    editorExit();
  }
}

function editorHandleDataChanged(data) {
  if (!data) return;
  if (EDITOR_UI.dragState) editorEndDrag(false); // card geometry is about to change
  const prevData = EDITOR_UI.data; // pre-op snapshot (source-row lookup for moves)
  if (data.snapshot && EDITOR_UI.active) EDITOR_UI.data = data.snapshot;
  if (data.op && data.snapshot) overlayApplyOp(data, prevData);
  // Storage bookkeeping must run even when the editor UI is off (e.g. the
  // last op before an exit, or broadcasts racing the toggle).
  if (data.opType === 'deleteObjects' && Array.isArray(data.deletedIds) && data.deletedIds.length > 0) {
    editorPurgeDeletedCustomChoices(data.deletedIds);
  } else if ((data.opType === 'duplicateObject' || data.opType === 'addObject') && data.extra && data.extra.object) {
    editorTrackNewChoice(data.extra.object);
  } else if (data.opType === 'restoreObjects' && data.extra && Array.isArray(data.extra.customs) && data.extra.customs.length > 0) {
    // Undoing a custom-choice delete: re-track the restored customs in
    // storage (their delete purged them), so they survive a reload.
    data.extra.customs.forEach(obj => editorTrackNewChoice(obj));
  } else if (data.opType === 'deleteRow' && data.op && data.op.rowId) {
    // Deleting a row purges the custom choices that lived in it from storage
    // (the overlay recorder scrubs the row's overlay entries itself).
    editorPurgeCustomChoicesInRow(data.op.rowId);
  } else if (data.opType === 'restoreRow' && data.op && data.op.row && data.op.row.isCustom) {
    // Undoing a custom-row delete: re-track the row's custom choices so the
    // restored row's contents survive a reload.
    ((data.op.row.objects) || []).forEach(o => { if (o && o.isCustom) editorTrackNewChoice(o); });
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


// Opens the Add-Choice dialog positioned directly after a reference choice.
// Uses EDITOR_GET_OBJECT's reply (rowId + 0-based index of the reference card);
// addObject inserts AT the given index, so pass refIndex + 1 to land AFTER it.
async function editorInsertAfter(objId) {
  const resp = await editorRequest('EDITOR_GET_OBJECT', { objId });
  if (!resp || !resp.object || !resp.rowId) {
    showToast('Could not locate that choice.');
    return;
  }
  openChoiceModal({
    preselectedRowId: resp.rowId,
    insertAfter: { rowId: resp.rowId, index: (typeof resp.index === 'number' ? resp.index : -1) + 1, title: resp.object.title || '' },
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
    <button type="button" data-act="drag" class="worm-drag-handle" title="Drag to move this choice — hold, move, release">⠿</button>
    <button type="button" data-act="edit" title="Edit this choice">✎ Edit</button>
    <button type="button" data-act="insert" title="Insert a new choice right after this one">＋ Insert after</button>
    <button type="button" data-act="addrow" title="Create a new custom row">＋ Row</button>
    <button type="button" data-act="duplicate" title="Duplicate this choice">⧉</button>
    <button type="button" data-act="delete" title="Delete this choice (Del)">🗑</button>`;
  toolbar.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = e.target && e.target.dataset ? e.target.dataset.act : null;
    if (!act || !EDITOR_UI.selection) return;
    if (act === 'edit') openChoiceModal({ objId: EDITOR_UI.selection.objId });
    else if (act === 'insert') editorInsertAfter(EDITOR_UI.selection.objId);
    else if (act === 'addrow') openRowModal({});
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
    if (rowData.isCustom) {
      // Custom rows can be edited and deleted from their row bar.
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit this custom row';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRowModal({ rowId: rowData.id });
      });
      bar.appendChild(editBtn);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '🗑';
      delBtn.title = 'Delete this custom row (and its choices) — you can undo with Ctrl+Z';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await wormConfirm('Delete this row and all choices in it? You can undo with Ctrl+Z.');
        if (!ok) return;
        await editorRequest('EDITOR_OP', { op: { type: 'deleteRow', rowId: rowData.id } });
      });
      bar.appendChild(delBtn);
    }
    header.appendChild(bar);
    EDITOR_UI.rowBars.push(bar);
  });
}

function editorRemoveRowBars() {
  EDITOR_UI.rowBars.forEach(bar => bar.remove());
  EDITOR_UI.rowBars = [];
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


