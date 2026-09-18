// popup.js - Extension popup controller

document.addEventListener('DOMContentLoaded', async () => {
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const groupCount = document.getElementById('groupCount');
  const pointCount = document.getElementById('pointCount');
  const customChoicesCount = document.getElementById('customChoicesCount');
  const choicesList = document.getElementById('choicesList');
  const openInPageModalBtn = document.getElementById('openInPageModalBtn');
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');

  let activeTabId = null;

  // 1. Load custom choices & last detected CYOA metadata
  const { customChoices = [], lastDetectedCYOA = null } =
    await chrome.storage.local.get(['customChoices', 'lastDetectedCYOA']);

  renderChoicesList(customChoices);

  if (lastDetectedCYOA) {
    groupCount.textContent = lastDetectedCYOA.rows?.length || 0;
    pointCount.textContent = lastDetectedCYOA.pointTypes?.length || 0;
  }

  // 2. Open in-page modal button
  openInPageModalBtn.addEventListener('click', async () => {
    if (!activeTabId) {
      alert('No active CYOA tab found. Please navigate to the Worm CYOA page.');
      return;
    }
    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'OPEN_ADD_CHOICE_MODAL' });
      window.close(); // Close popup so user interacts with page modal
    } catch (err) {
      alert('Could not open modal on this tab. Try reloading the CYOA page.');
    }
  });

  // 3. Export & Import
  exportBtn.addEventListener('click', async () => {
    const { customChoices = [] } = await chrome.storage.local.get('customChoices');
    if (customChoices.length === 0) {
      alert('No custom choices to export.');
      return;
    }

    const blob = new Blob([JSON.stringify(customChoices, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `worm_v17_custom_choices_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', () => {
    importFileInput.click();
  });

  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const imported = JSON.parse(text);

      if (!Array.isArray(imported)) {
        alert('Invalid format: File must contain a JSON array of choices.');
        return;
      }

      const { customChoices = [] } = await chrome.storage.local.get('customChoices');
      const existingIds = new Set(customChoices.map(c => c.id));

      let addedCount = 0;
      for (const item of imported) {
        if (item.title && item.rowId) {
          if (!item.id || existingIds.has(item.id)) {
            item.id = 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);
          }
          customChoices.push(item);
          existingIds.add(item.id);
          addedCount++;
        }
      }

      await chrome.storage.local.set({ customChoices });
      renderChoicesList(customChoices);

      // Tell active tab to sync
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { action: 'GET_PAGE_STATUS' }).catch(() => {});
      }

      alert(`Successfully imported ${addedCount} choices!`);
    } catch (err) {
      alert('Error parsing JSON file: ' + err.message);
    } finally {
      importFileInput.value = '';
    }
  });

  // 4. Connect to active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setInactive('No active tab');
      return;
    }

    activeTabId = tab.id;

    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
      setInactive('Internal page');
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_STATUS' });
      if (response && response.metadata) {
        const { rows = [], pointTypes = [] } = response.metadata;
        statusIndicator.className = 'status-indicator active';
        statusText.textContent = 'Worm CYOA Active';
        groupCount.textContent = rows.length;
        pointCount.textContent = pointTypes.length;
      } else {
        statusIndicator.className = 'status-indicator';
        statusText.textContent = 'Connected (waiting for metadata)';
      }
    } catch (msgErr) {
      statusIndicator.className = 'status-indicator';
      statusText.textContent = 'Reload CYOA page to connect';
    }
  } catch (err) {
    console.error('Error connecting to tab:', err);
    setInactive('Connection error');
  }

  function setInactive(msg) {
    statusIndicator.className = 'status-indicator inactive';
    statusText.textContent = msg;
  }

  function renderChoicesList(choices) {
    customChoicesCount.textContent = choices.length;

    if (!choices || choices.length === 0) {
      choicesList.innerHTML = '<div class="empty-state">No custom choices added yet. Click above to create one!</div>';
      return;
    }

    choicesList.innerHTML = choices.map((c, idx) => `
      <div class="choice-item">
        <div class="choice-info">
          <span class="choice-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</span>
          <span class="choice-meta">Row: ${escapeHtml(c.rowId)} ${c.scores?.length ? '• Score: ' + c.scores[0].value : ''}</span>
        </div>
        <button class="choice-del-btn" data-index="${idx}" title="Delete choice">&times;</button>
      </div>
    `).join('');

    choicesList.querySelectorAll('.choice-del-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const index = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        const { customChoices = [] } = await chrome.storage.local.get('customChoices');
        const [removed] = customChoices.splice(index, 1);
        await chrome.storage.local.set({ customChoices });
        renderChoicesList(customChoices);

        // Tell the live page to drop the choice (no reload needed)
        if (activeTabId) {
          chrome.tabs.sendMessage(activeTabId, {
            action: 'CHOICE_DELETED',
            choiceId: removed.id
          }).catch(() => {});
        }
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
});
