# PROJECT_CONTEXT.md — Worm V17 CYOA - Additional Choices

> Durable context file for AI sessions. Last updated: 2026-09-17 (after live-injection fix).
> Everything below was confirmed by direct inspection of the repository unless marked *(inference)* or *(unknown)*.
>
> **Viewer source reference:** the CYOA viewer's built (minified, production) source lives at
> `D:\Projects\Chrome Extensions\Worm V17 CYOA Viewer`. Key bundles: `assets/TQ4n_O4J.js`
> (viewer app: stores, CollectionLoader, ViewProjectRow) and `assets/CJ0a6fMV.js`
> (Vue 3.5.32 + Pinia + Dexie runtime). `project.json` there is ~38 MB — never read it whole;
> probe it with targeted searches only.

## 1. Project Summary
A **Chrome Extension (Manifest V3, v0.1.0)** that injects custom choices, perks, powers, and drawbacks
into **Lt Ouroumov's Worm CYOA v17** (Interactive CYOA built on the "ICC Neo" engine).

- Target sites (per README): `https://cyoa.ltouroumov.ch/viewer/` and `https://ltouroumov.github.io/cyoa-editor/`
- Actual manifest scope: content scripts + `host_permissions` on `<all_urls>` (broader than README claims)
- Users create choices via an in-page modal or the extension popup; the extension hooks the host
  page's Vue/Pinia runtime and intercepts `project.json` fetches so custom choices render natively.

## 2. Technology Stack
- Pure vanilla JavaScript, HTML, CSS. **No package.json, dependencies, build system, bundler,
  linter, test framework, or lockfile.**
- Chrome Extension APIs: `chrome.storage.local`, `chrome.runtime.onMessage`, `chrome.tabs`,
  MV3 service worker, MAIN-world content script, `window.postMessage` bridge.

## 3. Directory / Module Map
```
manifest.json        MV3 manifest: permissions storage+activeTab; host_permissions <all_urls>;
                     background service worker; 2 content scripts (isolated + MAIN world);
                     web_accessible_resources: page-script.js
background.js        (940 B)   Service worker: seeds storage defaults on install; answers GET_STATUS (unused — scaffolding)
content.js           (12.4 KB) Isolated-world bridge: loads/normalizes saved choices, relays messages,
                               renders floating badge (never invoked — see bugs), "Add Choice" modal, toast
content.css          Styles for badge, modal, toast
page-script.js       (~15 KB)  MAIN world: wraps window.fetch to intercept *project*.json (persistence on
                               reload); polls (1s x 60) to hook the Pinia "project" store; live-injects
                               custom choices via two-step shallowRef replacement (see section 4)
popup/popup.html|css|js        Popup dashboard: header status dot (message = tooltip), choice list
                               w/ delete, JSON export/import (settings + stats sections removed)
icons/icon-16|48|128.png       Manifest icons
README.md            Features + manual "Load unpacked" instructions
```
**No tests, fixtures, CI/CD, .env, migrations, docs beyond README.md exist.**

## 4. Runtime & Data Flow
1. `page-script.js` (MAIN world, `document_start`) wraps `window.fetch`; any `*project*.json`
   response with `rows` + `pointTypes` gets saved custom choices merged in and is re-served.
   This is the **persistence path** — choices baked in on every page load.
2. It polls every 1s (max 60 attempts) to hook the CYOA runtime (live path):
   - **Pinia `project` store** — found by scanning `#__nuxt.__vue_app__._context.provides`
     for any value with an `_s` Map containing id `'project'`. (The Pinia instance is
     provided under an **anonymous `Symbol()` with an empty description** in production
     builds — description-based matching fails.)
   - Fallback to **Vue 2 app** (`window.app` / `#app.__vue__`) — dead code on current ICC
     Neo builds, kept for legacy ICC support.
3. `content.js` (isolated world) reads `chrome.storage.local`, normalizes legacy schemas, and
   posts to page-script: `SYNC_CUSTOM_CHOICES` / `INJECT_SINGLE_CHOICE` / `REQUEST_METADATA`.
   Page-script replies: `CYOA_METADATA_LOADED`, `CHOICE_INJECTED_SUCCESS`.
4. `content.js` renders the in-page "Add Choice" modal (category, title, description, cost/gain,
   point type, image URL) and persists new choices.
5. `popup/popup.js` reads/writes storage, exports/imports JSON, deletes choices, queries the
   active tab via `GET_PAGE_STATUS`. (Settings section removed 2026-09-17 — both toggles were
   non-functional; the popup no longer writes the `settings` key. Status/stats section also
   removed — status is now a dot in the header title with the message as its tooltip.
   `lastDetectedCYOA` is still written by content.js for its own score normalization, but the
   popup no longer reads it.)
6. Message protocol: extension → page uses `{ target: 'WORM_CYOA_PAGE_SCRIPT', command, payload }`;
   page → extension uses `{ source: 'WORM_CYOA_PAGE_SCRIPT', type, data }`.

### 4a. Confirmed viewer (ICC Neo) runtime facts — from the viewer's production source
These are **confirmed from the minified bundles**, not guesses:
- Nuxt 3 production build. There is **no** `window.app`, no `#app.__vue__`, no `app._instance`,
  **no `__vueParentComponent` on DOM elements** (dev-only), and no devtools hook. DOM/component
  introspection is impossible; the Pinia store is the only sane access path.
- Pinia stores registered: `'project'`, `'viewer'`, `'viewer-settings'` (setup-style stores).
- The `project` store returns the raw state ref under the key **`store`**:
  `{ store: <shallowRef>, project: computed, isLocal, isOriginLocal, projectRows, backpack,
     pointTypes, selected, selectedIds, buildData, buildNotes, buildModified, isLoaded,
     loadProject, unloadProject, getRow, getObject, getObjectAddon, getObjectRow,
     getPointType, indexMap, setSelected, incSelected, decSelected }`.
- State shape: `store.store = { status: 'empty'|'loading'|'loaded', progress?, file: {
  data: { rows, pointTypes, backpack }, fileName, projectId, projectName, projectHash },
  local, origin }`.
- **The state ref is a `shallowRef`** (`Bl` in the bundle) and the loader code calls
  `triggerRef` after replacing it. **Nested mutations (pushing into `rows[i].objects`) never
  trigger reactivity** — you must replace the whole value.
- **Pinia store proxies unwrap refs**: reading `store.store` gives the raw value object
  (`.value` is undefined there); writing `store.store = newObj` routes through the Vue proxy
  setter into `ref.value = newObj` and triggers. Never use `store.store.value` on the proxy.
- **`CollectionLoader`** (`ViewProjectRow` renders one per row with `items: row.objects`,
  `step: 10`) copies `items` into an internal list with an interval that **pauses itself once
  complete** and only resumes when the row's `isVisible` prop flips. Growing `objects` leaves
  its internal list stale (stuck loading skeleton).
- **Live-injection mechanism (implemented & user-verified):** two-step shallowRef replacement —
  step 1: replace `store.store` with the affected rows' `objects: []` (row loader unmounts via
  `v-if="row.objects.length > 0"`); step 2 (50ms later): restore rows with their FULL object
  lists + the new choice (`newRowById` copies — do NOT merge with the live emptied rows, that
  drops originals). Loader remounts and re-renders everything; selection state survives
  (it lives in the store, not the DOM).
- Dexie db `cyoa-editor` v3 (tables: builds, projects, projects_versions, viewer_builds,
  viewer_projects_cache, editor_projects, editor_projects_versions) is the viewer's own
  persistence — **our extension does not write to it**; `viewer_builds[].project` holds only
  `{projectId, name, hash}` metadata.

   page → extension uses `{ source: 'WORM_CYOA_PAGE_SCRIPT', type, data }`.

**State:** entirely `chrome.storage.local` keys: `customChoices`, `settings` (`enabled`, `showIndicator`), `lastDetectedCYOA`.
No external network calls made by the extension itself.

**Choice schema (custom):** `{ id: 'custom_<base36 ts>_<rand>', rowId, title, text, image, scores[], requireds[], addons[], groups[], isSelectableMultiple, isVisible, isCustom: true, template: 1, ... }`
Score: `{ id (pointType id), value ('-N' gain / 'N' cost — ICC Neo convention), beforeText ('Gain:'/'Cost:'), afterText (abbreviated point name, e.g. 'SP'), requireds[] }`.
`normalizeChoice`/`normalizeScore` in page-script.js handle migration of older schemas.

## 5. Development / Test / Build / Deploy Commands
- **None.** Dev is manual: `chrome://extensions` → Developer mode → Load unpacked (folder
  `d:\Projects\Chrome Extensions\Worm V17 Additonal Choices`) → Reload after edits → open CYOA site.
- No lint/test/build exists. Verification is manual in-browser only.

## 6. Configuration
- No env vars, no `.env`, no config files. All runtime config = `chrome.storage.local` settings.

## 7. Git / Worktree State
- History (clean, linear, on `master`; no remote):
  - `4dccfec` — Baseline commit: original extension sources + this context file (2026-09-17).
  - `d5d40dc` — Fix live injection (viewer-source-based): symbol-agnostic Pinia discovery,
    proxy-aware store access, CollectionLoader-aware two-step injection.
  - `722c49f` — Fix step-2 restore dropping existing row objects (restore from `newRowById`).
- Earlier diagnostic-round commits were squashed away by an intentional `git reset --hard` to
  the baseline; history above is authoritative.
- Author identity: Maple <49483389+MapleSyrupTreee@users.noreply.github.com>.
- A global `safe.directory` exception exists for this folder (filesystem doesn't record ownership).
- No remote configured.

## 8. Known Issues / Bugs / Tech Debt
**FIXED (verified by user):**
- ~~Live injection requiring page refresh~~ — now works via the Pinia `project` store
  (see section 4a). Persistence on reload still goes through the fetch interceptor.

**Still open (confirmed from code):**
1. **Settings UI removed (2026-09-17)** — `settings.enabled` was dead (nothing read it) and the
   badge toggle controlled `showIndicator`, read only by the never-invoked `showFloatingBadge()`.
   The popup no longer writes `settings`; `content.js#showFloatingBadge` remains as dead code.
2. **Floating badge never appears** — `showFloatingBadge()` (content.js) defined but its only call site is commented out. README claims this feature works.
3. **JSON Import doesn't live-inject** — popup only re-pings `GET_PAGE_STATUS`; no re-sync command sent.
4. **Over-broad permissions** — `<all_urls>` content scripts/host permissions vs. two known target sites.
5. **`postMessage(..., '*')` everywhere** — no origin restriction.
6. **Duplicated helpers** — `abbreviatePointName`, score normalization, `escapeHtml` across content.js / page-script.js / popup.js.
7. **Hook give-up is silent-ish** — hook interval stops after 60 attempts with only a warning in DIAG builds; baseline has no warning.
8. **Live injection visual flash** — the two-step remount briefly (~50ms) blanks the target row; cosmetic (applies to removal too).
9. **background.js `GET_STATUS` handler** — unused scaffolding *(inference)*.
10. **Vue 2 fallback is dead code** on current ICC Neo builds (kept intentionally for legacy ICC).
11. No tests or linting.

**FIXED (implemented, pending user retest):**
- ~~Popup Delete doesn't remove from live page~~ — `CHOICE_DELETED` (popup → content) is relayed
  as `REMOVE_CHOICE` (content → page-script), which purges the id from `savedCustomChoices`
  (so fetch-interceptor merges / full re-syncs can't resurrect it) and live-removes it from the
  Pinia store via the same two-step row remount (`removeChoicesFromPiniaStore`; Vue 2 fallback:
  `removeChoicesFromVue2`). The remount logic is shared with injection in
  `swapRowsWithRemount(store, emptiedMap, restoreMap, successLog)`. Page-script confirms with
  `CHOICE_REMOVED_SUCCESS`; content.js shows a "removed" toast.

## 9. Ambiguities / Open Questions
- Is the Vue 2 fallback still needed (does the user ever target legacy ICC deployments)?
- Which CYOA deployments does the user actually use (viewer, editor, local)?
- Should the manifest be narrowed to specific origins?

## 10. Recommended Next Steps (prioritized)
1. ~~Initialize git + baseline commit.~~ ✅ Done (`4dccfec`).
2. ~~Fix live injection without page refresh.~~ ✅ Done & user-verified (`d5d40dc` + `722c49f`).
3. ~~Popup delete updates the live page (`REMOVE_CHOICE`).~~ Implemented (`removeChoicesFromPiniaStore` + `swapRowsWithRemount` refactor) — pending user retest.
4. Floating badge: either wire up `showFloatingBadge()` (always-on or via a new setting) or delete the dead code.
5. JSON Import live re-sync (reuse the same remount machinery; add a re-sync command that injects new + removes gone ids).
6. Narrow `host_permissions` / content-script matches; restrict postMessage origins.
7. Extract shared helpers into a common module; deduplicate.
8. Optional: ESLint + a manual smoke-test checklist; remove diagnostic leftovers if any remain.

## 11. Safe Dev Notes for Future Sessions
- Reload the unpacked extension after any file edit; refresh the CYOA tab.
- **Never use `store.store.value` on a Pinia store proxy** — refs are unwrapped; read
  `store.store` and assign `store.store = {...}`.
- **Never mutate nested project data** (e.g., `rows[i].objects.push`) — the state ref is a
  `shallowRef`; replace the whole value via `store.store = {...}`.
- **Never merge live-injected rows with the store's live row objects during the two-step
  remount** — step 1 leaves them emptied; restore from the pre-built copies.
- Do not rewrite files via PowerShell `Set-Content` — it introduced a UTF-8 BOM and mojibake
  here once; use the editor tool (preserves encoding) instead.
- `project.json` in the viewer folder is ~38 MB — never read whole; search it with targeted patterns.
- Console prefixes: `[Worm V17 Mod]` (all scripts), `[Worm V17 Mod DIAG…]` (removed in the
  current tree after the reset-to-baseline; re-add if needed).


