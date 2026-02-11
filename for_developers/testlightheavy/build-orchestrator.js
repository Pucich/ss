(function () {
  const MANIFEST_URL = './builds-manifest.json';

  const state = {
    manifest: null,
    preloadStarted: false,
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
      localStorage.setItem(cacheKey, '1');
    }

    if (state.handoverRequested) {
      completeSwitch();
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

    state.fullReady = localStorage.getItem(cacheKey) === '1';
  }

  function resetOldFullReadyFlags() {
    if (!state.manifest || !state.manifest.full || !state.manifest.full.version) {
      return;
    }

    const keep = getFullReadyKey();
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith('full-ready:') && key !== keep) {
        localStorage.removeItem(key);
      }
    });
  }

  function startFullPreload(reason) {
    if (state.preloadStarted) {
      return;
    }
    state.preloadStarted = true;

    fullFrame.src = `${state.manifest.full.url}${state.manifest.full.url.includes('?') ? '&' : '?'}mode=full&preload=1`;
    console.log('[orchestrator] full preload started:', reason);
  }

  function requestSwitchToFull(reason) {
    if (state.handoverRequested) {
      return;
    }

    state.handoverRequested = true;
    state.switchStartedAt = Date.now();
    startFullPreload(`switch:${reason}`);

    if (state.fullReady) {
      completeSwitch();
      return;
    }

    showOverlay();
    const maxWait = Number(state.manifest.preload?.fallbackSwitchTimeoutMs || 15000);
    state.fallbackTimer = window.setTimeout(() => {
      completeSwitch();
    }, maxWait);
  }

  function completeSwitch() {
    if (state.fallbackTimer) {
      clearTimeout(state.fallbackTimer);
      state.fallbackTimer = null;
    }

    activate('full');

    const elapsed = Date.now() - state.switchStartedAt;
    const minMaskMs = 250;
    const hideDelay = elapsed < minMaskMs ? (minMaskMs - elapsed) : 0;

    setTimeout(hideOverlay, hideDelay);
  }

  function handleMessage(event) {
    if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') {
      return;
    }

    const msg = event.data;

    if (msg.type === 'build-ready' && msg.buildId === 'full') {
      markFullReady();
      return;
    }

    if (msg.type === 'game-over' && msg.buildId === 'lite') {
      requestSwitchToFull('game-over');
      return;
    }

    if (msg.type === 'level-reached' && msg.buildId === 'lite') {
      state.knownLevel = Number(msg.level) || 0;
      if (state.knownLevel >= 3) {
        startFullPreload('level-trigger');
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

    liteFrame.src = `${state.manifest.lite.url}${state.manifest.lite.url.includes('?') ? '&' : '?'}mode=lite`;

    activate('lite');

    const delay = Number(state.manifest.preload?.triggerDelayMs || 14000);
    setTimeout(() => startFullPreload('time-trigger'), delay);
  }

  bootstrap();
})();
