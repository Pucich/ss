(function () {
  'use strict';

  const MANIFEST_PATH = './builds-manifest.json';
  const STORAGE_KEY_PREFIX = 'full-ready:';

  const state = {
    manifest: null,
    liteReady: false,
    fullPreloadStarted: false,
    fullReady: false,
    fullRequested: false,
    transitionStarted: false,
    currentBuild: 'lite',
    unity: {
      lite: null,
      full: null
    },
    host: {
      liteCanvas: null,
      fullCanvas: null,
      handoverOverlay: null,
      handoverSpinner: null
    },
    warmupTimerId: null
  };

  function resolveAsset(baseDir, file) {
    if (!file) return null;
    const normalizedBase = String(baseDir || '').replace(/\/+$/, '');
    const normalizedFile = String(file || '').replace(/^\/+/, '');
    return normalizedBase ? `${normalizedBase}/${normalizedFile}` : normalizedFile;
  }

  async function fetchManifest() {
    const response = await fetch(MANIFEST_PATH, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Manifest load failed: ${response.status}`);
    }
    return response.json();
  }

  function getActiveKeys() {
    return state.manifest.activeTrack || { lite: 'lite', full: 'full' };
  }

  function getBuildConfig(kind) {
    const keys = getActiveKeys();
    const key = keys[kind];
    return state.manifest.builds[key];
  }

  function getFullCacheKey() {
    const full = getBuildConfig('full');
    return `${STORAGE_KEY_PREFIX}${full.version}`;
  }

  function markFullReady() {
    const key = getFullCacheKey();
    localStorage.setItem(key, String(Date.now()));
    state.fullReady = true;
  }

  function isFullAlreadyReady() {
    const full = getBuildConfig('full');
    Object.keys(localStorage)
      .filter((k) => k.startsWith(STORAGE_KEY_PREFIX) && k !== `${STORAGE_KEY_PREFIX}${full.version}`)
      .forEach((k) => localStorage.removeItem(k));

    return Boolean(localStorage.getItem(getFullCacheKey()));
  }

  function setTransitionOverlay(visible) {
    if (!state.host.handoverOverlay) return;
    state.host.handoverOverlay.classList.toggle('is-visible', visible);
  }

  function activateCanvas(kind) {
    const isLite = kind === 'lite';
    state.host.liteCanvas.classList.toggle('is-active', isLite);
    state.host.fullCanvas.classList.toggle('is-active', !isLite);
    state.currentBuild = kind;
  }

  function loadUnityBuild(kind, canvas) {
    const build = getBuildConfig(kind);
    const loaderUrl = resolveAsset(build.baseDir, build.loader);

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = loaderUrl;
      script.async = true;
      script.onload = async () => {
        try {
          if (typeof window.createUnityInstance !== 'function') {
            throw new Error('createUnityInstance is unavailable after loader script');
          }

          const unity = await window.createUnityInstance(
            canvas,
            {
              dataUrl: resolveAsset(build.baseDir, build.data),
              frameworkUrl: resolveAsset(build.baseDir, build.framework),
              codeUrl: resolveAsset(build.baseDir, build.wasm),
              streamingAssetsUrl: resolveAsset(build.baseDir, 'StreamingAssets'),
              companyName: 'Company',
              productName: 'Game',
              productVersion: build.version
            },
            () => {
              // Не трогаем ваш существующий progress bar и его логику.
            }
          );

          resolve(unity);
        } catch (error) {
          reject(error);
        }
      };
      script.onerror = () => reject(new Error(`Loader script failed: ${loaderUrl}`));
      document.head.appendChild(script);
    });
  }

  async function startLite() {
    state.unity.lite = await loadUnityBuild('lite', state.host.liteCanvas);
    state.liteReady = true;
    activateCanvas('lite');

    if (!state.fullPreloadStarted) {
      const delay = state.manifest.switching.warmupFallbackDelayMs || 8000;
      state.warmupTimerId = setTimeout(startFullWarmup, delay);
    }
  }

  async function startFullWarmup() {
    if (state.fullPreloadStarted || state.fullReady) return;

    state.fullPreloadStarted = true;
    if (state.warmupTimerId) {
      clearTimeout(state.warmupTimerId);
      state.warmupTimerId = null;
    }

    try {
      state.unity.full = await loadUnityBuild('full', state.host.fullCanvas);
      markFullReady();

      if (state.fullRequested) {
        activateCanvas('full');
        setTransitionOverlay(false);
      }
    } catch (error) {
      console.error('[orchestrator] Full warmup failed', error);
      state.fullPreloadStarted = false;
    }
  }

  async function requestFullSwitch() {
    if (state.transitionStarted || state.currentBuild === 'full') return;
    state.transitionStarted = true;

    const maxWait = state.manifest.switching.maxHandoverWaitMs || 14000;
    const poll = state.manifest.switching.pollIntervalMs || 120;

    if (state.fullReady || isFullAlreadyReady()) {
      if (!state.unity.full) {
        await startFullWarmup();
      }
      activateCanvas('full');
      state.fullRequested = true;
      setTransitionOverlay(false);
      return;
    }

    state.fullRequested = true;
    setTransitionOverlay(true);
    if (!state.fullPreloadStarted) {
      startFullWarmup();
    }

    const startedAt = performance.now();
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (state.fullReady && state.unity.full) {
          clearInterval(timer);
          resolve();
          return;
        }

        if (performance.now() - startedAt >= maxWait) {
          clearInterval(timer);
          resolve();
        }
      }, poll);
    });

    if (state.fullReady && state.unity.full) {
      activateCanvas('full');
    }

    setTransitionOverlay(false);
  }

  function handleLevelReached(level) {
    const switching = state.manifest.switching || {};
    if (level >= (switching.warmupStartLevel || 3)) {
      startFullWarmup();
    }

    if (level >= (switching.switchLevel || 6)) {
      requestFullSwitch();
    }
  }

  function bindPublicApi() {
    window.GameLevelReached = function GameLevelReached(level) {
      const normalized = Number(level) || 0;
      handleLevelReached(normalized);
    };

    window.GameOver = function GameOver() {
      requestFullSwitch();
    };
  }

  function resolveDom() {
    state.host.liteCanvas = document.getElementById('lite-canvas');
    state.host.fullCanvas = document.getElementById('full-canvas');
    state.host.handoverOverlay = document.getElementById('handover-overlay');
    state.host.handoverSpinner = document.getElementById('handover-spinner');

    if (!state.host.liteCanvas || !state.host.fullCanvas || !state.host.handoverOverlay) {
      throw new Error('Missing shell DOM nodes for orchestrator');
    }
  }

  async function bootstrap() {
    try {
      state.manifest = await fetchManifest();
      resolveDom();
      bindPublicApi();

      state.fullReady = isFullAlreadyReady();

      await startLite();
      if (state.fullReady) {
        startFullWarmup();
      }
    } catch (error) {
      console.error('[orchestrator] bootstrap failed', error);
      setTransitionOverlay(false);
    }
  }

  document.addEventListener('DOMContentLoaded', bootstrap);
})();
