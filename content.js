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

  // Abbreviates a point type name: "Shard Points" → "SP", "Character Points" → "CP"
  function abbreviatePointName(name) {
    if (!name) return 'Pts';
    const words = name.trim().split(/\s+/);
    if (words.length === 1) return name; // single word kept as-is
    return words.map(w => w[0].toUpperCase()).join('');
  }
})();
