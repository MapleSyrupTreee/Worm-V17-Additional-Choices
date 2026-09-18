# Worm V17 CYOA - Additional Choices (Chrome Extension)

A Chrome extension built with Manifest V3 to add custom choices, perks, powers, drawbacks, and settings to **Lt Ouroumov's Worm CYOA v17** (and other Interactive CYOAs built on ICC Neo / MeanDelay ICC).

Supported Sites:
- `https://cyoa.ltouroumov.ch/viewer/`
- `https://ltouroumov.github.io/cyoa-editor/`
- Any local or hosted deployment of the CYOA

---

## 🚀 Features

- **In-Page "Add Choice" Modal**:
  - Open it from the extension popup's **Add Choice** button (opens the dialog on the active CYOA tab).
  - Category dropdown is dynamically populated with all actual sections in the CYOA (Origins, Perks, Tier 1-3 Powers, Drawbacks, etc.).
  - Select point type (CP, SP, etc.) and specify point cost/gain.
  - Supports custom descriptions and optional image URLs.
- **Dual-Layer Real-Time Injection**:
  - **Live Vue 3 / Pinia Hook**: Directly pushes newly added choices into the CYOA's reactive store (`useProjectStore`), rendering the card immediately without requiring a full page refresh.
  - **Early `fetch` Interceptor**: Intercepts `project.json` during page load so saved custom choices are automatically baked into the CYOA engine from the start.
- **Storage & Backup**:
  - Saved choices persist across browser restarts in `chrome.storage.local`.
  - **Export to JSON**: Download your custom choices to share or backup.
  - **Import from JSON**: Easily load custom choices from JSON files.
- **Extension Popup Dashboard**:
  - Connection status dot in the header (hover for details).
  - Displays all created custom choices with one-click deletion (removed from the live page instantly).

---

## 🛠️ How to Test & Reload

1. **Open Chrome Extensions**:
   - Navigate to `chrome://extensions`.
2. **Reload Extension**:
   - If you already loaded the unpacked folder, click the **Reload icon** (circular arrow) on the **"Worm V17 CYOA - Additional Choices"** card.
   - If loading for the first time:
     1. Enable **Developer mode** (top right).
     2. Click **Load unpacked** (top left).
     3. Select folder: `d:\Projects\Chrome Extensions\Worm V17 Additonal Choices`.
3. **Open the CYOA**:
   - Go to `https://cyoa.ltouroumov.ch/viewer/` or `https://ltouroumov.github.io/cyoa-editor/`.
   - Refresh the page to initialize the scripts.
4. **Add a Custom Choice**:
   - Click the extension icon and press **Add Choice** (opens the dialog on the CYOA tab).
   - Pick your desired category (e.g., *Perks* or *Powers*), enter a Title, Description, and Points.
   - Click **"Add to CYOA"**.
   - The choice will appear in that section of the CYOA and can be selected just like any native option!
