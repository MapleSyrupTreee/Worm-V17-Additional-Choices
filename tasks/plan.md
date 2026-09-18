# Implementation Plan: Interactive CYOA Editor Mode ("Worm Forge")

## Overview
Add an in-page visual editor to the extension: an aesthetically-styled toggle button activates
EDIT MODE over the live ICC Neo viewer. Clicking any choice selects it (purple selection box +
floating action toolbar: Edit / Duplicate / Delete / Drag). The edit dialog exposes the full V1
choice schema. Drag & drop reorders choices within a row and moves them across rows. Rows can be
added, edited, reordered, and deleted. Every mutation flows through ONE mutation engine
(shallowRef replacement + targeted CollectionLoader remount), gets an inverse op for undo/redo,
and is persisted as a lightweight overlay so edits survive page reloads via the fetch interceptor.

## Research Findings (confirmed during planning)
1. **Viewer source is public**: `github.com/ltouroumov/cyoa-editor` (ICC Neo) — Nuxt 4, TS strict,
   PrimeVue 4, Tailwind v4, Pinia, Dexie. AGPL-3.0. Deployed bundle = V1 viewer.
2. **Authoritative V1 schema** (`app/composables/project/types/v1/index.ts`):
   - `ProjectObj`: id, title, text, image/imageIsUrl/imageLink, objectWidth? (col class),
     scores[] {id, value, beforeText, afterText, requireds[]}, addons[] {title,text,image,requireds},
     groups[{id}], requireds[] (ConditionTerm), isVisible, isNotSelectable, isSelectableMultiple,
     isImageUpload, numMultipleTimesPluss/Minus, multipleUseVariable, multipleScoreId,
     activateOtherChoice: bool, activateThisChoice: string, deactivateOtherChoice: bool,
     deactivateThisChoice: string, addToAllowChoice, numbAddToAllowChoice, idOfAllowChoice,
     isPrivateStyling, styling: ObjStyles|null, template: number.
   - `ProjectRow`: id, title, titleText?, image fields, objectWidth, rowJustify?, resultGroupId,
     allowedChoices: number, isInfoRow, isButtonRow, isResultRow, requireds[], objects[],
     isPrivateStyling, styling?: RowStyles.
   - `Score`: {id, value: string, beforeText, afterText, requireds[]}.
   - `PointType`: id, name, startingSum, activatedId, beforeText, afterText, icon fields, initValue?.
   - `ConditionTerm`: {id, type: 'id'|'or'|'points'|'pointCompare', required, reqId, reqIdN…,
     reqPoints, operator 1..5, orRequired[{req}], showRequired, requireds[], beforeText, afterText}.
   - Width classes map to a 60-col grid (col-12=60 … col-xl-1=5). `ProjectStore` state =
     Empty/Loading/Loaded{file:{data,fileName,projectId,projectName,projectHash}, local, origin}.
3. **Store internals** (`app/composables/store/project.ts`): `store = shallowRef<ProjectStore>`;
   `Selections = Record<string, number>`; `selectedIds` = keys; `setSelected` handles
   activate/deactivate-other-choice + incompatible clearing + `enforceRowLimits` (allowedChoices);
   `IndexMapT = Record<rowId, {index, objects: Record<objId, index>}>` exposed as `indexMap`.
4. **DOM (from deployed bundle)**: rows render as `.project-row-wrapper > .project-row`
   (conditional `hidden` class); cards render through a runtime template engine ("obj") using
   per-object CSS variables (`--obj-title-*`). Exact card-root class must be pinned live in
   Phase 1 (selectors centralized in one config; fallback = title/image/order matching).
5. **Persistence constraint**: project.json is ~38 MB → chrome.storage.local (10 MB) cannot hold
   snapshots; edits must be stored as compact **overlays** and re-applied.

## Architecture Decisions
- **One mutation engine** in page-script.js: `applyMutation(op)` — pure op over `file.data`,
  whole-state shallowRef replacement, two-step remount of ONLY affected rows, inverse-op emitted
  for undo. Existing `swapRowsWithRemount`, `applyChoicesToPiniaStore`, `removeChoicesFromPiniaStore`
  are refactored onto it (no behavior change).
- **DOM mapping without Vue internals**: an id→element card index built from live store data
  (title/image/order matching), rebuilt after every remount; selectors live in one CONFIG object.
- **UI in extension DOM only** (overlays/toolbar/dialogs) — never rendered through Vue.
  Obsidian Violet tokens; design-taste-frontend applied to the editor chrome.
- **Overlay persistence**: new storage keys — `choiceEdits` (merged objects by id),
  `deletedObjectIds`, `rowEdits` (row field patches), `rowOrder` (optional), `addedRows`,
  `deletedRowIds`. Fetch interceptor applies overlays before serving project.json; live path
  applies the same overlays after hooking. Popup export/import includes overlays; "Clear edits".
- **Pointer-based drag** (not HTML5 DnD): drag handle on selection toolbar, ghost element,
  insertion indicator between cards, midpoint hit-testing; survives scroll containers.
- **Undo/redo**: op stack with inverse ops (Ctrl+Z / Ctrl+Y), capped at 100 ops, session-only.

## UI Design
- **Toggle button**: fixed bottom-right glass pill "✎ Edit CYOA" (accent purple); when active it
  becomes a compact toolbar "✓ Done Editing · ⟲ Undo · ⟳ Redo · ? Help". Ctrl+E toggles.
- **Edit mode visuals**: rows get a faint dashed outline; cards get hover outline; selected card
  gets a 2px purple selection box with corner handles + floating toolbar above it.
- **Edit dialog**: Obsidian Violet modal, sections: Content (title, text, image URL + isUrl,
  width class, template #) · Points (multi-row score editor: point type, −cost/+gain segmented,
  amount, per-score showScore) · Behavior (isVisible, isNotSelectable, isSelectableMultiple,
  pick limits, activate/deactivate-this/other-choice) · Advanced (requireds simple builder +
  raw JSON, styling JSON when isPrivateStyling). Save / Cancel / Reset to original.
- **Row controls**: hover bar on each row header — ✎ Edit Row (title/titleText/width/flags),
  ＋ Add Choice, ⠿ drag, 🗑 Delete Row (confirm; objects are deleted with it); "+ Add Row"
  button at page bottom; new row ids `row_<base36 ts>_<rand>`.
- **Feedback**: toast per mutation ("Moved 'X' to Perks"), ConfirmDialog for destructive ops.

## Task List

### Phase 0 — Foundations
- [ ] **Task 1: Version policy + this plan doc** (this commit; 0.2.1).
- [ ] **Task 2: Mutation engine** (page-script.js): ops = updateObject, moveObject, duplicateObject,
      addRow, updateRow, deleteRow, moveRow, plus refactor of existing add/remove onto the engine;
      inverse-op generation; EDIT_* command bus; remount only affected rows.
      *Verify:* each op renders correctly, selection survives, `node --check` passes.

### Phase 1 — Editor mode & selection
- [ ] **Task 3: Toggle button + mode state** (content.js button chrome, page-script mode flag,
      body class hook for editor styles; Ctrl+E). *Verify:* button toggles; viewer interaction
      unchanged when off.
- [ ] **Task 4: Card index + selection UI** (id→element index from store data; capture-phase
      click interception; selection box + action toolbar; Esc deselects).
      *Verify:* click any card → correct id selected (log), box shown, viewer selection untouched.

### Phase 2 — Edit & delete UX
- [ ] **Task 5: Edit dialog** (all ProjectObj field groups; Save → updateObject; live remount;
      Reset-to-original from pristine snapshot captured at first edit).
- [ ] **Task 6: Delete + Duplicate** (delete = existing REMOVE engine + reference warning if the
      id appears in others' requireds/activate rules; duplicate = fresh id, inserted after).

### Checkpoint: full CRUD on choices works live.

### Phase 3 — Drag & drop
- [ ] **Task 7: Pointer drag** (handle on toolbar; ghost; insertion indicator; within-row reorder
      and cross-row move; drop → moveObject; scroll-while-dragging near edges).

### Phase 4 — Row management
- [ ] **Task 8: Row controls** (edit row dialog, add choice, delete row w/ confirm, move row,
      add row; new rows default width copied from the row above).

### Checkpoint: complete structural editing works.

### Phase 5 — Persistence & undo
- [ ] **Task 9: Overlay persistence** (storage keys above; interceptor + post-hook application;
      popup export/import v2 with overlays; "Discard all edits" action w/ confirm).
- [ ] **Task 10: Undo/redo** (op stack, toolbar buttons, shortcuts, toast labels).

### Checkpoint: edits survive reload; Ctrl+Z reverts any mutation.

### Phase 6 — Polish
- [ ] **Task 11: Shortcuts & QA** (Del=delete, Esc layers, help chip, reduced-motion pass,
      full manual QA checklist, README + docs update).

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Card DOM classes vary by template variant | Med | Pin selectors live in Phase 1; centralize in CONFIG; title/image/order fallback matcher |
| Viewer update changes DOM | Med | Single CONFIG of selectors; version check via bundle name |
| Deleting/moving objects referenced by others' requireds | Med | Reference scan + confirm dialog; overlays keep data intact |
| Row remount cost on big rows | Low | Remount only affected rows (existing pattern) |
| chrome.storage quota | Low | Compact overlays only (no snapshots) |
| Drag UX in scrollable grid | Med | Pointer events + auto-scroll; ghost with transform |

## Open Questions (for user)
1. Persist edits across reloads via overlays? (recommended: yes)
2. Include undo/redo in v1? (recommended: yes)
3. Requireds editor: simple builder first, raw JSON in Advanced? (recommended: yes)
4. Per-choice styling editor: JSON-only for now? (recommended: yes; visual editor later)

## Verification
- Every task ends with `node --check` on touched JS + a manual reload checklist step.
- Phase checkpoints require the user's visual confirmation in the live viewer before proceeding.