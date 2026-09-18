// page-script.js - Runs in the page's MAIN execution world (has direct access to window.app, Vue 3, Pinia)

(function () {
  console.log('[Worm V17 Mod] Page script initialized in MAIN world.');

  // In-memory registry of custom choices and detected project reference
  let savedCustomChoices = [];
  let detectedProject = null;
  let hookAttempts = 0;
  let activeProjectStore = null;

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
    // Positive value = cost, negative value = gain (ICC Neo convention)
    // Also respect explicit beforeText hints from old and new formats
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
      isDefault: false,
      isPrivateStyling: false,
      styling: null,
      template: 1,
      isCustom: true
    };
  }

  // =========================================================================
  // 2. Network / Fetch Interceptor (Catches project.json before viewer mounts)
  // =========================================================================
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

    if (url.includes('project') && url.endsWith('.json')) {
      try {
        const cloned = response.clone();
        const json = await cloned.json();

        if (json && Array.isArray(json.rows) && Array.isArray(json.pointTypes)) {
          console.log('[Worm V17 Mod] Intercepted CYOA project.json via fetch:', json.title || 'Untitled CYOA');
          detectedProject = json;

          // Merge any saved custom choices into the JSON before the viewer reads it
          if (savedCustomChoices.length > 0) {
            applyChoicesToRawProject(json, savedCustomChoices);
          }

          // Broadcast metadata early
          emitCyoaMetadata(json.rows, json.pointTypes);

          // Return the modified response
          return new Response(JSON.stringify(json), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }
      } catch (err) {
        console.warn('[Worm V17 Mod] Fetch interception pass-through due to error:', err);
      }
    }

    return response;
  };

  // =========================================================================
  // 3. (removed) The old DOM-level updater relied on `__vueParentComponent`,
  //    which production Vue builds do not attach to elements. Live updates are
  //    handled entirely through the Pinia "project" store in
  //    applyChoicesToPiniaStore() below.
  // =========================================================================

  // =========================================================================
  // 4. Vue / Pinia Store Runtime Hook
  // =========================================================================
  function findPiniaProjectStore() {
    const nuxtEl = document.querySelector('#__nuxt');
    if (nuxtEl && nuxtEl.__vue_app__) {
      const app = nuxtEl.__vue_app__;
      const provides = app._context?.provides;
      if (provides) {
        // The Pinia instance is provided under an anonymous Symbol() in production
        // builds (no 'pinia' description), so identify it by its _s store map instead.
        for (const s of Object.getOwnPropertySymbols(provides)) {
          const v = provides[s];
          if (v && v._s && typeof v._s.has === 'function' && v._s.has('project')) {
            return v._s.get('project');
          }
        }
      }
    }

    if (window.__PINIA__ && window.__PINIA__._s && window.__PINIA__._s.has('project')) {
      return window.__PINIA__._s.get('project');
    }

    return null;
  }

  function findVue2App() {
    if (window.app && Array.isArray(window.app.rows)) {
      return window.app;
    }
    const appEl = document.querySelector('#app');
    if (appEl && appEl.__vue__ && Array.isArray(appEl.__vue__.rows)) {
      return appEl.__vue__;
    }
    return null;
  }

  const hookInterval = setInterval(() => {
    hookAttempts++;

    const piniaStore = findPiniaProjectStore();
    if (piniaStore && piniaStore.store && piniaStore.store.status === 'loaded') {
      activeProjectStore = piniaStore;
      const fileData = piniaStore.store.file?.data;
      if (fileData) {
        console.log('[Worm V17 Mod] Connected to Pinia project store!');
        emitCyoaMetadata(fileData.rows, fileData.pointTypes);
        applyChoicesToPiniaStore(piniaStore, savedCustomChoices);
        clearInterval(hookInterval);
        return;
      }
    }

    const vue2 = findVue2App();
    if (vue2) {
      console.log('[Worm V17 Mod] Connected to Vue 2 CYOA app!');
      emitCyoaMetadata(vue2.rows, vue2.pointTypes || vue2.scores);
      applyChoicesToVue2(vue2, savedCustomChoices);
      clearInterval(hookInterval);
      return;
    }

    if (hookAttempts > 60) {
      clearInterval(hookInterval);
    }
  }, 1000);

  function applyChoicesToRawProject(projectData, choices) {
    if (!projectData || !Array.isArray(projectData.rows)) return;
    const pointTypes = projectData.pointTypes || [];

    for (const raw of choices) {
      const choice = normalizeChoice(raw, pointTypes);
      const row = projectData.rows.find(r => r.id === choice.rowId);
      if (row) {
        if (!Array.isArray(row.objects)) row.objects = [];
        const existingIdx = row.objects.findIndex(o => o.id === choice.id);
        if (existingIdx >= 0) {
          row.objects[existingIdx] = choice;
        } else {
          row.objects.push(choice);
        }
      }
    }
  }

  // Shared two-step row remount used by both injection (add/update) and removal.
  // CollectionLoader renders each row's items incrementally with a timer that
  // PAUSES once complete; it only resumes when the row's `isVisible` prop flips,
  // so simply changing `objects` leaves the loader's internal list stale.
  // Trick: empty the affected rows (their loader unmounts via v-if="objects.length>0"),
  // then restore the full row copies 50ms later — the loader remounts and re-renders
  // every item. Selection state lives in the store (`selected`/`selectedIds`), so it
  // survives the remount. Row maps: rowId -> full replacement row object.
  function swapRowsWithRemount(store, emptiedMap, restoreMap, successLog) {
    const replaceRows = (stateVal, rowMap) => {
      const file = stateVal.file;
      const data = file.data;
      store.store = {
        ...stateVal,
        file: {
          ...file,
          data: {
            ...data,
            rows: data.rows.map(r => rowMap.get(r.id) || r)
          }
        }
      };
    };

    // Step 1: empty the affected rows -> CollectionLoader unmounts.
    replaceRows(store.store, emptiedMap);

    // Step 2: restore the pre-built full rows. Re-read state in case the app
    // changed it in the interim; never merge with the live rows — they are the
    // emptied copies written by step 1 (merging would corrupt object lists).
    setTimeout(() => {
      try {
        const cur = store.store;
        const curRows = cur?.file?.data?.rows;
        if (!Array.isArray(curRows)) return;
        replaceRows(cur, restoreMap);
        if (successLog) console.log(successLog);
      } catch (err) {
        console.error('[Worm V17 Mod] Error during row remount (step 2):', err);
      }
    }, 50);
  }

  // Live-removes custom choices from the Pinia "project" store by id.
  function removeChoicesFromPiniaStore(store, choiceIds) {
    try {
      const ids = new Set(choiceIds);
      const stateVal = store.store;
      if (!stateVal || stateVal.status !== 'loaded' || !stateVal.file?.data || !Array.isArray(stateVal.file.data.rows)) {
        return false;
      }
      const rows = stateVal.file.data.rows;

      // Build replacement copies only for rows that actually contain a target id;
      // untouched rows keep their original object references.
      const newRowById = new Map();
      for (const row of rows) {
        if (!Array.isArray(row.objects) || !row.objects.some(o => o && ids.has(o.id))) continue;
        newRowById.set(row.id, { ...row, objects: row.objects.filter(o => !(o && ids.has(o.id))) });
      }
      if (newRowById.size === 0) return false;

      const emptiedMap = new Map();
      for (const rowId of newRowById.keys()) {
        const origRow = rows.find(r => r.id === rowId);
        emptiedMap.set(rowId, { ...origRow, objects: [] });
      }
      swapRowsWithRemount(store, emptiedMap, newRowById, '[Worm V17 Mod] Removed custom choices from Pinia store: ' + choiceIds.length);
      return true;
    } catch (err) {
      console.error('[Worm V17 Mod] Error removing choices from Pinia store:', err);
      return false;
    }
  }

  // Legacy Vue 2 fallback: remove choices from the live app rows.
  function removeChoicesFromVue2(app, choiceIds) {
    try {
      if (!Array.isArray(app.rows)) return;
      const ids = new Set(choiceIds);
      for (const row of app.rows) {
        if (!Array.isArray(row.objects)) continue;
        row.objects = row.objects.filter(o => !(o && ids.has(o.id)));
      }
    } catch (err) {
      console.error('[Worm V17 Mod] Error removing choices from Vue 2:', err);
    }
  }

  function applyChoicesToPiniaStore(store, choices) {
    try {
      // On the Pinia store proxy, refs are unwrapped: `store.store` IS the raw
      // shallowRef value ({ status, file: { data: { rows, pointTypes } }, ... }).
      // Writing via plain assignment (`store.store = {...}`) routes through the
      // proxy setter into the underlying shallowRef and triggers reactivity.
      const stateVal = store.store;
      if (!stateVal || stateVal.status !== 'loaded' || !stateVal.file?.data || !Array.isArray(stateVal.file.data.rows)) {
        return false;
      }
      const file = stateVal.file;
      const data = file.data;
      const rows = data.rows;

      // Merge the normalized choices into COPIES of their target rows, keyed by rowId.
      // Untouched rows keep their original object references.
      const newRowById = new Map();
      for (const raw of choices) {
        const choice = normalizeChoice(raw, data.pointTypes || []);
        const origRow = rows.find(r => r.id === choice.rowId);
        if (!origRow) {
          console.warn('[Worm V17 Mod] rowId not found for choice:', choice.rowId);
          continue;
        }
        const target = newRowById.get(choice.rowId) || origRow;
        const objects = Array.isArray(target.objects) ? target.objects.slice() : [];
        const existingIdx = objects.findIndex(o => o.id === choice.id);
        if (existingIdx >= 0) {
          objects[existingIdx] = choice;
        } else {
          objects.push(choice);
        }
        newRowById.set(choice.rowId, { ...target, objects });
      }
      if (newRowById.size === 0) return false;

      const emptiedMap = new Map();
      for (const rowId of newRowById.keys()) {
        const origRow = rows.find(r => r.id === rowId);
        emptiedMap.set(rowId, { ...origRow, objects: [] });
      }
      swapRowsWithRemount(
        store,
        emptiedMap,
        newRowById,
        '[Worm V17 Mod] Injected & updated Pinia store with custom choices: ' + choices.length
      );

      return true;
    } catch (err) {
      console.error('[Worm V17 Mod] Error applying choices to Pinia store:', err);
      return false;
    }
  }

  function applyChoicesToVue2(app, choices) {
    try {
      if (!Array.isArray(app.rows)) return;
      const pointTypes = app.pointTypes || app.scores || [];
      for (const raw of choices) {
        const choice = normalizeChoice(raw, pointTypes);
        const row = app.rows.find(r => r.id === choice.rowId);
        if (row) {
          if (!Array.isArray(row.objects)) row.objects = [];
          const existingIdx = row.objects.findIndex(o => o.id === choice.id);
          if (existingIdx >= 0) {
            row.objects.splice(existingIdx, 1, choice);
          } else {
            row.objects.push(choice);
          }
        }
      }
      console.log('[Worm V17 Mod] Injected custom choices into Vue 2 app:', choices.length);
    } catch (err) {
      console.error('[Worm V17 Mod] Error applying choices to Vue 2:', err);
    }
  }

  function emitCyoaMetadata(rows, pointTypes) {
    if (!Array.isArray(rows)) return;

    const rowList = rows.map(r => ({
      id: r.id,
      title: r.title || r.id,
      count: Array.isArray(r.objects) ? r.objects.length : 0
    }));

    const pointList = Array.isArray(pointTypes)
      ? pointTypes.map(pt => ({
          id: pt.id,
          name: pt.name || pt.id,
          startingSum: pt.startingSum || 0
        }))
      : [];

    window.postMessage({
      source: 'WORM_CYOA_PAGE_SCRIPT',
      type: 'CYOA_METADATA_LOADED',
      data: {
        detected: true,
        title: document.title,
        rows: rowList,
        pointTypes: pointList
      }
    }, '*');
  }

  // =========================================================================
  // 5. Message Listener (Commands from Extension / content.js)
  // =========================================================================
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.target !== 'WORM_CYOA_PAGE_SCRIPT') {
      return;
    }

    const { command, payload } = event.data;

    if (command === 'SYNC_CUSTOM_CHOICES') {
      savedCustomChoices = Array.isArray(payload) ? payload : [];
      console.log('[Worm V17 Mod] Synced custom choices count:', savedCustomChoices.length);

      const piniaStore = findPiniaProjectStore();
      if (piniaStore && piniaStore.store?.file?.data) {
        applyChoicesToPiniaStore(piniaStore, savedCustomChoices);
      } else {
        const vue2 = findVue2App();
        if (vue2) applyChoicesToVue2(vue2, savedCustomChoices);
      }
    } else if (command === 'INJECT_SINGLE_CHOICE') {
      const choice = payload;
      const idx = savedCustomChoices.findIndex(c => c.id === choice.id);
      if (idx >= 0) savedCustomChoices[idx] = choice;
      else savedCustomChoices.push(choice);

      const piniaStore = findPiniaProjectStore();
      if (piniaStore && piniaStore.store?.file?.data) {
        applyChoicesToPiniaStore(piniaStore, [choice]);
      } else {
        const vue2 = findVue2App();
        if (vue2) applyChoicesToVue2(vue2, [choice]);
      }

      window.postMessage({
        source: 'WORM_CYOA_PAGE_SCRIPT',
        type: 'CHOICE_INJECTED_SUCCESS',
        choiceId: choice.id
      }, '*');
    } else if (command === 'REMOVE_CHOICE') {
      const choiceIds = Array.isArray(payload) ? payload : [payload].filter(Boolean);
      // Drop from the in-memory registry first so a later project.json fetch or
      // full re-sync cannot resurrect the deleted choices.
      const before = savedCustomChoices.length;
      savedCustomChoices = savedCustomChoices.filter(c => !choiceIds.includes(c.id));
      console.log('[Worm V17 Mod] Remove request for ' + choiceIds.length + ' choice(s); registry: ' + before + ' -> ' + savedCustomChoices.length);

      let removedLive = false;
      const piniaStore = findPiniaProjectStore();
      if (piniaStore && piniaStore.store?.file?.data) {
        removedLive = removeChoicesFromPiniaStore(piniaStore, choiceIds);
      }
      if (!removedLive) {
        const vue2 = findVue2App();
        if (vue2) removeChoicesFromVue2(vue2, choiceIds);
      }

      window.postMessage({
        source: 'WORM_CYOA_PAGE_SCRIPT',
        type: 'CHOICE_REMOVED_SUCCESS',
        choiceIds
      }, '*');
    } else if (command === 'REQUEST_METADATA') {
      const piniaStore = findPiniaProjectStore();
      if (piniaStore && piniaStore.store?.file?.data) {
        const d = piniaStore.store.file.data;
        emitCyoaMetadata(d.rows, d.pointTypes);
      } else if (detectedProject) {
        emitCyoaMetadata(detectedProject.rows, detectedProject.pointTypes);
      } else {
        const vue2 = findVue2App();
        if (vue2) emitCyoaMetadata(vue2.rows, vue2.pointTypes || vue2.scores);
      }
    }
  });
})();
