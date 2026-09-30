// content-choice-modal.js — the shared Add/Edit Choice dialog and the
// delete-confirm dialog. One dialog serves both add (blank + destination) and
// edit (loads object, plus section-activation editor).
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
  // "Insert after" (editor toolbar ＋ button): an Add-mode dialog locked to a
  // row with an exact insertion index (right after the reference choice).
  const insertAfter = (opts && opts.insertAfter) || null;
  let resp = null;
  let obj;
  if (isAdd) {
    if (!EDITOR_UI.data) { showToast('Editor data not ready — reopen the editor.'); return; }
    obj = {
      title: '', text: '', image: '', objectWidth: '',
      scores: [], requireds: [], addons: [],
      isNotSelectable: false, isSelectableMultiple: false,
      // V17 convention (Viewer.md §4): pick amounts are strings — the
      // viewer parseInt()s them at runtime.
      numMultipleTimesPluss: '1', numMultipleTimesMinus: '0',
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

  // Addon state (Viewer.md §4/§10.2): V17 addons are {id, image, requireds,
  // template, text, title} — no scores. We edit title/text + one optional
  // {type:'id'} requirement; any other requirement terms are kept verbatim.
  const originalAddons = Array.isArray(original.addons) ? original.addons : [];
  function addonStateFrom(a) {
    const terms = Array.isArray(a.requireds) ? a.requireds : [];
    const idTerm = terms.find(t => t && t.type === 'id');
    return {
      id: a.id || '',
      title: a.title || '',
      text: a.text || '',
      image: a.image || '',
      template: a.template == null ? 1 : a.template,
      requiredKind: idTerm ? (idTerm.required ? 'required' : 'incompatible') : '',
      reqId: idTerm ? (idTerm.reqId || '') : '',
      keptTerms: terms.filter(t => !(t && t.type === 'id')),
      expanded: false,
    };
  }
  const addonsState = originalAddons.map(addonStateFrom);

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
            <label for="we-dest">Destination <span class="worm-label-soft">${insertAfter ? '(locked — inserting after “' + esc(insertAfter.title) + '”)' : ''}</span></label>
            <select id="we-dest" class="worm-form-select"${insertAfter ? ' disabled' : ''}>
              ${(() => {
                const custom = allRowsList.filter(r => r.isCustom);
                const base = allRowsList.filter(r => !r.isCustom);
                // Custom (user-created) rows float to the top, clearly marked.
                const opt = (r) => `<option value="${esc(r.id)}"${r.id === (insertAfter ? insertAfter.rowId : preselectedRowId) ? ' selected' : ''}>${r.isCustom ? '⭑ ' : ''}${esc(r.title || r.id)} (${(r.objects || []).length} choices)${r.isCustom ? ' — custom' : ''}</option>`;
                return custom.map(opt).join('') + base.map(opt).join('');
              })()}
            </select>
            ${insertAfter ? `<input type="hidden" id="we-dest-index" value="${insertAfter.index}">` : ''}
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
            <div class="worm-sec-head">Point Modifiers</div>
            <div id="we-scores">${scoreRowsHtml}</div>
            <div class="worm-empty-hint" id="we-scores-hint"${scoreRowsHtml ? ' hidden' : ''}>No point modifiers on this choice — use “+ Add Modifier”.</div>
            <button type="button" id="we-add-score" class="worm-btn-ghost-sm worm-mt8">+ Add Modifier</button>
          </div>
          <div class="worm-form-group">
            <div class="worm-sec-head">Requirements <span class="worm-label-soft">(this choice needs/is blocked by other choices)</span></div>
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
            <div class="worm-sec-head">Section Activation <span class="worm-label-soft">(rows gated by this choice)</span></div>
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
            <div class="worm-sec-head">Addons <span class="worm-label-soft">(nested sub-items shown under this choice)</span></div>
            <div id="we-addon-rows"></div>
            <button type="button" id="we-addon-add" class="worm-btn-ghost-sm worm-mt8">+ Add Addon</button>
          </div>
          <div class="worm-form-group">
            <div class="worm-sec-head">Behavior</div>
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

    const actThis = overlay.querySelector('#we-activatethis').value.trim();
    if (actThis !== (original.activateThisChoice || '')) patch.activateThisChoice = actThis;
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

  // ---- Addons editor -------------------------------------------------------
  function newAddonId() {
    // 8-char base36, matching real V17 addon ids (e.g. "4zee9ka1").
    let id = '';
    for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 36).toString(36);
    return id;
  }

  function addonRequirementTerm(required, reqId) {
    // Same {type:'id'} ConditionTerm shape used for choice requirements
    // (buildRequirementTerm), scoped to the addon entry.
    const term = buildRequirementTerm(required);
    term.reqId = reqId;
    return term;
  }

  function addonRequiredsFromState(a) {
    const next = [];
    if (a.requiredKind && a.reqId) {
      next.push(addonRequirementTerm(a.requiredKind === 'required', a.reqId));
    }
    return next.concat(a.keptTerms.map(t => JSON.parse(JSON.stringify(t))));
  }

  function renderAddons() {
    const wrap = overlay.querySelector('#we-addon-rows');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (addonsState.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'worm-empty-hint';
      hint.textContent = 'No addons on this choice — use “+ Add Addon”.';
      wrap.appendChild(hint);
      return;
    }
    addonsState.forEach((a, idx) => {
      const row = document.createElement('div');
      row.className = 'worm-addon-row' + (a.expanded ? ' open' : '');
      const head = document.createElement('div');
      head.className = 'worm-addon-head';
      const title = document.createElement('span');
      title.className = 'worm-addon-title';
      title.textContent = a.title || '(untitled addon)';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'worm-addon-toggle';
      toggle.title = 'Edit this addon';
      toggle.textContent = a.expanded ? '▴' : '▾';
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'worm-act-remove';
      rm.title = 'Remove this addon';
      rm.textContent = '×';
      head.addEventListener('click', () => {
        a.expanded = !a.expanded;
        renderAddons();
      });
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        addonsState.splice(idx, 1);
        renderAddons();
      });
      head.appendChild(title);
      head.appendChild(toggle);
      head.appendChild(rm);
      row.appendChild(head);
      if (a.expanded) {
        const body = document.createElement('div');
        body.className = 'worm-addon-body';
        const titleGroup = document.createElement('div');
        titleGroup.className = 'worm-form-group';
        titleGroup.innerHTML = '<label>Addon Title</label>';
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.className = 'worm-form-input';
        titleInput.value = a.title;
        titleInput.addEventListener('input', () => { a.title = titleInput.value; });
        titleGroup.appendChild(titleInput);
        const textGroup = document.createElement('div');
        textGroup.className = 'worm-form-group';
        textGroup.innerHTML = '<label>Addon Description</label>';
        const textArea = document.createElement('textarea');
        textArea.className = 'worm-form-textarea';
        textArea.value = a.text;
        textArea.addEventListener('input', () => { a.text = textArea.value; });
        textGroup.appendChild(textArea);
        const reqGrid = document.createElement('div');
        reqGrid.className = 'worm-act-add';
        const kindSel = document.createElement('select');
        kindSel.className = 'worm-form-select';
        kindSel.innerHTML = `
          <option value="">No requirement</option>
          <option value="required">Needs a choice</option>
          <option value="incompatible">Blocked by a choice</option>`;
        kindSel.value = a.requiredKind || '';
        kindSel.addEventListener('change', () => { a.requiredKind = kindSel.value; });
        const reqInput = document.createElement('input');
        reqInput.type = 'text';
        reqInput.className = 'worm-form-input';
        reqInput.placeholder = 'choice id';
        reqInput.autocomplete = 'off';
        reqInput.spellcheck = false;
        reqInput.value = a.reqId;
        reqInput.addEventListener('input', () => { a.reqId = reqInput.value.trim(); });
        reqGrid.appendChild(kindSel);
        reqGrid.appendChild(reqInput);
        body.appendChild(titleGroup);
        body.appendChild(textGroup);
        body.appendChild(reqGrid);
        row.appendChild(body);
      }
      wrap.appendChild(row);
    });
  }

  function buildRequirementTerm(required) {
    // Mirrors the project's real choice-level {type:'id'} ConditionTerm shape
    // (verified against project.json data + the viewer bundle): showRequired
    // controls whether the requirement line renders on the card — both
    // "Required:" and "Incompatible:" terms display it, so always true.
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
      showRequired: true,
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
  overlay.querySelector('#we-addon-add').addEventListener('click', () => {
    addonsState.push({
      id: newAddonId(), title: '', text: '', image: '', template: 1,
      requiredKind: '', reqId: '', keptTerms: [], expanded: true,
    });
    renderAddons();
  });
  if (actAddBtn) {
    renderActRows();
    renderActRowSelect();
  }
  renderReqRows();
  renderAddons();
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
    addonsState.length = 0;
    originalAddons.forEach(a => addonsState.push(addonStateFrom(a)));
    renderAddons();
  });
  overlay.querySelector('#we-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isAdd) {
      // ---- Add path: build a full new choice from the dialog ----
      const rowId = insertAfter ? insertAfter.rowId : overlay.querySelector('#we-dest').value;
      const idxField = overlay.querySelector('#we-dest-index');
      const insertIdx = insertAfter && idxField ? parseInt(idxField.value, 10) : -1;
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
      newChoice.addons = addonsState
        .filter(a => a.title.trim() || a.text.trim())
        .map(a => ({
          id: a.id || newAddonId(),
          image: a.image || '',
          requireds: addonRequiredsFromState(a),
          template: a.template == null ? 1 : a.template,
          text: a.text,
          title: a.title.trim(),
        }));
      const notSel = overlay.querySelector('#we-notsel').checked;
      newChoice.isNotSelectable = notSel;
      const multi = overlay.querySelector('#we-multi').checked;
      newChoice.isSelectableMultiple = multi;
      newChoice.numMultipleTimesPluss = multi ? String(parseInt(overlay.querySelector('#we-maxpicks').value, 10) || 1) : '1';
      newChoice.numMultipleTimesMinus = multi ? String(parseInt(overlay.querySelector('#we-minpicks').value, 10) || 0) : '0';
      newChoice.activateThisChoice = overlay.querySelector('#we-activatethis').value.trim();
      newChoice.deactivateThisChoice = overlay.querySelector('#we-deactivatethis').value.trim();
      newChoice.requireds = keptOthersForAdd().concat(reqState.map(en => en.term));
      closeModal();
      await editorRequest('EDITOR_OP', {
        op: { type: 'addObject', rowId, index: insertIdx, object: newChoice },
      });
      showToast(insertAfter ? 'Inserted after “' + insertAfter.title + '”' : 'Added “' + title + '”');
      return;
    }
    // ---- Edit path (unchanged semantics) ----
    const patch = buildPatch();
    const nextAddons = addonsState
      .filter(a => a.title.trim() || a.text.trim())
      .map(a => ({
        id: a.id || newAddonId(),
        image: a.image || '',
        requireds: addonRequiredsFromState(a),
        template: a.template == null ? 1 : a.template,
        text: a.text,
        title: a.title.trim(),
      }));
    if (stableStringify(nextAddons) !== stableStringify(originalAddons)) {
      patch.addons = nextAddons;
    }
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




// ===========================================================================

// Shared Row dialog — "Add Row" (blank + placement selector) and "Edit Row"
// (custom rows only, via the row bar's ✎). Customizes every row field the
// viewer supports EXCEPT the ones intentionally excluded by design: template,
// grid alignment (rowJustify), deselect-on-enter (deselectChoices), button-row
// options (isButtonRow/button*), result groups (resultGroupId) and all
// styling — those get safe defaults instead (Viewer.md §3).
// ===========================================================================
function blankCustomRow() {
  return {
    id: 'wrow_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    title: '', titleText: '',
    image: '', imageIsUrl: false, imageLink: '',
    template: '1', objectWidth: '', rowJustify: '',
    objects: [], requireds: [],
    allowedChoices: 0, currentChoices: 0,
    isInfoRow: false, isResultRow: false,
    isButtonRow: false, buttonId: '', buttonType: '', buttonText: '', buttonRandom: false, buttonRandomNumber: 0,
    deselectChoices: false, resultGroupId: '',
    isEditModeOn: false, isRequirementOpen: false,
    isCustom: true,
  };
}

async function openRowModal(opts) {
  const isAdd = !opts || !opts.rowId;
  if (document.getElementById('worm-modal-overlay')) return;
  let resp = null;
  let row;
  if (isAdd) {
    if (!EDITOR_UI.data) { showToast('Editor data not ready — reopen the editor.'); return; }
    row = blankCustomRow();
  } else {
    resp = await editorRequest('EDITOR_GET_ROW', { rowId: opts.rowId });
    if (!resp || !resp.row) { showToast('Could not load that row.'); return; }
    row = resp.row;
  }
  const rowId = isAdd ? '' : opts.rowId;
  const original = JSON.parse(JSON.stringify(row));
  const allRowsList = (EDITOR_UI.data && EDITOR_UI.data.rows) || [];
  const esc = escapeHtml;
  const isEmbeddedImage = !isAdd && typeof original.image === 'string' && original.image.startsWith('data:');
  const imageShown = isEmbeddedImage ? '' : (original.image || '');

  // Default card width options (the row's own objectWidth default for its
  // children; '' = viewer default).
  const widthOpts = (() => {
    const opts = [];
    opts.push('<option value=""' + ((original.objectWidth || '') === '' ? ' selected' : '') + '>Viewer default</option>');
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

  // Placement selector (Add mode): top / after any row / end.
  const placementOpts = (() => {
    const list = ['<option value="__top__">At the very top</option>'];
    allRowsList.forEach(r => list.push('<option value="' + esc(r.id) + '">After “' + esc(r.title || r.id) + '”</option>'));
    list.push('<option value="__end__" selected>At the end of the page (above the credits)</option>');
    return list.join('');
  })();

  // Requirement terms reference choices by id (same format as the Add Choice
  // dialog: kind select + "choice id" text input — a dropdown of all ~14.5k
  // choices would take seconds to build). Titles resolve on demand by scan.
  const originalRequireds = Array.isArray(original.requireds) ? original.requireds : [];
  const reqState = originalRequireds
    .filter(t => t && t.type === 'id')
    .map(t => ({ term: JSON.parse(JSON.stringify(t)), required: !!t.required }));
  function buildRowReqTerm(required) {
    return {
      id: '', type: 'id', required: !!required, reqId: '',
      reqId1: '', reqId2: '', reqId3: '', reqPoints: 0, operator: '',
      orRequired: [{ req: '' }, { req: '' }, { req: '' }, { req: '' }],
      requireds: [], showRequired: true,
      beforeText: required ? 'Required:' : 'Incompatible:', afterText: '',
    };
  }
  function stableStringify(value) {
    return JSON.stringify(value, (key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return Object.keys(val).sort().reduce((acc, k) => { acc[k] = val[k]; return acc; }, {});
      }
      return val;
    });
  }
  function choiceTitleFor(id) {
    for (const r of allRowsList) {
      for (const o of (r.objects || [])) {
        if (o && o.id === id) return o.title || id;
      }
    }
    return id;
  }
const overlay = document.createElement('div');
  overlay.id = 'worm-modal-overlay';
  overlay.innerHTML = `
    <div id="worm-modal-dialog">
      <div class="worm-modal-header">
        <h3><span class="worm-modal-glyph">▤</span> ${isAdd ? 'Add Row' : 'Edit Row'} ${!isAdd ? `<span class="worm-id-chip" id="wr-row-id" title="Row ID — click to copy">${esc(rowId)}</span>` : ''}</h3>
        <button type="button" class="worm-modal-close-btn" id="wr-close" title="Close">&times;</button>
      </div>
      <form id="wr-form">
        <div class="worm-modal-body">
          ${isAdd ? `
          <div class="worm-form-group">
            <label for="wr-place">Placement</label>
            <select id="wr-place" class="worm-form-select">${placementOpts}</select>
          </div>` : ''}
          <div class="worm-form-group">
            <label for="wr-title">Row Title</label>
            <input type="text" id="wr-title" class="worm-form-input" value="${esc(original.title || '')}" placeholder="e.g. Custom Powers">
          </div>
          <div class="worm-form-group">
            <label for="wr-text">Description <span class="worm-label-soft">(shown under the heading)</span></label>
            <textarea id="wr-text" class="worm-form-textarea" rows="3">${esc(original.titleText || '')}</textarea>
          </div>
          <div class="worm-form-group">
            <label for="wr-image">Banner Image URL</label>
            <input type="text" id="wr-image" class="worm-form-input" value="${esc(imageShown)}" placeholder="https://… (leave empty for none)">
          </div>
          <div class="worm-form-grid2">
            <div class="worm-form-group">
              <label for="wr-width">Default card width</label>
              <select id="wr-width" class="worm-form-select">${widthOpts}</select>
            </div>
            <div class="worm-form-group">
              <label for="wr-maxpicks">Max picks <span class="worm-label-soft">(0 = unlimited)</span></label>
              <input type="number" id="wr-maxpicks" class="worm-form-input" min="0" value="${esc(String(original.allowedChoices ?? 0))}">
            </div>
          </div>
          <div class="worm-form-group">
            <div class="worm-sec-head">Behavior</div>
            <div class="worm-check-grid">
              <label class="worm-check"><input type="checkbox" id="wr-info"${original.isInfoRow ? ' checked' : ''}><span>Info row (heading, not selectable)</span></label>
              <label class="worm-check"><input type="checkbox" id="wr-result"${original.isResultRow ? ' checked' : ''}><span>Result row (shows in recap)</span></label>
            </div>
          </div>
          <div class="worm-form-group">
            <div class="worm-sec-head">Row Requirements <span class="worm-label-soft">(show / hide this row based on picks)</span></div>
            <div id="wr-req-rows"></div>
            <div class="worm-act-add worm-mt8">
              <select id="wr-req-kind" class="worm-form-select">
                <option value="required">Needs a choice</option>
                <option value="incompatible">Blocked by a choice</option>
              </select>
              <input type="text" id="wr-req-choice" class="worm-form-input" placeholder="choice id" autocomplete="off" spellcheck="false">
              <button type="button" id="wr-req-add" class="worm-btn-ghost-sm">Add</button>
            </div>
          </div>
        </div>
        <div class="worm-modal-footer">
          <span class="worm-footer-spacer"></span>
          <button type="button" class="worm-btn-secondary" id="wr-cancel">Cancel</button>
          <button type="submit" class="worm-btn-primary">${isAdd ? 'Add Row' : 'Save Changes'}</button>
        </div>
      </form>
    </div>`;
const idChip = overlay.querySelector('#wr-row-id');
  if (idChip) idChip.addEventListener('click', async () => {
    const ok = await editorCopyText(rowId);
    showToast(ok ? 'Row ID copied: ' + rowId : 'Copy failed — ID: ' + rowId);
  });

  function renderReqRows() {
    const wrap = overlay.querySelector('#wr-req-rows');
    wrap.innerHTML = '';
    if (reqState.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'worm-empty-hint';
      hint.textContent = 'No requirements on this row.';
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

  overlay.querySelector('#wr-req-add').addEventListener('click', () => {
    const kindSel = overlay.querySelector('#wr-req-kind');
    const choiceSel = overlay.querySelector('#wr-req-choice');
    const reqId = choiceSel.value.trim();
    if (!reqId || reqState.some(e => e.term.reqId === reqId)) return;
    const term = buildRowReqTerm(kindSel.value === 'required');
    term.reqId = reqId;
    reqState.push({ term, required: kindSel.value === 'required' });
    choiceSel.value = '';
    renderReqRows();
  });

  function closeModal() { overlay.remove(); }
  overlay.querySelector('#wr-close').addEventListener('click', closeModal);
  overlay.querySelector('#wr-cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  renderReqRows();

  overlay.querySelector('#wr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = overlay.querySelector('#wr-title').value.trim() || 'New Row';
    const buildPatchFields = () => {
      const patch = {};
      patch.title = title;
      patch.titleText = overlay.querySelector('#wr-text').value;
      const image = overlay.querySelector('#wr-image').value.trim();
      if (!isEmbeddedImage) {
        patch.image = image;
        patch.imageIsUrl = /^https?:\/\//i.test(image);
        patch.imageLink = /^https?:\/\//i.test(image) ? image : '';
      }
      patch.objectWidth = overlay.querySelector('#wr-width').value;
      patch.allowedChoices = Math.max(0, parseInt(overlay.querySelector('#wr-maxpicks').value, 10) || 0);
      patch.isInfoRow = overlay.querySelector('#wr-info').checked;
      patch.isResultRow = overlay.querySelector('#wr-result').checked;
      const keptOthers = originalRequireds.filter(t => !(t && t.type === 'id')).map(t => JSON.parse(JSON.stringify(t)));
      patch.requireds = keptOthers.concat(reqState.map(en => en.term));
      return patch;
    };
    if (isAdd) {
      const place = overlay.querySelector('#wr-place').value;
      const newRow = { ...blankCustomRow(), ...buildPatchFields(), title };
      closeModal();
      const op = place === '__top__'
        ? { type: 'addRow', row: newRow, at: 'top' }
        : (place === '__end__' ? { type: 'addRow', row: newRow } : { type: 'addRow', row: newRow, afterRowId: place });
      await editorRequest('EDITOR_OP', { op });
      showToast('Added row “' + newRow.title + '”');
      return;
    }
    // ---- Edit path: diff against the original, send only what changed ----
    const patch = buildPatchFields();
    const changed = {};
    Object.keys(patch).forEach((k) => {
      const origVal = original[k] !== undefined ? original[k] : (k === 'requireds' ? [] : '');
      if (stableStringify(patch[k]) !== stableStringify(origVal)) changed[k] = patch[k];
    });
    if (Object.keys(changed).length > 0) {
      await editorRequest('EDITOR_OP', { op: { type: 'updateRow', rowId, patch: changed } });
    }
    closeModal();
  });

  document.body.appendChild(overlay);
}