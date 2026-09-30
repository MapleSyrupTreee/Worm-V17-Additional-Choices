// page-shared.js — pure helpers for the MAIN-world scripts: point-name
// abbreviation, score/choice normalization (V17 conventions), array ops,
// deep clone, id generators.
// In-memory registry of custom choices and detected project reference
let savedCustomChoices = [];
// Editor overlay (Phase 5): compact record of editor mutations, re-applied to
// the freshly-fetched project.json on every load. Synced from content.js.
// Shape: { version: 1, objects: {objId: patch}, deleted: [objId],
//          rowPatches: {rowId: patch}, rowOrder: {rowId: [objId,...]} }
let editorOverlay = null;
let overlayAppliedInFetch = false;
let overlayAppliedToLive = false;
let customsBakedInFetch = false; // interceptor already merged customs into project.json
let detectedProject = null;
let hookAttempts = 0;

// =========================================================================
// 1. Normalization & Formatting Helpers
// =========================================================================
// Abbreviates a point type name: "Shard Points" → "SP", "Character Points" → "CP"
function abbreviatePointName(name) {
  if (!name) return 'Pts';
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return name;
  return words.map(w => w[0].toUpperCase()).join('');
}

function normalizeScore(score, pointTypes = []) {
  if (!score || !score.id) return null;
  const pt = pointTypes.find(p => p.id === score.id);
  const ptName = pt ? (pt.name || pt.id) : (score.afterText || 'Points');
  const abbr = abbreviatePointName(ptName);

  const rawVal = typeof score.value === 'string' ? parseInt(score.value, 10) : (score.value || 0);
  // V17 convention (see Viewer.md §5): negative value = gain, positive = cost.
  // The heuristic defers to explicit beforeText hints so legacy scores that
  // carry the sign in beforeText keep their original meaning.
  const isGain = score.isGain !== undefined
    ? score.isGain
    : (score.beforeText === '+' || score.beforeText === 'Gain:' || (rawVal < 0 && score.beforeText !== '-' && score.beforeText !== 'Cost:'));
  const absVal = Math.abs(rawVal) || 0;

  return {
    id: score.id,
    value: isGain ? String(-absVal) : String(absVal),
    beforeText: isGain ? 'Gain:' : 'Cost:',
    afterText: abbr,
    requireds: Array.isArray(score.requireds) ? score.requireds : []
  };
}

function normalizeChoice(choice, pointTypes = []) {
  const rawScores = Array.isArray(choice.scores) ? choice.scores : [];
  const normalizedScores = rawScores.map(s => normalizeScore(s, pointTypes)).filter(Boolean);

  return {
    ...choice,
    id: choice.id || 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
    title: choice.title || 'Untitled Choice',
    text: choice.text || '',
    image: choice.image || '',
    scores: normalizedScores,
    requireds: Array.isArray(choice.requireds) ? choice.requireds : [],
    addons: Array.isArray(choice.addons) ? choice.addons : [],
    groups: Array.isArray(choice.groups) ? choice.groups : [],
    isSelectableMultiple: Boolean(choice.isSelectableMultiple),
    isNotSelectable: false,
    isVisible: true,
    isPrivateStyling: false,
    styling: null,
    template: 1,
    isCustom: true
  };
}


const arrReplace = (arr, i, v) => { const out = arr.slice(); out[i] = v; return out; };
const arrInsert = (arr, i, v) => { const out = arr.slice(); out.splice(i, 0, v); return out; };
const arrRemove = (arr, i) => { const out = arr.slice(); out.splice(i, 1); return out; };

function findObjectLocation(rows, objId) {
  for (let i = 0; i < rows.length; i++) {
    const objects = rows[i].objects;
    if (!Array.isArray(objects)) continue;
    const j = objects.findIndex(o => o && o.id === objId);
    if (j >= 0) return { rowIdx: i, row: rows[i], objIdx: j, obj: objects[j] };
  }
  return null;
}

function findRowIndex(rows, rowId) {
  return rows.findIndex(r => r.id === rowId);
}

function cloneValue(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (err) { return value; }
}

function newObjectId() {
  return 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function newRowId() {
  return 'wrow_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

