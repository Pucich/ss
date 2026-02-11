(function () {
  const MANIFEST_URL = './builds-manifest.json';
  const PRELOAD_FORCE_AFTER_MS = 12000;
  const PRELOAD_LEVEL_FORCE = 5;
  const SWITCH_GRACE_EXTRA_MS = 6000;

  const state = {
    manifest: null,
    preloadStarted: false,
    preloadQueued: false,
    preloadQueueReason: null,
    preloadQueuedAt: 0,
    preloadForceTimer: null,
    preloadArmTimer: null,
    preloadRetryTimer: null,
    fullReady: false,
    active: 'lite',
    handoverRequested: false,
    switchStartedAt: 0,
    fallbackTimer: null,
    knownLevel: 0
  };

  const stage = document.getElementById('build-stage');
  const liteFrame = document.getElementById('lite-frame');
  const fullFrame = document.getElementById('full-frame');
  const overlay = document.getElementById('handover-overlay');

  const storageFallback = {};
  let storageWarned = false;

  function warnStorageFallbackOnce(error) {
    if (storageWarned) {
      return;
    }
    storageWarned = true;
    console.warn('[orchestrator] localStorage unavailable, using in-memory fallback', error);
  }

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      warnStorageFallbackOnce(error);
      return Object.prototype.hasOwnProperty.call(storageFallback, key) ? storageFallback[key] : null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return;
    } catch (error) {
      warnStorageFallbackOnce(error);
    }
    storageFallback[key] = String(value);
  }

  function safeStorageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      warnStorageFallbackOnce(error);
    }
    delete storageFallback[key];
  }

  function safeStorageKeysByPrefix(prefix) {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          keys.push(key);
        }
      }
    } catch (error) {
      warnStorageFallbackOnce(error);
    }

    Object.keys(storageFallback).forEach((key) => {
      if (key.startsWith(prefix) && !keys.includes(key)) {
        keys.push(key);
      }
    });

    return keys;
  }

  function getResumeLevel() {
    return state.knownLevel > 0 ? (state.knownLevel + 1) : 1;
  }

  function persistHandoverLevel() {
    safeStorageSet('handover:resume-level', String(getResumeLevel()));
    safeStorageSet('handover:known-lite-level', String(state.knownLevel));
  }

  function sendMessageToFull(payload) {
    if (!fullFrame.contentWindow) {
      return;
    }
    fullFrame.contentWindow.postMessage(payload, window.location.origin);
  }

  function sendHandoverStateToFull(reason) {
    persistHandoverLevel();

    sendMessageToFull({
      type: 'handover-state',
      buildId: 'full',
      reason,
      resumeLevel: getResumeLevel(),
      knownLiteLevel: state.knownLevel
    });
  }

  function safeParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      console.error('[orchestrator] Invalid manifest JSON', error);
      return null;
    }
  }

  function showOverlay() {
    overlay.classList.add('is-visible');
  }

  function hideOverlay() {
    overlay.classList.remove('is-visible');
  }

  function activate(frameKey) {
    const isLite = frameKey === 'lite';
    liteFrame.classList.toggle('is-active', isLite);
    fullFrame.classList.toggle('is-active', !isLite);
    fullFrame.classList.toggle('is-warm', isLite);
    state.active = frameKey;
  }

  function markFullReady() {
    if (state.fullReady) {
      return;
    }

    state.fullReady = true;
    const cacheKey = getFullReadyKey();
    if (cacheKey) {
      safeStorageSet(cacheKey, '1');
    }

    if (state.handoverRequested) {
      completeSwitch('build-ready');
    }
  }

  function getFullReadyKey() {
    if (!state.manifest || !state.manifest.full || !state.manifest.full.version) {
      return null;
    }
    return `full-ready:${state.manifest.full.version}`;
  }

  function hydrateReadyFlagFromCache() {
    const cacheKey = getFullReadyKey();
    if (!cacheKey) {
      return;
    }

    state.fullReady = safeStorageGet(cacheKey) === '1';
  }

  function resetOldFullReadyFlags() {
    if (!state.manifest || !state.manifest.full || !state.manifest.full.version) {
      return;
    }

    const keep = getFullReadyKey();
    safeStorageKeysByPrefix('full-ready:').forEach((key) => {
      if (key !== keep) {
        safeStorageRemove(key);
      }
    });
  }

  function startFullPreload(reason) {
    if (state.preloadStarted) {
      return;
    }

    if (state.preloadArmTimer) {
      clearTimeout(state.preloadArmTimer);
      state.preloadArmTimer = null;
    }

    if (state.preloadRetryTimer) {
      clearTimeout(state.preloadRetryTimer);
      state.preloadRetryTimer = null;
    }

    if (state.preloadForceTimer) {
      clearTimeout(state.preloadForceTimer);
      state.preloadForceTimer = null;
    }

    state.preloadStarted = true;
    state.preloadQueued = false;
    state.preloadQueueReason = null;

    fullFrame.src = `${state.manifest.full.url}${state.manifest.full.url.includes('?') ? '&' : '?'}mode=full&preload=1`;
    sendHandoverStateToFull(`preload-start:${reason}`);
    console.log('[orchestrator] full preload started:', reason);
  }

  function scheduleForcedPreloadStart() {
    if (!state.preloadQueued || state.preloadStarted || state.preloadForceTimer) {
      return;
    }

    state.preloadForceTimer = window.setTimeout(() => {
      state.preloadForceTimer = null;
      if (!state.preloadStarted) {
        startFullPreload('queue-deadline');
      }
    }, PRELOAD_FORCE_AFTER_MS);
  }

  function queueFullPreload(reason) {
    if (state.preloadStarted || state.preloadQueued) {
      return;
    }

    state.preloadQueued = true;
    state.preloadQueueReason = reason;
    state.preloadQueuedAt = Date.now();
    scheduleForcedPreloadStart();
    console.log('[orchestrator] full preload queued:', reason);
  }

  function runPreloadWhenSafe() {
    if (!state.preloadQueued || state.preloadStarted) {
      return;
    }

    const queuedReason = state.preloadQueueReason || 'safe-moment';
    const queuedForMs = Date.now() - state.preloadQueuedAt;
    if (queuedForMs >= PRELOAD_FORCE_AFTER_MS) {
      startFullPreload(`${queuedReason}:deadline`);
      return;
    }

    if (document.visibilityState === 'hidden') {
      startFullPreload(`${queuedReason}:hidden-tab`);
      return;
    }

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback((deadline) => {
        if (!state.preloadQueued || state.preloadStarted) {
          return;
        }

        const isSafeNow = deadline.didTimeout || deadline.timeRemaining() >= 12;

        if (isSafeNow) {
          startFullPreload(`${queuedReason}:idle`);
          return;
        }

        state.preloadRetryTimer = window.setTimeout(runPreloadWhenSafe, 1200);
      }, { timeout: 3500 });
      return;
    }

    state.preloadRetryTimer = window.setTimeout(() => {
      startFullPreload(`${queuedReason}:fallback`);
    }, 1800);
  }

  function requestSwitchToFull(reason) {
    if (state.handoverRequested) {
      return;
    }

    state.handoverRequested = true;
    state.switchStartedAt = Date.now();
    startFullPreload(`switch:${reason}`);
    sendHandoverStateToFull(`switch:${reason}`);
    sendMessageToFull({ type: 'handover-activate', buildId: 'full' });

    if (state.fullReady) {
      completeSwitch('already-ready');
      return;
    }

    showOverlay();
    const maxWait = Number(state.manifest.preload?.fallbackSwitchTimeoutMs || 15000);
    state.fallbackTimer = window.setTimeout(() => {
      if (state.fullReady) {
        completeSwitch('fallback-ready');
        return;
      }

      console.warn('[orchestrator] switch fallback timeout before full ready; extending grace');
      state.fallbackTimer = window.setTimeout(() => {
        completeSwitch('fallback-force');
      }, SWITCH_GRACE_EXTRA_MS);
    }, maxWait);
  }

  function completeSwitch(reason) {
    if (state.fallbackTimer) {
      clearTimeout(state.fallbackTimer);
      state.fallbackTimer = null;
    }

    sendMessageToFull({ type: 'handover-activate', buildId: 'full', reason: `activate:${reason}` });
    activate('full');

    const elapsed = Date.now() - state.switchStartedAt;
    const minMaskMs = 250;
    const hideDelay = elapsed < minMaskMs ? (minMaskMs - elapsed) : 0;

    setTimeout(hideOverlay, hideDelay);
    console.log('[orchestrator] switched to full:', reason, 'in', elapsed, 'ms');
  }

  function handleMessage(event) {
    if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') {
      return;
    }

    const msg = event.data;

    if (msg.type === 'build-ready' && msg.buildId === 'full') {
      sendHandoverStateToFull('full-build-ready');
      markFullReady();
      return;
    }

    if (msg.type === 'game-over' && msg.buildId === 'lite') {
      requestSwitchToFull('game-over');
      return;
    }

    if (msg.type === 'level-reached' && msg.buildId === 'lite') {
      state.knownLevel = Number(msg.level) || 0;
      persistHandoverLevel();
      if (state.preloadStarted) {
        sendHandoverStateToFull('lite-level-update');
      }

      if (state.knownLevel >= PRELOAD_LEVEL_FORCE) {
        queueFullPreload('level-force-trigger');
        startFullPreload('level-force-trigger');
        return;
      }

      if (state.knownLevel >= 3) {
        queueFullPreload('level-trigger');
        runPreloadWhenSafe();
      }
    }
  }

  async function loadManifest() {
    const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
    const manifestText = await response.text();
    const manifest = safeParseJson(manifestText);

    if (!manifest || !manifest.lite || !manifest.full) {
      throw new Error('Invalid builds-manifest.json shape');
    }

    state.manifest = manifest;
    resetOldFullReadyFlags();
    hydrateReadyFlagFromCache();
  }

  async function bootstrap() {
    try {
      await loadManifest();
    } catch (error) {
      console.error('[orchestrator] bootstrap failed', error);
      stage.innerHTML = '<div style="color:#fff;padding:16px;font-family:sans-serif">Не удалось загрузить манифест билдов</div>';
      return;
    }

    window.addEventListener('message', handleMessage);
    document.addEventListener('visibilitychange', runPreloadWhenSafe);

    liteFrame.src = `${state.manifest.lite.url}${state.manifest.lite.url.includes('?') ? '&' : '?'}mode=lite`;

    activate('lite');
    persistHandoverLevel();

    const delay = Number(state.manifest.preload?.triggerDelayMs || 14000);
    state.preloadArmTimer = window.setTimeout(() => {
      queueFullPreload('armed-timer');
      runPreloadWhenSafe();
    }, delay);
  }

  bootstrap();
})();
