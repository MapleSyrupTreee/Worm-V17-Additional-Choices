// content.js - Isolated content script bridge & UI injection

(function () {
  console.log('[Worm V17 Mod] Content script loaded on:', window.location.href);

  let detectedMetadata = {
    detected: false,
    rows: [],
    pointTypes: []
  };

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

      // Re-sync choices with new point types to ensure clean afterText
      syncSavedChoicesToPage();
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
      openAddChoiceModal();
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
    }
  });

  // 4. In-Page "Add Choice" Modal
  function openAddChoiceModal(preselectedRowId = '') {
    if (document.getElementById('worm-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'worm-modal-overlay';

    // Generate options for category dropdown
    const rowOptionsHtml = detectedMetadata.rows.length > 0
      ? detectedMetadata.rows.map(r => `<option value="${escapeHtml(r.id)}" ${r.id === preselectedRowId ? 'selected' : ''}>${escapeHtml(r.title)} (${r.count} choices)</option>`).join('')
      : '<option value="">No categories detected (reload CYOA tab)</option>';

    // Generate options for point type dropdown
    const pointOptionsHtml = detectedMetadata.pointTypes.length > 0
      ? detectedMetadata.pointTypes.map(pt => `<option value="${escapeHtml(pt.id)}">${escapeHtml(pt.name || pt.id)}</option>`).join('')
      : '<option value="default">Points</option>';

    overlay.innerHTML = `
      <div id="worm-modal-dialog">
        <div class="worm-modal-header">
          <h3><span class="worm-modal-glyph">✦</span> Add Custom Choice</h3>
          <button class="worm-modal-close-btn" id="worm-modal-close" title="Close">&times;</button>
        </div>
        <form id="worm-add-choice-form">
          <div class="worm-modal-body">
            <div class="worm-form-group">
              <label for="worm-target-row">Destination</label>
              <select id="worm-target-row" class="worm-form-select" required>
                ${rowOptionsHtml}
              </select>
            </div>

            <div class="worm-form-group">
              <label for="worm-choice-title">Choice Title</label>
              <input type="text" id="worm-choice-title" class="worm-form-input" placeholder="e.g. Master-Stranger Inversion" required />
            </div>

            <div class="worm-form-group">
              <label for="worm-choice-text">Description</label>
              <textarea id="worm-choice-text" class="worm-form-textarea" placeholder="Detailed lore, effect description, or rules for this option..."></textarea>
            </div>

            <div class="worm-form-group">
              <label>Point Modifier</label>
              <div class="worm-modifier-grid">
                <div class="worm-segmented" role="group" aria-label="Effect type">
                  <button type="button" class="worm-seg-btn is-active" data-effect="cost">− Cost</button>
                  <button type="button" class="worm-seg-btn" data-effect="gain">+ Gain</button>
                </div>
                <input type="number" id="worm-point-amount" class="worm-form-input" placeholder="0" min="0" value="5" />
              </div>
              <select id="worm-point-type" class="worm-form-select worm-mt8">
                ${pointOptionsHtml}
              </select>
            </div>

            <div class="worm-form-group">
              <label for="worm-choice-image">Image URL <span class="worm-label-soft">(optional)</span></label>
              <input type="url" id="worm-choice-image" class="worm-form-input" placeholder="https://example.com/image.png" />
            </div>
          </div>

          <div class="worm-modal-footer">
            <button type="button" class="worm-btn-secondary" id="worm-modal-cancel">Cancel</button>
            <button type="submit" class="worm-btn-primary">Add to CYOA</button>
          </div>
        </form>
      </div>
    `;

    function closeModal() {
      overlay.remove();
    }

    overlay.querySelector('#worm-modal-close').addEventListener('click', closeModal);
    overlay.querySelector('#worm-modal-cancel').addEventListener('click', closeModal);
    overlay.querySelectorAll('.worm-seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.worm-seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    overlay.querySelector('#worm-add-choice-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const rowId = overlay.querySelector('#worm-target-row').value;
      const title = overlay.querySelector('#worm-choice-title').value.trim();
      const text = overlay.querySelector('#worm-choice-text').value.trim();
      const activeSeg = overlay.querySelector('.worm-seg-btn.is-active');
      const effect = activeSeg ? activeSeg.dataset.effect : 'cost'; // 'cost' or 'gain'
      const amount = Math.abs(parseInt(overlay.querySelector('#worm-point-amount').value, 10)) || 0;
      const pointTypeId = overlay.querySelector('#worm-point-type').value;
      const image = overlay.querySelector('#worm-choice-image').value.trim();

      if (!rowId || !title) {
        alert('Please select a category and provide a title.');
        return;
      }

      const selectedPt = detectedMetadata.pointTypes.find(p => p.id === pointTypeId);
      const ptName = selectedPt ? (selectedPt.name || selectedPt.id) : 'Points';
      const ptAbbr = abbreviatePointName(ptName);
      const isGain = effect === 'gain';

      const scores = [];
      if (pointTypeId && amount > 0) {
        scores.push({
          id: pointTypeId,
          value: isGain ? String(-amount) : String(amount),
          beforeText: isGain ? 'Gain:' : 'Cost:',
          afterText: ptAbbr,
          requireds: []
        });
      }

      const newChoice = {
        id: 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
        rowId,
        title,
        text,
        image,
        scores,
        requireds: [],
        addons: [],
        groups: [],
        isSelectableMultiple: false,
        isNotSelectable: false,
        isVisible: true,
        isDefault: false,
        isPrivateStyling: false,
        styling: null,
        template: 1,
        isCustom: true
      };

      await handleInjectChoice(newChoice);
      closeModal();
    });

    document.body.appendChild(overlay);
  }

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

  function ensureEditorToggle() {
    if (document.getElementById('worm-edit-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'worm-edit-toggle';
    btn.className = 'worm-editor-ui';
    btn.type = 'button';
    btn.textContent = '✎ Edit CYOA';
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
      EDITOR_UI.toggleBtn.textContent = enabled ? '✓ Done Editing' : '✎ Edit CYOA';
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
    if (data.snapshot && EDITOR_UI.active) EDITOR_UI.data = data.snapshot;
    if (!EDITOR_UI.active) return;
    const keep = EDITOR_UI.selection && EDITOR_UI.selection.objId;
    if (data.label) showToast(data.label);
    if (data.opType === 'deleteObjects' && Array.isArray(data.deletedIds) && data.deletedIds.length > 0) {
      editorPurgeDeletedCustomChoices(data.deletedIds);
    } else if (data.opType === 'duplicateObject' && data.extra && data.extra.object) {
      editorTrackDuplicate(data.extra.object);
    }
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

  async function editorTrackDuplicate(object) {
    // Duplicated choices are user-created: track them like other custom
    // choices so they persist across reloads.
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
      <button type="button" data-act="delete" title="Delete this choice (Del)">🗑</button>`;
    toolbar.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (!act || !EDITOR_UI.selection) return;
      if (act === 'edit') editorOpenEditModal(EDITOR_UI.selection.objId);
      else if (act === 'duplicate') editorDuplicate(EDITOR_UI.selection.objId);
      else if (act === 'delete') editorDelete(EDITOR_UI.selection.objId);
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
    if (EDITOR_UI.clickHandler) document.removeEventListener('click', EDITOR_UI.clickHandler, true);
    if (EDITOR_UI.keyHandler) document.removeEventListener('keydown', EDITOR_UI.keyHandler, true);
    editorRemoveRowBars();
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
        openAddChoiceModal(rowData.id);
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

  function editorOnCaptureClick(e) {
    if (!EDITOR_UI.active) return;
    if (e.target.closest('.worm-editor-ui, #worm-editor-layer, #worm-modal-overlay, #worm-confirm-overlay')) return;
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

  async function editorOpenEditModal(objId) {
    if (document.getElementById('worm-modal-overlay')) return;
    const resp = await editorRequest('EDITOR_GET_OBJECT', { objId });
    if (!resp || !resp.object) { showToast('Could not load that choice.'); return; }
    const obj = resp.object;
    const original = JSON.parse(JSON.stringify(obj));
    const pointTypes = (EDITOR_UI.data && EDITOR_UI.data.pointTypes) || [];
    const esc = escapeHtml;
    const isEmbeddedImage = typeof obj.image === 'string' && obj.image.startsWith('data:');
    const imageShown = isEmbeddedImage ? '' : (obj.image || '');
    const rowWidth = resp.rowWidth || '';
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

    // Section activation state: rows whose visibility conditions reference
    // this choice ({type:'id', reqId}). required=true → row shows when this
    // choice is picked; required=false → row hides when picked.
    const actState = (resp.activatedRows || []).map(a => {
      const requireds = a.requireds || [];
      let origIdx = -1;
      for (let i = 0; i < requireds.length; i++) {
        const t = requireds[i];
        if (t && t.type === 'id' && t.reqId === objId) { origIdx = i; break; }
      }
      return { rowId: a.id, title: a.title, required: !!a.required, requireds, isNew: false };
    });
    const removedActs = [];
    const rowsWithTerms = resp.rowsWithTerms || [];
    const allRowsList = (EDITOR_UI.data && EDITOR_UI.data.rows) || [];

    const overlay = document.createElement('div');
    overlay.id = 'worm-modal-overlay';
    overlay.innerHTML = `
      <div id="worm-modal-dialog">
        <div class="worm-modal-header">
          <h3><span class="worm-modal-glyph">✎</span> Edit Choice</h3>
          <button type="button" class="worm-modal-close-btn" id="we-close" title="Close">&times;</button>
        </div>
        <form id="we-form">
          <div class="worm-modal-body">
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
            </div>
            <div class="worm-form-group">
              <label>Behavior</label>
              <div class="worm-check-grid">
                <label class="worm-check"><input type="checkbox" id="we-visible"${original.isVisible === false ? '' : ' checked'}><span>Visible</span></label>
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
            <div class="worm-form-group worm-narrow">
              <label for="we-template">Template #</label>
              <input type="number" id="we-template" class="worm-form-input" min="1" value="${esc(String(original.template ?? 1))}">
            </div>
          </div>
          <div class="worm-modal-footer">
            <button type="button" class="worm-btn-ghost-sm" id="we-reset">Reset</button>
            <span class="worm-footer-spacer"></span>
            <button type="button" class="worm-btn-secondary" id="we-cancel">Cancel</button>
            <button type="submit" class="worm-btn-primary">Save Changes</button>
          </div>
        </form>
      </div>`;

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

      const visible = overlay.querySelector('#we-visible').checked;
      if (visible !== (original.isVisible !== false)) patch.isVisible = visible;
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

      const tpl = parseInt(overlay.querySelector('#we-template').value, 10) || 1;
      if (tpl !== (Number(original.template) || 1)) patch.template = tpl;
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
    overlay.querySelector('#we-act-add').addEventListener('click', () => {
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
    renderActRows();
    renderActRowSelect();
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
      overlay.querySelector('#we-visible').checked = original.isVisible !== false;
      overlay.querySelector('#we-notsel').checked = !!original.isNotSelectable;
      overlay.querySelector('#we-multi').checked = !!original.isSelectableMultiple;
      overlay.querySelector('#we-multi-limits').hidden = !original.isSelectableMultiple;
      overlay.querySelector('#we-maxpicks').value = String(original.numMultipleTimesPluss ?? 1);
      overlay.querySelector('#we-minpicks').value = String(original.numMultipleTimesMinus ?? 0);
      overlay.querySelector('#we-activatethis').value = original.activateThisChoice || '';
      overlay.querySelector('#we-deactivatethis').value = original.deactivateThisChoice || '';
      overlay.querySelector('#we-actother').checked = !!original.activateOtherChoice;
      overlay.querySelector('#we-deactother').checked = !!original.deactivateOtherChoice;
      overlay.querySelector('#we-template').value = String(original.template ?? 1);
    });
    overlay.querySelector('#we-form').addEventListener('submit', async (e) => {
      e.preventDefault();
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
