# PROJECT_CONTEXT.md — Worm V17 CYOA - Additional Choices

> Durable context file for AI sessions. Last updated: 2026-09-17.
> Everything below was confirmed by direct inspection of the repository unless marked *(inference)* or *(unknown)*.

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
page-script.js       (14.3 KB) MAIN world: wraps window.fetch to intercept *project*.json; polls (1s x 60)
                               to hook Pinia useProjectStore (Vue 3/Nuxt) with Vue 2 fallback (window.app/#app.__vue__);
                               injects choices into store data + live row DOM (CollectionLoader)
popup/popup.html|css|js        Popup dashboard: connection status, settings toggles, choice list w/ delete,
                               JSON export/import
icons/icon-16|48|128.png       Manifest icons
README.md            Features + manual "Load unpacked" instructions
```
**No tests, fixtures, CI/CD, .env, migrations, docs beyond README.md exist.**

## 4. Runtime & Data Flow
1. `page-script.js` (MAIN world, `document_start`) wraps `window.fetch`; any `*project*.json`
   response with `rows` + `pointTypes` gets saved custom choices merged in and is re-served.
2. It polls every 1s (max 60 attempts) to hook the CYOA runtime:
   - Prefer **Pinia `useProjectStore`** (found via `#__nuxt.__vue_app__._context.provides` symbol sniffing)
   - Fallback to **Vue 2 app** (`window.app` / `#app.__vue__`)
3. `content.js` (isolated world) reads `chrome.storage.local`, normalizes legacy schemas, and
   posts to page-script: `SYNC_CUSTOM_CHOICES` / `INJECT_SINGLE_CHOICE` / `REQUEST_METADATA`.
   Page-script replies: `CYOA_METADATA_LOADED`, `CHOICE_INJECTED_SUCCESS`.
4. `content.js` renders the in-page "Add Choice" modal (category, title, description, cost/gain,
   point type, image URL) and persists new choices.
5. `popup/popup.js` reads/writes storage, exports/imports JSON, deletes choices, toggles
   `settings.enabled`/`showIndicator`, queries active tab via `GET_PAGE_STATUS`.
6. Message protocol: extension → page uses `{ target: 'WORM_CYOA_PAGE_SCRIPT', command, payload }`;
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
- Git repository initialized 2026-09-17 with baseline commit `6d0d6c9` (13 files: all sources + PROJECT_CONTEXT.md).
- Author identity: Maple <49483389+MapleSyrupTreee@users.noreply.github.com>.
- Note: this filesystem doesn't record ownership, so a global `safe.directory` exception was added
  for `D:/Projects/Chrome Extensions/Worm V17 Additonal Choices` (required for git to operate here).
- No remote configured; no branch history beyond baseline.


## 8. Known Issues / Bugs / Tech Debt (confirmed from code)
1. **`settings.enabled` toggle is dead** — popup writes it; nothing in content.js or page-script.js reads it.
2. **Floating badge never appears** — `showFloatingBadge()` (content.js:115) defined but its only call site is commented out (content.js:87). README claims this feature works.
3. **Popup Delete doesn't remove from live page** — only splices storage; no `REMOVE_CHOICE` command exists in page-script.js. Requires page reload.
4. **JSON Import doesn't live-inject** — popup only re-pings `GET_PAGE_STATUS`; no re-sync command sent.
5. **Over-broad permissions** — `<all_urls>` content scripts/host permissions vs. two known target sites.
6. **`postMessage(..., '*')` everywhere** — no origin restriction; page scripts can spoof bridge commands.
7. **Duplicated logic** — `abbreviatePointName`, score normalization, `escapeHtml` duplicated across content.js / page-script.js / popup.js.
8. **Fragile engine coupling** — deep Vue internals reflection (`__vueParentComponent`, `loader.setupState.visible`, Pinia symbol keys, `store.store.value = {...}` shallowRef swap) breaks silently if ICC Neo updates; hook interval just gives up after 60s.
9. **background.js `GET_STATUS` handler** — unused scaffolding *(inference)*.
10. No version control, tests, or linting.

## 9. Ambiguities / Open Questions
- Is Vue 2 ICC fallback still needed, or is ICC Neo (Vue 3/Pinia) the only target?
- Which CYOA deployments does the user actually use (viewer, editor, local)?
- Should the manifest be narrowed to specific origins?

## 10. Recommended Next Steps (prioritized)
1. ~~Initialize git + baseline commit.~~ ✅ Done (2026-09-17, baseline commit `6d0d6c9`).
2. Restore floating badge invocation; honor `settings.enabled`/`showIndicator` in content.js.
3. Add `REMOVE_CHOICE` / full re-sync command to page-script (fix popup delete + import live update).
4. Narrow `host_permissions` / content-script matches; restrict postMessage origins.
5. Extract shared helpers into a common module; deduplicate.
6. Optional: ESLint + a manual smoke-test checklist.

## 11. Safe Dev Notes for Future Sessions
- Reload the unpacked extension after any file edit; refresh the CYOA tab.
- Do not read/reproduce secrets — none exist in this repo.
- Console prefixes for debugging: `[Worm V17 Mod]` in all four scripts.

