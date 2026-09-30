<div align="center">

# 🐛 Worm V17 CYOA — Additional Choices

A Firefox extension that lets you add, edit, and reshape choices in the [Worm V17 Interactive CYOA](https://cyoa.ltouroumov.ch/cyoa-editor/) — right on the live page. Create custom perks, powers, and drawbacks, rename or move existing ones, and export your whole build as JSON.

**🌐 [Share your builds & grab community choices on the Worm V17 Choice Library](http://worm-v17-library.amad3us5s.workers.dev/)**

</div>

---

## Quick Start

### Manual loading (temporary add-on)

1. Download or clone this repository (the `firefox` branch).
2. Open `about:debugging` in Firefox and click **This Firefox**.
3. Click **Load Temporary Add-on…** and select the `manifest.json` in this folder.
4. Open the Worm V17 CYOA — a floating **"Edit CYOA"** button appears at the bottom-left, and the extension gets its own toolbar popup.

### Manual loading from the zip

1. Download the add-on zip (e.g. `worm-v17-additional-choices-v1.0.1-firefox-amo.zip`) — no need to extract it.
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on…** and pick the zip file.

### Notes

> Requires Firefox **128 or newer** (the page-script layer uses MAIN-world content scripts, supported since 128). Temporary add-ons are removed when Firefox closes;

> Works on `cyoa.ltouroumov.ch`, `ltouroumov.github.io` mirrors, and a local dev viewer on `localhost:8123`.

## Features

| | Feature | Description |
|---|---|---|
| ➕ | **Add custom choices** | Create your own perks, powers, or drawbacks with full control over cost, point type, text, and requirements via an in-page dialog. |
| ✏️ | **Edit existing choices** | Rename choices, tweak their costs, descriptions, or requirements directly on the page. |
| 📦 | **Duplicate & delete** | Clone an existing choice as a starting point, or remove ones you don't want. |
| ↔️ | **Move & reorder** | Drag and drop choices between rows, with live preview of point totals. |
| 🎛️ | **In-page editor** | A floating "Edit CYOA" toggle opens a full editor mode with selection, hotkeys, id badges, and row bars. |
| 🧩 | **Toolbar popup** | Status at a glance, a list of your custom choices, an *Editor Edits* summary, quick Export/Import, and a one-click **Discard All Edits**. |
| 💾 | **Persistence** | Everything is stored in `chrome.storage.local` and automatically re-applied on every page load. |
| 📤 | **Export / Import** | Share your modded choices (and edits) as JSON. Imports are automatically **sanitized** and you're warned if anything suspicious is found. |
| ↩️ | **Undo-friendly workflow** | Snapshots with undo/redo in the editor engine; a guarded *Discard All* wipes everything back to pristine. |

## Sharing Your Choices

Head over to the Worm V17 Choice Library (linked at the top) to upload your exported JSON so other users can load and use your choices — and browse community-made exports to import into your own build. Use the **Export** button in the extension popup to generate your JSON; imports are sanitized automatically before being applied.

## How It Works

The extension hooks into the CYOA viewer (a Vue 3 + Pinia app) without modifying its code. Three layers communicate via `window.postMessage`:

```
popup.js ──chrome.runtime──▶ content.js ──window.postMessage──▶ page-script.js
                                                        │
                                                        ▼
                                      fetch interceptor + Pinia store hook
                                                        │
                                          modified project rendered by the viewer
```

- **Popup** (extension world) — toolbar UI: add choices, view/edit lists, export/import, discard-all.
- **Content scripts** (ISOLATED world) — bridge between the popup, `chrome.storage`, and the page; renders the editor UI, modals, and drag & drop.
- **Page scripts** (MAIN world) — run inside the page itself: intercept the `project.json` fetch, hook into the live Pinia store, and apply your modifications through an editor op engine.

Your changes are recorded as a compact **overlay** (patches, deletions, row orders, moves) plus a list of **custom choices**. On every page load the page script re-applies the overlay on top of the original data — so the original CYOA is never touched, and discarding the overlay restores it perfectly.

### Storage keys (`chrome.storage.local`)

| Key | Purpose |
|---|---|
| `customChoices` | Your added choices — survives reloads |
| `editorOverlay` | Compact record of edits to existing choices (renames, patches, deletes, moves) |
| `lastDetectedCYOA` | Cached metadata (rows, point types) for status display |
| `showEditorToggle` | Whether the floating "Edit CYOA" button is shown |

## Project Structure

| File(s) | Purpose |
|---|---|
| `manifest.json` | MV3 manifest (no build step, plain JS) |
| `content-*.js` | Isolated-world scripts: UI, storage, editor shell, drag & drop, choice modal, edits summary |
| `page-*.js` | MAIN-world scripts: fetch interceptor, store hook, overlay application, editor op engine (undo/redo) |
| `content.css` | Styles for the injected UI ("Obsidian Gold" theme) |
| `popup.html/css/js` | Toolbar popup (flat layout for Firefox/AMO) |
| `sanitize-import.js` | Shared import sanitization |
| `icon-*.png` | 16 / 48 / 128 px icons (flat layout for Firefox/AMO) |

## Privacy

Everything runs **locally** — no servers, no analytics, no network requests beyond the CYOA pages themselves. Data lives only in your browser's `chrome.storage.local`; use **Export** to back it up.

## License

Released for personal use with the Worm V17 Interactive CYOA. Worm and the CYOA belong to their respective creators.
