// sanitize-import.js — hardening for the JSON import boundary (popup).
// Imported files are UNTRUSTED input: they are parsed here, validated against
// strict shape/size/type rules, and reduced to known-safe fields before they
// ever reach chrome.storage (and from there the CYOA page, where the viewer
// renders some fields as HTML). Classic script — loaded by the popup only.
(function () {
  'use strict';

  // --- Limits (DoS guards) -------------------------------------------------
  var MAX_FILE_BYTES = 8 * 1024 * 1024;   // 8 MB raw JSON
  var MAX_CHOICES = 1000;
  var MAX_MAP_KEYS = 5000;                // overlay objects/rowPatches/rowOrder
  var MAX_MOVES = 1000;
  var MAX_ARRAY_LEN = 500;                // scores/requireds/addons/groups
  var MAX_ID_LEN = 100;
  var MAX_TITLE_LEN = 300;
  var MAX_TEXT_LEN = 200000;
  var MAX_IMAGE_LEN = 500000;             // allows data: URLs
  var MAX_SHORT_LEN = 100;                // point-type ids, pick amounts, etc.

  var SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

  // --- Warning log (what looked strange / needed sanitizing) ---------------
  // Codes are deduped; the popup turns them into human-readable text and
  // asks the user to confirm when anything was flagged.
  var warnings = [];
  function warn(code) {
    if (warnings.indexOf(code) < 0) warnings.push(code);
  }

  // --- String scrubbing (defense-in-depth for viewer HTML sinks) ----------
  // The host viewer renders some fields (choice text, row titleText) as
  // HTML/markdown. We can't change its sanitizer, so imported strings get
  // the most dangerous constructs neutralized before they reach storage.
  function scrubHtml(text) {
    if (typeof text !== 'string') return '';
    return text
      .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<script[^>]*\/?>/gi, '')
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, '$1=$2#$2')
      .replace(/^(\s*)javascript:/i, '$1#'); // bare javascript:-prefixed values (e.g. image URL)
  }

  function clampString(v, max) {
    if (typeof v !== 'string') return '';
    var s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return s.length > max ? s.slice(0, max) : s;
  }

  function safeId(v) {
    return (typeof v === 'string' && v.length <= MAX_ID_LEN && SAFE_ID_RE.test(v)) ? v : '';
  }

  // Recursively reduce a JSON value to plain data: plain objects/arrays with
  // string/number/boolean leaves only; drops anything exotic and anything
  // named __proto__/constructor/prototype; enforces depth/size caps.
  function plainData(value, depth) {
    if (depth > 8) { warn('unsafe-data'); return null; }
    var t = typeof value;
    if (t === 'string') return clampString(value, MAX_TEXT_LEN);
    if (t === 'number') return isFinite(value) ? value : null;
    if (t === 'boolean' || value === null) return value;
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LEN) { warn('unsafe-data'); value = value.slice(0, MAX_ARRAY_LEN); }
      var outArr = [];
      for (var i = 0; i < value.length; i++) {
        var av = plainData(value[i], depth + 1);
        if (av !== null) outArr.push(av);
      }
      return outArr;
    }
    if (t === 'object') {
      var keys = Object.keys(value);
      if (keys.length > MAX_MAP_KEYS) { warn('unsafe-data'); keys = keys.slice(0, MAX_MAP_KEYS); }
      var outObj = {};
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') { warn('proto-key'); continue; }
        var vv = plainData(value[k], depth + 1);
        if (vv !== null) outObj[k] = vv;
      }
      return outObj;
    }
    warn('unsafe-data');
    return null;
  }

  // --- Choice sanitizer (field allowlist) ----------------------------------
  var CHOICE_STRING_FIELDS = { title: MAX_TITLE_LEN, text: MAX_TEXT_LEN, image: MAX_IMAGE_LEN, objectWidth: MAX_SHORT_LEN, activateThisChoice: MAX_TEXT_LEN, deactivateThisChoice: MAX_TEXT_LEN };
  var CHOICE_FLAG_FIELDS = ['imageIsUrl', 'isNotSelectable', 'isSelectableMultiple', 'activateOtherChoice', 'deactivateOtherChoice', 'isVisible', 'isCustom'];
  var CHOICE_LIST_FIELDS = ['scores', 'requireds', 'addons', 'groups'];
  var CHOICE_STRINGY_FIELDS = ['numMultipleTimesPluss', 'numMultipleTimesMinus', 'template'];

  function sanitizeChoice(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { warn('choice-rejected'); return null; }
    var out = {};
    var id = safeId(raw.id);
    if (raw.id !== undefined && raw.id !== '' && !id) warn('invalid-id');
    out.id = id || ('custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7));
    out.rowId = safeId(raw.rowId);
    if (!out.rowId) { warn('choice-rejected'); return null; } // no valid destination → unusable
    Object.keys(CHOICE_STRING_FIELDS).forEach(function (f) {
      var orig = typeof raw[f] === 'string' ? raw[f] : '';
      var scrubbed = scrubHtml(orig);
      if (scrubbed !== orig) warn('html-scrubbed');
      if (orig.length > CHOICE_STRING_FIELDS[f]) warn('value-clamped');
      out[f] = clampString(scrubbed, CHOICE_STRING_FIELDS[f]);
    });
    if (out.title === '') out.title = 'Untitled Choice';
    Object.keys(raw).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      var known = CHOICE_STRING_FIELDS[k] !== undefined
        || CHOICE_FLAG_FIELDS.indexOf(k) >= 0
        || CHOICE_LIST_FIELDS.indexOf(k) >= 0
        || CHOICE_STRINGY_FIELDS.indexOf(k) >= 0
        || k === 'id' || k === 'rowId';
      if (!known) warn('unknown-field');
    });
    CHOICE_FLAG_FIELDS.forEach(function (f) {
      if (raw[f] !== undefined) out[f] = Boolean(raw[f]);
    });
    CHOICE_STRINGY_FIELDS.forEach(function (f) {
      var v = raw[f];
      if (typeof v === 'string' && v.length <= MAX_SHORT_LEN) out[f] = v;
      else if (typeof v === 'number' && isFinite(v)) out[f] = String(v);
      else if (v !== undefined && v !== null && v !== '') warn('value-clamped');
    });
    CHOICE_LIST_FIELDS.forEach(function (f) {
      if (Array.isArray(raw[f])) {
        if (raw[f].length > MAX_ARRAY_LEN) warn('unsafe-data');
        out[f] = plainData(raw[f], 0) || [];
      }
    });
    return out;
  }

  // --- Overlay sanitizer ----------------------------------------------------
  var ROW_STRING_FIELDS = { title: MAX_TITLE_LEN, titleText: MAX_TEXT_LEN, image: MAX_IMAGE_LEN, imageLink: MAX_IMAGE_LEN, objectWidth: MAX_SHORT_LEN, rowJustify: MAX_SHORT_LEN, template: MAX_SHORT_LEN, buttonId: MAX_SHORT_LEN, buttonType: MAX_SHORT_LEN, buttonText: MAX_SHORT_LEN, resultGroupId: MAX_SHORT_LEN };
  var ROW_FLAG_FIELDS = ['imageIsUrl', 'isInfoRow', 'isResultRow', 'isButtonRow', 'buttonRandom', 'deselectChoices', 'isEditModeOn', 'isRequirementOpen', 'isCustom'];
  var ROW_NUMBER_FIELDS = ['allowedChoices', 'currentChoices', 'buttonRandomNumber'];
  var ROW_LIST_FIELDS = ['requireds', 'objects'];

  function sanitizeRow(raw, rowId) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { warn('overlay-invalid-key'); return null; }
    var out = {};
    Object.keys(ROW_STRING_FIELDS).forEach(function (f) {
      var orig = typeof raw[f] === 'string' ? raw[f] : '';
      var scrubbed = scrubHtml(orig);
      if (scrubbed !== orig) warn('html-scrubbed');
      out[f] = clampString(scrubbed, ROW_STRING_FIELDS[f]);
    });
    ROW_FLAG_FIELDS.forEach(function (f) { if (raw[f] !== undefined) out[f] = Boolean(raw[f]); });
    ROW_NUMBER_FIELDS.forEach(function (f) {
      var v = parseInt(raw[f], 10);
      out[f] = isFinite(v) ? v : 0;
    });
    ROW_LIST_FIELDS.forEach(function (f) {
      if (Array.isArray(raw[f])) {
        if (raw[f].length > MAX_ARRAY_LEN) warn('unsafe-data');
        if (f === 'objects') {
          out[f] = raw[f].slice(0, MAX_ARRAY_LEN).map(function (o) {
            // Objects inside a created row may omit rowId — inherit the row's.
            return sanitizeChoice(Object.assign({}, o, { rowId: (o && o.rowId) || rowId }));
          }).filter(Boolean);
        } else {
          out[f] = plainData(raw[f], 0) || [];
        }
      }
    });
    Object.keys(raw).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      var known = ROW_STRING_FIELDS[k] !== undefined || ROW_FLAG_FIELDS.indexOf(k) >= 0
        || ROW_NUMBER_FIELDS.indexOf(k) >= 0 || ROW_LIST_FIELDS.indexOf(k) >= 0;
      if (!known) warn('unknown-field');
    });
    return out;
  }

  function sanitizeOverlay(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return null;
    var overlay = { version: 1, objects: {}, deleted: [], rowPatches: {}, rowOrder: {}, rows: {}, deletedRows: [], moves: [] };
    var objects = (raw.objects && typeof raw.objects === 'object') ? raw.objects : {};
    Object.keys(objects).slice(0, MAX_MAP_KEYS).forEach(function (objId) {
      if (!safeId(objId)) { warn('overlay-invalid-key'); return; }
      var patch = plainData(objects[objId], 0);
      if (patch && typeof patch === 'object' && !Array.isArray(patch)) overlay.objects[objId] = patch;
      else warn('overlay-invalid-key');
    });
    if (Array.isArray(raw.deleted)) {
      raw.deleted.slice(0, MAX_MAP_KEYS).forEach(function (id) {
        if (safeId(id)) overlay.deleted.push(id);
        else warn('overlay-invalid-key');
      });
    }
    var rowPatches = (raw.rowPatches && typeof raw.rowPatches === 'object') ? raw.rowPatches : {};
    Object.keys(rowPatches).slice(0, MAX_MAP_KEYS).forEach(function (rowId) {
      if (!safeId(rowId)) { warn('overlay-invalid-key'); return; }
      var patch = plainData(rowPatches[rowId], 0);
      if (patch && typeof patch === 'object' && !Array.isArray(patch)) overlay.rowPatches[rowId] = patch;
      else warn('overlay-invalid-key');
    });
    var rowOrder = (raw.rowOrder && typeof raw.rowOrder === 'object') ? raw.rowOrder : {};
    Object.keys(rowOrder).slice(0, MAX_MAP_KEYS).forEach(function (rowId) {
      if (!safeId(rowId) || !Array.isArray(rowOrder[rowId])) { warn('overlay-invalid-key'); return; }
      overlay.rowOrder[rowId] = rowOrder[rowId].slice(0, MAX_MAP_KEYS).filter(function (id) {
        if (safeId(id)) return true;
        warn('overlay-invalid-key');
        return false;
      });
    });
    // Editor-created rows: {rowId: {row, afterRowId}} ('' anchor = top)
    var overlayRows = (raw.rows && typeof raw.rows === 'object') ? raw.rows : {};
    Object.keys(overlayRows).slice(0, MAX_MAP_KEYS).forEach(function (rowId) {
      if (!safeId(rowId)) { warn('overlay-invalid-key'); return; }
      var entry = plainData(overlayRows[rowId], 0);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !entry.row || typeof entry.row !== 'object' || Array.isArray(entry.row)) { warn('overlay-invalid-key'); return; }
      var row = sanitizeRow(entry.row, rowId);
      if (!row) return;
      overlay.rows[rowId] = { row: row, afterRowId: safeId(entry.afterRowId) || '' };
    });
    if (Array.isArray(raw.deletedRows)) {
      raw.deletedRows.slice(0, MAX_MAP_KEYS).forEach(function (rowId) {
        if (safeId(rowId)) overlay.deletedRows.push(rowId);
        else warn('overlay-invalid-key');
      });
    }
    if (Array.isArray(raw.moves)) {
      raw.moves.slice(0, MAX_MOVES).forEach(function (mv) {
        if (!mv || typeof mv !== 'object') { warn('overlay-invalid-key'); return; }
        var id = safeId(mv.id), from = safeId(mv.from), to = safeId(mv.to);
        if (id && from && to) overlay.moves.push({ id: id, from: from, to: to });
        else warn('overlay-invalid-key');
      });
    }
    return overlay;
  }

  // --- Entry point ----------------------------------------------------------
  // Returns { choices: [...], overlay: {...}|null, rejected: n } or null when
  // nothing in the file is usable.
  function sanitizeImportPayload(parsed) {
    warnings = []; // reset per call
    var rawChoices = null;
    if (Array.isArray(parsed)) rawChoices = parsed;
    else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.customChoices)) rawChoices = parsed.customChoices;
    }
    if (!Array.isArray(rawChoices)) rawChoices = [];
    if (rawChoices.length > MAX_CHOICES) { warn('count-capped'); rawChoices = rawChoices.slice(0, MAX_CHOICES); }

    var choices = [];
    var seen = {};
    for (var i = 0; i < rawChoices.length; i++) {
      var c = sanitizeChoice(rawChoices[i]);
      if (!c) continue;
      if (seen[c.id]) c.id = c.id + '_' + Math.random().toString(36).slice(2, 7); // dedupe ids
      seen[c.id] = true;
      choices.push(c);
    }

    var overlay = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? sanitizeOverlay(parsed.editorOverlay) : null;

    if (choices.length === 0 && !overlay) return null;
    return { choices: choices, overlay: overlay, rejected: rawChoices.length - choices.length, warnings: warnings.slice() };
  }

  // Expose + the raw-file size limit for the popup to enforce.
  window.WormImportSanitizer = {
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    sanitizeImportPayload: sanitizeImportPayload
  };
})();

