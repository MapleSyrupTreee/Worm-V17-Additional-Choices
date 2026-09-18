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
  // 3. Live DOM Updater (Injects choice into CollectionLoader without reload)
  // =========================================================================
  function forceRowUpdate(rowId, newObject) {
    const rowEl = document.querySelector('#row-' + rowId);
    if (!rowEl) return false;

    function findLoader(comp) {
      if (!comp) return null;
      if (comp.setupState && Array.isArray(comp.setupState.visible?.value)) {
        return comp;
      }
      if (comp.subTree) {
        return findLoaderInVNode(comp.subTree);
      }
      return null;
    }

    function findLoaderInVNode(vnode) {
      if (!vnode) return null;
      if (vnode.component) {
        const found = findLoader(vnode.component);
        if (found) return found;
      }
      if (Array.isArray(vnode.children)) {
        for (const child of vnode.children) {
          if (child && typeof child === 'object') {
            const found = findLoaderInVNode(child);
            if (found) return found;
          }
        }
      }
      return null;
    }

    const comp = rowEl.__vueParentComponent || rowEl.querySelector('.project-row')?.__vueParentComponent;
    const loader = findLoader(comp);

    if (loader && loader.setupState && loader.setupState.visible) {
      const visibleList = loader.setupState.visible;
      const exists = visibleList.value.some(o => o.id === newObject.id);
      if (!exists) {
        visibleList.value.push(newObject);
        if (loader.setupState.index) {
          loader.setupState.index.value++;
        }
      } else {
        const idx = visibleList.value.findIndex(o => o.id === newObject.id);
        visibleList.value.splice(idx, 1, newObject);
      }
      console.log('[Worm V17 Mod] Injected choice directly into visible row DOM for:', rowId);
      return true;
    }
    return false;
  }

  // =========================================================================
  // 4. Vue / Pinia Store Runtime Hook
  // =========================================================================
  function findPiniaProjectStore() {
    const nuxtEl = document.querySelector('#__nuxt');
    if (nuxtEl && nuxtEl.__vue_app__) {
      const app = nuxtEl.__vue_app__;
      const provides = app._context?.provides;
      if (provides) {
        const piniaKey = Object.getOwnPropertySymbols(provides).find(s => s.toString().includes('pinia'));
        const pinia = piniaKey ? provides[piniaKey] : provides.pinia;
        if (pinia && pinia._s && pinia._s.has('project')) {
          return pinia._s.get('project');
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
    if (piniaStore && piniaStore.store && piniaStore.store.value && piniaStore.store.value.status === 'loaded') {
      activeProjectStore = piniaStore;
      const fileData = piniaStore.store.value.file?.data;
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

  function applyChoicesToPiniaStore(store, choices) {
    try {
      const fileData = store.store.value?.file?.data;
      if (!fileData || !Array.isArray(fileData.rows)) return;
      const pointTypes = fileData.pointTypes || [];

      for (const raw of choices) {
        const choice = normalizeChoice(raw, pointTypes);
        const row = fileData.rows.find(r => r.id === choice.rowId);
        if (row) {
          if (!Array.isArray(row.objects)) row.objects = [];
          const existingIdx = row.objects.findIndex(o => o.id === choice.id);
          if (existingIdx >= 0) {
            row.objects.splice(existingIdx, 1, choice);
          } else {
            row.objects.push(choice);
          }

          // Live visual update into the row's CollectionLoader
          forceRowUpdate(row.id, choice);
        }
      }

      // Reassign store shallowRef so all store computed properties (getObject, getObjectRow, points) recompute!
      store.store.value = {
        ...store.store.value,
        file: {
          ...store.store.value.file,
          data: {
            ...fileData,
            rows: [...fileData.rows]
          }
        }
      };

      console.log('[Worm V17 Mod] Injected & updated Pinia store with custom choices:', choices.length);
    } catch (err) {
      console.error('[Worm V17 Mod] Error applying choices to Pinia store:', err);
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
      if (piniaStore && piniaStore.store?.value?.file?.data) {
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
      if (piniaStore && piniaStore.store?.value?.file?.data) {
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
    } else if (command === 'REQUEST_METADATA') {
      const piniaStore = findPiniaProjectStore();
      if (piniaStore && piniaStore.store?.value?.file?.data) {
        const d = piniaStore.store.value.file.data;
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
