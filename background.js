// Service Worker for Worm V17 Additional Choices

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Worm V17 Mod] Extension installed/updated:', details.reason);
  
  // Initialize default storage settings if not already present
  const { customChoices = [], settings = {} } = await chrome.storage.local.get(['customChoices', 'settings']);
  
  const defaultSettings = {
    enabled: true,
    showIndicator: true,
    ...settings
  };

  await chrome.storage.local.set({
    customChoices,
    settings: defaultSettings
  });
});

// Relay or handle messages if needed
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_STATUS') {
    (async () => {
      const data = await chrome.storage.local.get(['settings', 'customChoices']);
      sendResponse({ status: 'ok', data });
    })();
    return true; // Keep message channel open for async response
  }
});
