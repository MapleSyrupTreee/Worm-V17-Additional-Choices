# Viewer Reference — Worm V17 CYOA Viewer (ICC "Neo" Viewer Build)

**Offline copy location:** `D:\Projects\Chrome Extensions\Worm V17 CYOA Viewer`
**What it is:** a static production build of Lt Ouroumov's **Interactive CYOA Viewer (NEO)** — the app that renders `project.json` for Worm V17. This is the host app the *Additional Choices* extension modifies.

> ⚠️ `project.json` here is **36.57 MB** (286 rows, 14,536 objects, 18,358 scores). Never load it fully into context — use the probes in `Worm V17 Additonal Choices\.dev\` (`probe-viewer*.js` → text summaries).

---

## 1. What the viewer is (stack)

| Aspect | Detail |
|---|---|
| Framework | **Nuxt 3 / Vue 3** SPA, static prerendered build (`index.html` + hashed Vite chunks in `assets/`) |
| UI kit | **PrimeVue** (Stepper, Tabs, OrderList, TreeSelect, Carousel, VirtualScroller…) + PrimeIcons |
| State | **Pinia** (store ids seen in bundles: `viewer`, plus projects/editor stores) |
| Persistence | **Dexie / IndexedDB** — tables `editor_projects`, `editor_projects_versions` (the built-in *editor* saves project snapshots with `currentVersionId`); **OPFS** (`navigator.storage.getDirectory`) used by a local file browser |
| PWA | Workbox service worker registered at `/viewer/sw.js`, scope `/viewer/` |
| Runtime config | Nuxt `$fetch` with `app.baseURL` (all paths are relative to the mount point `/viewer/`) |

### Directory layout
```
Worm V17 CYOA Viewer/
├── index.html                  # SPA shell (dark-theme, entry CSS + main chunk CJ0a6fMV.js)
├── project.json                # THE data file — 36.57 MB V17 project (never load fully)
├── manifest.webmanifest, sw.js, favicon*, icons…   # PWA assets
├── config/viewer/
│   ├── projects.json           # Project registry: {items:[{file_url,title,id}], default, show_load_file, show_project_sidebar}
│   └── backgrounds.json        # Random loading-screen bg: {enabled, images:[{url, weight}]}
├── assets/
│   ├── CJ0a6fMV.js             # Entry chunk: Nuxt runtime, $fetch, useFetch, Workbox, Dexie
│   ├── TQ4n_O4J.js             # Viewer runtime: Pinia "viewer" store, projects/backgrounds loading, selection counters, markdown export
│   ├── B_KvFCrD.js             # ★ V17→ICC-Neo converter + internal schema + editor project store (loadProject/saveProject/importProjectFile)
│   ├── CTYLOumH.js             # Editor export (downloads project-<id>.json from IndexedDB)
│   ├── Bs7NyRF5.js             # Choice card component (selected/disabled/notSelectable/privateStyling classes)
│   ├── worker-*.js             # Web workers (image processing / search)
│   └── …~150 more hashed chunks
├── bgs/                        # Loading-screen backgrounds (load-01.webp, collage*.webp)
├── previews/                   # Preview images
└── assets/builds/              # latest.json + builds/meta/<uuid>.json (build tracking)
```

Note: there is **no local `images/` folder** — `project.json` references absolute remote URLs like `https://cyoa.ltouroumov.ch/images/v17/row-ckrc.webp`, so images still need network (unless embedded as data-URIs).

---

## 2. `project.json` — top-level structure

Root keys (verified via probe):

| Key | Type | Purpose |
|---|---|---|
| `rows` | `Row[]` (286) | The whole CYOA body — ordered rows of choice cards |
| `pointTypes` | `PointType[]` (8) | Currencies (Shard/Character/Doll Points, Module Slots, Network Capacity, Ascension Count…) |
| `groups` | `Group[]` (18) | Named collections referenced by rows via `resultGroupId` ("Point Conversion", "Shard", "Meta"…) |
| `backpack` | `Row[]` (18) | Clones of rows shown in the "backpack" (sidebar/recap) view — full row objects, not just ids |
| `variables` | `{id, isTrue}[]` (1) | Named boolean flags toggled by choices (e.g. id `"es"`) |
| `activated` | `[]` (empty here) | Runtime activation state container (populated in saved builds) |
| `styling` | `object` (~175 keys) | Global theme: colors, fonts, borders, drop shadows, per-element text styles, selection/requirement filters |
| `default*Title/Text` (4×2) | string | Templates for new/blank entities ("Choice", "Lorem Ipsum…", "Row") |
| `defaultBeforePoint` / `defaultAfterPoint` | `"Cost:"` / `"points"` | Default score label prefixes/suffixes |
| `defaultBeforeReq` / `defaultAfterReq` / `defaultOrReq` | `"Required:"` / `""` / `"of"` | Default requirement label fragments |
| `isChoicesOpen` / `isPointsOpen` / `isStyleOpen` / `isDesignOpen` / `isEditModeOnAll` | bool | Saved UI/editor state flags |

---

## 3. Row object (each element of `rows` / `backpack`)

All 286 rows share one schema (field census: 100% fill):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique id (short base36 like `ckrc`, or slugs like `ObjectOP`); referenced by this id everywhere |
| `title` | string | Row heading (e.g. "Shard Powers", "Meta (Target)") |
| `titleText` | string | Descriptive paragraph under the heading |
| `image`, `imageIsUrl`, `imageLink` | string/bool | Row banner image; `imageIsUrl:true` = remote URL, else embedded data; `imageLink` keeps the original source URL |
| `template` | string `"1"…"3"` | Card layout template id |
| `objectWidth` | string | Default card width class for children — `col-12`, `col-md-3`, `col-md-4`, `col-sm-6`, `w-20` |
| `rowJustify` | string (8% of rows) | Flex alignment (`"center"`) for the card grid |
| `objects` | `Object[]` | The choice cards in this row |
| `requireds` | `Requirement[]` (690 total) | Row-level show/hide conditions (same schema as object requireds) |
| `allowedChoices` | number | Max picks from this row (0 = unlimited) |
| `currentChoices` | number | Runtime pick counter (can be negative in data, e.g. `-6`) |
| `isInfoRow` | bool | Info/heading rows are not selectable and may hide their card grid |
| `isResultRow` | bool | Row belongs to the results/recap section |
| `isButtonRow` + `buttonId`, `buttonType`, `buttonText`, `buttonRandom`, `buttonRandomNumber` | bool/string/number | Randomizer/"Click" button rows (none active in V17 data) |
| `resultGroupId` | string | Groups this row's results under a named result group (e.g. `"76"` = "Meta") |
| `deselectChoices` | bool (40% of rows) | Entering the row deselects previous picks (section-switch behavior) |
| `isPrivateStyling` + `styling` | bool/object | Row-level style override (full ~175-key style object when true) |
| `isEditModeOn`, `isRequirementOpen` | bool | Editor UI state flags |
| `defaultAspectWidth/Height` | number | Image aspect hints (1/1) |

## 4. Object (choice card) — each element of `row.objects`

14,536 objects; fill-rate census in parentheses:

| Field | Type | Meaning |
|---|---|---|
| `id` | string (100%) | Unique card id — what scores/requirements/activation reference |
| `title`, `text` (100%) | string | Card heading + body |
| `image`/`imageIsUrl`/`imageLink` (100%) | | Card image, same convention as rows |
| `template` (100%) | number \| string | Card layout (values seen: 1, "1", "2", "3") |
| `objectWidth` (100%) | string | Per-card width class override |
| `scores` (100%) | `Score[]` | Point costs/gains (18,358 total) |
| `requireds` (100%) | `Requirement[]` | Show/enable conditions (6,682 total) |
| `addons` (100%) | `Addon[]` | Sub-items nested under the card (own `requireds`/`template`/`text`/`title`/`image`) |
| `groups` (100%) | `Group[]` | Group memberships (mostly empty; mirrors top-level `groups`) |
| `isVisible` / `isActive` (100%) | bool | Visibility/selection state containers |
| `isNotSelectable` (84%) | bool | Display-only card (heading tiles, locked info cards) |
| `styling` (99%) / `isPrivateStyling` (0.8%) | object/bool | Per-card style override |
| **Multi-pick** | | `isSelectableMultiple` (14%), `isMultipleUseVariable` (13%), `multipleUseVariable` (80%, counter), `selectedThisManyTimesProp` (58%, runtime count), `numMultipleTimesPluss`/`numMultipleTimesMinus` (string amounts, e.g. "4"/"0"), `multipleScoreId` (2.7%) |
| **Activation wiring** | | `activateThisChoice` (0.1%, comma-separated ids list), `deactivateThisChoice` (0.3%), `activateOtherChoice` (0.4%), `deactivateOtherChoice` (0.5%) — the booleans mark direction |
| **Pick-limit grant** | | `addToAllowChoice` (0.4%) + `idOfAllowChoice` (target row id) + `numbAddToAllowChoice` (amount, e.g. 99) |
| **Exotic** | | `multiplyPointtypeIsOn` + `multiplyPointtypeIsId` + `pointTypeToMultiply` + `multiplyWithThis` + `multiplyPointtypeIsOnCheck` (score multiplier wiring), `imageSourceTooltip` |

## 5. Score (each element of `scores`)

Verified sample: `{"afterText":"SP","beforeText":"Gain:","id":"rm","requireds":[],"showScore":true,"type":"","value":"-5"}`

| Field | Meaning |
|---|---|
| `id` | **PointType id** (e.g. `rm`=Shard Points, `2b`=Character Points, `d2`=Doll Points) |
| `value` | **String** number; **negative = gain, positive = cost** |
| `beforeText` | `"Cost:"` / `"Gain:"` — the label shown before the number |
| `afterText` | Abbreviation after the number (`SP`, `CP`, `DP`, `Module Slots`, `Mutations`, `Network Capacity`) |
| `showScore` | Whether the score line renders |
| `type` | Score subtype (empty in V17) |
| `requireds` | Conditional scoring (score applies only if requirement met) |

## 6. Requirement (each element of `requireds` — objects, rows, and addons share this shape)

One uniform shape (7,338 instances + 34 with `orNum`):

```json
{
  "type": "id",                // "id" (specific picks) or "or" (any-of list)
  "required": true,            // true = must have; false = must NOT have (incompatible)
  "reqId": "ck5v",             // the referenced choice id (type "id")
  "reqId1..reqId3": "",        // extra id slots (empty in V17)
  "orRequired": [{"req":"ig9l"}, {"req":"yw0r"}],  // ANY-of list (type "or"; 4 empty slots when unused)
  "orNum": 1,                  // rare (34×): how many of orRequired must match
  "reqPoints": 0,              // points-threshold variant
  "beforeText": "Required:",   // or "Incompatible:"
  "afterText": "choice",       // label suffix
  "showRequired": false,       // whether the requirement is displayed on the card
  "operator": "", "id": "", "requireds": []
}
```

Semantics (from the converter's pattern-match in `B_KvFCrD.js`): `{type:"id",required:true}` → requires all listed ids; `{type:"id",required:false}` → incompatible with; `{type:"or"}` → any-of/none-of over `orRequired[].req`; an empty term evaluates to `{always:true}`.

## 7. PointType (each element of `pointTypes`)

| Field | Meaning |
|---|---|
| `id` | Referenced by scores (`rm`, `2b`, `d2`, `bw`, `n5`, `1u`…) |
| `name` / `beforeText` / `afterText` | Display name, bar label ("Shard Points: "), abbreviation (`SP`) |
| `initValue` / `startingSum` | Starting balance / sum |
| `activatedId` | Id of a choice that activates/unlocks this point type (e.g. `hheh` for Doll Points) |
| `isNotShownObjects` / `isNotShownPointBar` | Hide from cards / hide from the points bar |
| `belowZeroNotAllowed` | Budget-style point types can't go negative |
| `positiveColor` / `negativeColor` / `pointColorsIsOn` | Points-bar colors (full `{"alpha","hex","hexa","hsla","hsva","hue","rgba"}` objects) |
| `iconIsOn`, `icon`, `iconWidth/Height`, `imageOnSide`, `imageSidePlacement` | Bar icon options |

## 8. Groups, variables, styling

- **`groups`**: `{id, name, elements:[{id}]}` — 18 named groups. In V17's data most `elements` arrays are empty or placeholder `{"id":""}`; rows reference them via `resultGroupId` instead (e.g. every "Meta" row → group `"76"`). Used for grouping results in the recap.
- **`variables`**: `{id, isTrue}` boolean flags — toggled by choices, checked by requirements in richer setups (V17 ships only one, `es`, unused by any requirement).
- **`styling`** (root, rows, objects): one shared ~175-key object — fonts/colors/alignment/sizes for row titles, object titles/text, addon titles/text, score text, points bar; `object*`/`row*` backgrounds, borders, radii, drop shadows; `selFilter*` (selected), `unselFilter*` (unselected), `reqFilter*` (requirement-locked) CSS-filter stacks (blur/bright/cont/gray/hue/invert/opac/satur/sepia + `...IsOn` toggles); `backPackWidth`, `backgroundColor`, `backgroundImage`.

---

## 9. How the viewer loads & handles `project.json`

The pipeline (verified from bundle analysis):

1. **Registry lookup** — viewer store (`TQ4n_O4J.js`) fetches `config/viewer/projects.json` via `$fetch(\`${app.baseURL}config/viewer/projects.json\`)`; supports `remote`/`remotes` arrays to merge additional registries, honors `default`, and uses `show_load_file` / `show_project_sidebar` to toggle UI affordances. Result is cached via `ra("projects", …)`.
2. **Fetch the project** — the chosen item's `file_url` (`./project.json`) is fetched (plain fetch/*$fetch* — *this is the request the extension's interceptor catches*).
3. **Convert to internal schema** — `B_KvFCrD.js` contains the V17→"ICC Neo v2" **converter**. It validates against a Yup-style schema (`cyoa.ltouroumov.ch/.schema/v2.json`) and rebuilds the project into an IR: `content.objects` (map id→{type: page/row/choice, header, layout, requirements}), `content.children` (parent→child id lists; rows are appended under `"@default"`), `config.pages.main`, `config.backpack.rows`, `styles.rules/defaults`, `media.images` (each image gets a generated id; `isRemote`, `data`). Requirements become a normalized `Rules` structure: `{mode: all|any, objectIds, required|incompatible, activeWhen, display}` (pattern-matched from `orRequired`/`reqId`/`required`).
4. **Load into a project store** — `loadProject` / `saveProject` / `importProjectFile` / `createEmptyProject` live in an editor-flavored Pinia store backed by **Dexie/IndexedDB** tables `editor_projects` + `editor_projects_versions` (every save writes a **version snapshot** and updates `currentVersionId`). The viewer renders from this store.
5. **Render** — rows → card grids (Bootstrap-style `col-*` widths via `Pe(objectWidth)`), choices as PrimeVue cards (`Bs7NyRF5.js`: classes for `selected`/`disabled`/`notSelectable`/`hasPrivateStyling`, multi-pick toggle, `scores` and `requireds` sub-components), info rows as headers, plus backpack/recap and markdown/CSV export builders.

### Runtime selection model (what clicking does)

- Picking a card: `currentChoices`/`allowedChoices` counters per row; multi-pick items track `selectedThisManyTimesProp` and increment/decrement by `numMultipleTimesPluss`/`numMultipleTimesMinus` (converted at runtime: `parseInt(...)`), `multipleUseVariable` tracks uses, `multipleScoreId` can scale scores per extra pick.
- Points: sum of `scores[].value` per pointType against `initValue`/`startingSum`; `belowZeroNotAllowed` guards budgets; `activatedId` can gate a point type until a choice activates it.
- Requirements gate **visibility/enablement** of rows, cards, and addons (mode all/any over referenced ids); `deselectChoices` on a row can clear prior picks when the section is entered.
- `activateThisChoice`/`deactivateThisChoice` (comma-separated id lists) + `activateOtherChoice`/`deactivateOtherChoice` toggle other choices on pick — the "ALL" button in the Sections row activates 14 section ids this way.
- `addToAllowChoice` + `idOfAllowChoice` + `numbAddToAllowChoice` raises another row's pick cap (e.g. +99).
- Selection state persists per build (`activated` array in saved builds); the app also offers markdown build export (`build-<date>.md`), CSV export, and PNG capture.

---

## 10. What to harvest for richer extension features

1. **Full requirement support** — the extension's requirement builder currently emits only `reqId`-terms. The uniform shape (incl. `orRequired[].req`, `orNum`, `reqPoints`, `showRequired`, `beforeText: "Incompatible:"`) means it can generate **any-of / none-of / points-threshold / show-on-card** requirements, and display existing row-level requirements when editing.
2. **Addons** — nested sub-choices are first-class (`addons[]` with the same requirement/score machinery); the Add-Choice modal could create them, and the overlay could patch them (`addon` entries are keyed only by `id`/`template`/`title`/`text`/`image` + `requireds`).
3. **Score types** — conditional scores (`scores[].requireds`), hidden costs (`showScore:false`), and multi-pick scaling via `multipleScoreId` are all representable.
4. **Multi-pick semantics** — correct handling of `isSelectableMultiple` + `numMultipleTimesPluss/Minus` + `selectedThisManyTimesProp` + row `allowedChoices` when injecting customs that should be pickable multiple times.
5. **Activation wiring UI** — `activateThisChoice`/`deactivateThisChoice` id lists + direction flags (`activateOtherChoice`/`deactivateOtherChoice`) can be first-class modal fields with id pickers (the "Section Activation" editor already handles the related section pattern).
6. **Pick-limit grants** — `addToAllowChoice`/`idOfAllowChoice`/`numbAddToAllowChoice` to build "unlock +N picks in row X" choices.
7. **Row capabilities** — `deselectChoices`, `rowJustify`, `resultGroupId`, `isButtonRow`+`button*` randomizer rows, per-row `styling` overrides — all patchable via the existing `rowPatches` overlay mechanism.
8. **PointType creation** — new currencies (`beforeText`/`afterText`/`belowZeroNotAllowed`/`activatedId`/colors) could be added alongside customs; the points bar renders whatever exists.
9. **Width/layout editing** — `objectWidth`/`rowJustify` are plain Bootstrap classes; trivial additions to the editor's object/row patches.
10. **Backpack/result awareness** — customs appear in the recap via `isResultRow` + `resultGroupId`; a "show in backpack" toggle would also need a backpack-row clone (the backpack list duplicates full row objects).
11. **Styling themes** — the ~175-key styling object is the complete theme surface; presets or live theme editing could reuse it (per-row/per-object via `isPrivateStyling`).
12. **Robust images** — `imageIsUrl`/`imageLink` semantics (remote URL vs data-URI), `imageSourceTooltip` for attribution; remote `cyoa.ltouroumov.ch/images/...` URLs only work offline if the service worker caches them.

## 11. Practical notes

- All URLs are relative to the mount point (`/viewer/` — confirmed by the service-worker scope); `app.baseURL` prefixes config fetches.
- `projects.json` supports merging remote registries (`remote`, `remotes`), so a custom registry could inject a modified project *without* response interception.
- The converter dedupes media via generated ids (`X("media")`); IR ids are stable per conversion run.
- Build info: `assets/builds/latest.json` → `{id, timestamp}`; `builds/meta/<id>.json` adds `prerendered: []`.
- This offline copy sets `show_load_file:false` + `show_project_sidebar:false` — file-open UI and project index are intentionally hidden.
- The sibling dev server (`.dev/serve-viewer.js`) serves this folder at `http://localhost:8123/viewer/`; extension files are mirrored at `/ext/` for live-testing interception.

