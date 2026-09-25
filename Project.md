# Project Reference — Worm V17 CYOA "Additional Choices" Chrome Extension

## Overview

A Chrome Extension (Manifest V3, version 0.2.20) that augments the **Worm V17 Interactive CYOA** (an ICC-Neo `cyoa-editor` viewer app — Vue 3 + Pinia; see `Viewer.md` for viewer internals and the full `project.json` data model). It lets the user add, edit, duplicate, move, and delete choices (perks/powers/drawbacks) on the live CYOA page, persist those modifications locally, and export/import them as JSON.

No build step — plain JS files loaded directly as an unpacked extension. No background service worker.

## File Structure

```
manifest.json              MV3 manifest (v0.2.20)

Isolated world (content scripts, loaded in manifest order — shared top-level scope):
content-util.js            Toast, HTML escaping, clipboard, point-name abbreviation
content-overlay-store.js   editorOverlay + customChoices persistence, overlay op recorder
content-editor.js          Editor shell: mode toggle, request transport (reqId/timeout),
                           DOM<->data card index, id badges, selection, row bars, entry/exit
content-editor-dragdrop.js Pointer drag & drop, capture-click selection, hotkeys,
                           duplicate/delete actions
content-choice-modal.js    Shared Add/Edit choice dialog + delete-confirm dialog
content.js                 Entry: storage<->page-script bridge, popup messaging,
                           scroll restore, boot

MAIN world (page scripts, loaded in manifest order — shared top-level scope):
page-shared.js             Shared state, normalization (V17 conventions), array ops,
                           clone, id generators
page-project-apply.js      Overlay/customs onto raw project.json or live Pinia store,
                           serialized two-step row remount
page-editor-engine.js      EDITOR_EXEC op executors, applyEditorOp, undo/redo, snapshots
page-script.js             Entry: fetch interceptor, Pinia hook poll, metadata emit,
                           command listener

content.css                Styles for injected UI (modal, editor chrome, badges, toasts)
popup/
  popup.html/js/css        Extension popup: status, choice list, export/import, discard-all
icons/                     16/48/128 px icons
Viewer.md                  ICC-Neo viewer & project.json data-model reference
.dev/                      Dev-only scripts (local viewer server, probes, glyph check,
                           split tooling + pre-split originals in split-backup/)
```

Cross-file note: these are classic scripts, not ES modules — each module's top-level
`function`/`const`/`let` declarations are global within its world, so load order matters
(shared modules first, entry file last). Keeping declarations at top level (no IIFE
re-wrapping) is what makes the multi-file split work without a bundler.

### Manifest details
- **Permissions:** `storage`, `activeTab`
- **Hosts / content-script matches:** `https://cyoa.ltouroumov.ch/*`, `https://ltouroumov.github.io/*` (CYOA served under `/cyoa-editor/`), `http://localhost:8123/*` (local dev harness from `.dev/serve-viewer.js`)
- **Content scripts:**
  - `content.js` (+ `content.css`) in the ISOLATED world at `document_idle`
  - `page-script.js` in the **MAIN** world at `document_start` (registered via manifest `world: "MAIN"` — no `web_accessible_resources` needed)

## Architecture & Data Flow

Three layers communicate via `window.postMessage`:

```
popup.js  ──chrome.runtime messages──▶  content.js  ──window.postMessage──▶  page-script.js
   │                                        ▲                                     │
   └──────── chrome.storage.local ──────────┴──────────── (sync source of truth)  ▼
                                                                       Vue/Pinia app store
```

### Messaging protocols
- **content.js → page-script** (`window.postMessage`): `{ target: 'WORM_CYOA_PAGE_SCRIPT', command, payload }` — commands: `SYNC_CUSTOM_CHOICES`, `SYNC_EDITOR_OVERLAY`, `REMOVE_CHOICE`, `REQUEST_METADATA`, `EDITOR_GET_DATA`, `EDITOR_GET_OBJECT`, `EDITOR_OP`, `EDITOR_UNDO`, `EDITOR_REDO`, `EDITOR_SET_MODE`.
- **page-script → content.js**: `{ source: 'WORM_CYOA_PAGE_SCRIPT', type, data }` — events: `CYOA_METADATA_LOADED`, `CHOICE_REMOVED_SUCCESS`, `EDITOR_MODE_CHANGED`, `EDITOR_DATA` / `EDITOR_OBJECT` (snapshot replies), `EDITOR_RESULT { reqId, ok, label, error }`, `EDITOR_DATA_CHANGED`.
- **popup → content.js** (`chrome.tabs.sendMessage`): actions `GET_PAGE_STATUS`, `OPEN_ADD_CHOICE_MODAL`, `CHOICE_DELETED`, `STORAGE_IMPORTED`, `DISCARD_ALL_EDITS`.
- There is **no background service worker** — popup and content script talk to each other directly over `chrome.runtime` messaging. (The legacy `GET_STATUS` background handler was unused by every caller and has been removed.)

## How It Works — Key Mechanisms

### 1. Fetch interception (page-script.js)
Intercepts the page's `project.json` fetch before the viewer loads it, then bakes in:
1. Custom choices (merged into their target rows),
2. The editor overlay — applied in strict order: object field patches → deletions → row field patches → row orders (row orders last so customs get positioned).

Flags track application state: `overlayAppliedInFetch`, `overlayAppliedToLive`, `customsBakedInFetch` (prevents redundant live re-injection that could race remounts).

### 2. Live store manipulation (page-script.js)
- Finds the Pinia "project" store (`findPiniaProjectStore`), reading `store.store` (unwrapped shallowRef: `{ status, file: { data: { rows, pointTypes } } }`). A store-hook poll retries for ~60s until the store reports `status: 'loaded'`.
- Row updates use a **two-phase remount trick** (`swapRowsWithRemount`): first swap touched rows to emptied copies, then after ~50ms swap in the full rows — this forces the viewer's CollectionLoader to re-add cards incrementally. Snapshots are broadcast only *after* both phases (a mid-remount snapshot would report emptied rows).
- Untouched rows keep original object references (only modified rows are cloned).

### 3. Choice model & normalization
`normalizeChoice` / `normalizeScore` enforce:
- IDs like `custom_<ts>_<rand>` (or `wrow_<ts>_<rand>` for rows)
- Scores: `value` as string; **positive = cost, negative = gain** (V17 convention, see `Viewer.md` §5); `beforeText` 'Cost:'/'Gain:'; `afterText` = abbreviated point-type name ("Shard Points" → "SP")
- Multi-pick amounts (`numMultipleTimesPluss`/`numMultipleTimesMinus`) are **strings** per the viewer's own data convention (`Viewer.md` §4) — the viewer `parseInt()`s them at runtime
- Flags: `isCustom: true`, `isSelectableMultiple`, `requireds`, `addons`, `groups`, `isVisible`, `template: 1`, etc.
- content.js re-normalizes older-schema saved choices on load and writes back if changed.

### 4. In-page editor (content.js)
- **Metadata detection:** `CYOA_METADATA_LOADED` from page-script triggers a one-time re-sync of saved choices (`metadataSyncDone` guard — later metadata emissions, e.g. popup status pings, must be pure reads to avoid reverting live edits).
- **Choice modal** (`openChoiceModal`): shared add/edit dialog. Add mode starts blank with a Destination (row) selector; edit mode also shows a Section Activation editor. Fields: title, text, image (URL or embedded data — `imageIsUrl` flag), object width, per-point-type score rows (Cost/Gain segmented toggle + amount), requirements builder (required/incompatible vs. any choice id — non-`id` terms are preserved untouched), **addons editor** (collapse/expand rows: title + description + one optional {type:'id'} requirement per addon; V17 addon shape `{id, image, requireds, template, text, title}` per `Viewer.md` §4 — other requirement terms preserved verbatim; new addon ids are 8-char base36), behavior flags (Not selectable / Pick multiple with max & min picks), `activateThisChoice`/`deactivateThisChoice` id lists with "when picked, activate/deactivate the id above" toggles. A chip shows/copy-copies the object's ID.
- **Selection layer:** overlay layer with selection box + floating toolbar (✎ Edit, ＋ Insert after, ⧉ Duplicate, ⠿ drag handle, 🗑 Delete / Del key). **Insert after** opens the Add dialog locked to the reference choice's row with an exact `addObject` index (right after it).
- **Drag & drop:** pointer-based with ghost element (transform-only), insertion indicator, row highlight hint, viewport-edge auto-scroll, Escape-to-cancel; hit-testing against row wrappers/card grids.
- **ID badges:** `.worm-obj-id-badge` chips on cards (click to copy choice ID), positioned via `MutationObserver`-driven re-indexing (CollectionLoader adds cards incrementally after remount).
- **Undo/redo:** ops pushed to `editorUndoStack`/`editorRedoStack` (max 100) with inverse ops, executed through `EDITOR_EXEC` handlers (`updateObject`, `addObject`, `deleteObjects`, row patches, row order...).
- **Editor op protocol:** content.js sends an op + optional snapshot via postMessage with a `reqId`; page-script executes it against the Pinia store, returns `EDITOR_RESULT { reqId, ok, label, error }`. content.js then updates the persisted `editorOverlay` (serialized through `overlayQueue` promise chain for read-modify-write safety).
- Custom (non-baseline) objects edited via the editor are also synced back into `customChoices` storage so they survive independently of the overlay. Three helpers keep the two sources of truth consistent:
  - `editorSyncUpdatedChoice` — merges editor patches of custom objects back into their stored `customChoices` entry (otherwise a later storage re-sync would visibly revert the edit).
  - `editorTrackNewChoice` — objects created/duplicated in the editor are tracked into `customChoices`.
  - `editorPurgeDeletedCustomChoices` — deleting a custom choice also removes it from `customChoices` (otherwise the fetch interceptor resurrects it on next load).

### 5. Popup (popup.js)
- Status indicator via `GET_PAGE_STATUS` against the active tab.
- Choice list with per-item delete (live-removes from the page via `CHOICE_DELETED`, no reload).
- **Add Choice** button → `OPEN_ADD_CHOICE_MODAL` on the tab.
- **Export/Import** (v2 JSON: `{ version: 2, exported, customChoices, editorOverlay }`; legacy bare-array also accepted). Import merges by id, then pings `STORAGE_IMPORTED` → page reloads so the fetch interceptor applies everything cleanly.
- **Discard All Edits** → `DISCARD_ALL_EDITS`: wipes `editorOverlay` + `customChoices`, reloads pristine.

## Conventions & Gotchas

- Log prefix: `[Worm V17 Mod]`.
- Files use 2-space indent, plain ES2015+, no framework in extension code itself.
- Version string duplicated in `manifest.json` and `popup.html` (`v0.2.20` pill) — update both.
- Popup HTML footer targets `ltouroumov.ch` / `cyoa-editor`.
- Overlay must always be `{ version: 1, ... }`; anything else is treated as null/cleared.
- Positive value = cost, negative = gain in scores; `isGain` flag takes precedence when present.
- `.dev/` contains local-only tooling (viewer server, structure probes, glyph/mojibake checks) — not shipped logic.
- **Mojibake hazard:** a PowerShell `Get-Content`/`Set-Content` round-trip once double-encoded the sources (UTF-8→cp1252→UTF-8). Don't round-trip source files through PowerShell; `.dev/fix-mojibake.js` + `.dev/check-glyphs.js` exist to repair/verify (`＋ ✎ ⧉ 🗑 × “ ” — − …` glyphs).
- **Injected-UI styling ("Obsidian Violet"):** dark greys + single purple accent `#8b5cf6`. CSS tokens are prefixed `--wv-*` (popup: `--accent` etc.) and in `content.css` are scoped to the extension's own roots only (`#worm-modal-overlay`, `#worm-edit-toggle`, `#worm-editor-layer`, `#worm-confirm-overlay`, `.worm-row-bar`, `.worm-toast`) — never `:root`, to avoid colliding with host-page variables. Overlays use z-index `2147483647`.
- Unmapped card clicks (remount race) dump a `[Worm Forge DIAG]` console payload with wrapper/card indexes and row data for debugging.

## Dev Workflow

- Load as **unpacked extension** in `chrome://extensions`; after editing files, hit ↻ there **and** reload the CYOA tab. The extension activates only on its three matched origins (`cyoa.ltouroumov.ch`, `ltouroumov.github.io` under `/cyoa-editor/`, and `localhost:8123`); the in-page editor additionally checks an internal `EDITOR_URL_ALLOWLIST` in `content.js` — add new mirrors there **and** in `manifest.json`.
- `.dev/serve-viewer.js` serves a local copy of the CYOA viewer for live-testing: `node .dev/serve-viewer.js` → `http://localhost:8123/viewer/` (sibling repo `D:/Projects/Chrome Extensions/Worm V17 CYOA Viewer`); extension files are also served under `/ext/` for injection experiments; client logs POSTed to `/__log` append to `.dev/wormlog.txt`.
- `Viewer.md` documents the viewer's build, its `project.json` schema (row/object/score/requirement/pointType field tables with fill-rate census), and a list of untapped data-model features that could drive richer extension functionality.
- No tests, no bundler, no CI in the repo.

## Storage (chrome.storage.local keys)

| Key | Shape | Purpose |
|---|---|---|
| `customChoices` | Array of choice objects | All custom choices, survives reloads |
| `editorOverlay` | `{ version: 1, objects: {objId: patch}, deleted: [objId], rowPatches: {rowId: patch}, rowOrder: {rowId: [objId,...]} }` | Compact record of editor mutations re-applied on every load |
| `lastDetectedCYOA` | `{ detected, rows, pointTypes }` | Cached metadata for point-type normalization & popup status |

Note: the legacy `settings` key (`{ enabled, showIndicator }`) is no longer read or written by any code — the background service worker that seeded it was removed. Existing values are harmless leftovers.
