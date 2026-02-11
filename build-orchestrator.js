(function () {
  const STATE = {
    INIT: 'INIT',
    LITE_RUNNING: 'LITE_RUNNING',
    FULL_PRELOADING: 'FULL_PRELOADING',
    FULL_READY: 'FULL_READY',
    SWITCHING: 'SWITCHING',
    FULL_RUNNING: 'FULL_RUNNING'
  };

  const storage = {
    get(key) {
      try { return localStorage.getItem(key); } catch (_) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch (_) {}
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (_) {}
    }
  };

  const dom = {
    liteRoot: null,
    fullRoot: null,
    loadingOverlay: null,
    loadingText: null,
    loadingFill: null
  };

  const ctx = {
    state: STATE.INIT,
    manifest: null,
    liteInstance: null,
    fullInstance: null,
    preloadStarted: false,
    preloadDone: false,
    switchInProgress: false,
    preloadTimer: null,
    fadeDurationMs: 220,
    fullReadyStorageKey: 'fullReadyVersion'
  };

  function qs(id) { return document.getElementById(id); }

  function setState(next) {
    ctx.state = next;
    console.info('[orchestrator] state:', next);
  }

  function showOverlay(message) {
    if (message && dom.loadingText) dom.loadingText.textContent = message;
    if (dom.loadingOverlay) dom.loadingOverlay.classList.add('visible');
  }

  function hideOverlay() {
    if (dom.loadingOverlay) dom.loadingOverlay.classList.remove('visible');
  }

  function updateOverlayProgress(progress) {
    if (!dom.loadingFill) return;
    const v = Math.max(0, Math.min(1, Number(progress) || 0));
    dom.loadingFill.style.transform = `scaleX(${v})`;
  }

  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(script);
    });
  }

  function composeUrl(baseUrl, path) {
    return `${baseUrl.replace(/\/$/, '')}/${String(path || '').replace(/^\//, '')}`;
  }

  function buildUnityConfig(buildCfg) {
    return {
      dataUrl: composeUrl(buildCfg.baseUrl, buildCfg.dataUrl),
      frameworkUrl: composeUrl(buildCfg.baseUrl, buildCfg.frameworkUrl),
      codeUrl: composeUrl(buildCfg.baseUrl, buildCfg.wasmUrl),
      streamingAssetsUrl: composeUrl(buildCfg.baseUrl, buildCfg.streamingAssetsUrl || 'StreamingAssets'),
      companyName: buildCfg.companyName || 'Unknown',
      productName: buildCfg.productName || 'Game',
      productVersion: buildCfg.version || '0.0.0'
    };
  }

  async function createUnityInContainer(container, buildCfg, onProgress) {
    const loaderAbsUrl = composeUrl(buildCfg.baseUrl, buildCfg.loaderUrl);
    await loadScript(loaderAbsUrl);

    if (typeof window.createUnityInstance !== 'function') {
      throw new Error('createUnityInstance is not available after loader script load');
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'unity-canvas';
    container.innerHTML = '';
    container.appendChild(canvas);

    const config = buildUnityConfig(buildCfg);
    return window.createUnityInstance(canvas, config, onProgress);
  }

  async function fetchManifest() {
    const r = await fetch('/builds-manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`Manifest fetch failed: ${r.status}`);
    return r.json();
  }

  function isFullReadyForCurrentVersion() {
    return storage.get(ctx.fullReadyStorageKey) === ctx.manifest.full.version;
  }

  function markFullReady() {
    storage.set(ctx.fullReadyStorageKey, ctx.manifest.full.version);
  }

  function clearStaleReadyVersion() {
    const stored = storage.get(ctx.fullReadyStorageKey);
    if (stored && stored !== ctx.manifest.full.version) {
      storage.remove(ctx.fullReadyStorageKey);
    }
  }

  async function startLite() {
    showOverlay('Запуск lite билда...');
    updateOverlayProgress(0);

    ctx.liteInstance = await createUnityInContainer(dom.liteRoot, ctx.manifest.lite, (p) => {
      updateOverlayProgress(p);
    });

    setState(STATE.LITE_RUNNING);
    hideOverlay();

    const delay = Number(ctx.manifest.preload?.fallbackDelayMs || 30000);
    ctx.preloadTimer = setTimeout(() => {
      startFullPreload().catch((e) => console.error('[orchestrator] preload from timeout failed', e));
    }, delay);
  }

  async function startFullDirect() {
    setState(STATE.FULL_PRELOADING);
    showOverlay('Запуск full билда...');

    ctx.fullInstance = await createUnityInContainer(dom.fullRoot, ctx.manifest.full, (p) => {
      updateOverlayProgress(p);
    });

    ctx.preloadDone = true;
    markFullReady();
    await activateFull(true);
  }

  async function startFullPreload() {
    if (ctx.preloadStarted || ctx.preloadDone) return;
    ctx.preloadStarted = true;
    setState(STATE.FULL_PRELOADING);

    try {
      ctx.fullRoot.classList.remove('active');
      ctx.fullRoot.classList.add('hidden');

      ctx.fullInstance = await createUnityInContainer(dom.fullRoot, ctx.manifest.full, (p) => {
        const clamped = Math.max(0.1, Math.min(0.95, Number(p) || 0));
        updateOverlayProgress(clamped);
      });

      ctx.preloadDone = true;
      markFullReady();
      setState(STATE.FULL_READY);
      console.info('[orchestrator] full preload completed');
    } catch (e) {
      console.error('[orchestrator] full preload failed', e);
      ctx.preloadStarted = false;
      ctx.preloadDone = false;
    }
  }

  async function activateFull(fromColdStart) {
    if (ctx.switchInProgress) return;
    ctx.switchInProgress = true;
    setState(STATE.SWITCHING);

    try {
      if (!ctx.fullInstance) {
        showOverlay('Загрузка full билда...');
        await startFullPreload();
      }

      if (!ctx.fullInstance) {
        throw new Error('Full instance missing after preload attempt');
      }

      dom.fullRoot.classList.remove('hidden');
      dom.fullRoot.classList.add('active');

      if (!fromColdStart) {
        dom.liteRoot.classList.add('fade-out');
        await new Promise((r) => setTimeout(r, ctx.fadeDurationMs));
      }

      dom.liteRoot.classList.add('hidden');
      dom.liteRoot.classList.remove('active', 'fade-out');

      if (ctx.liteInstance && typeof ctx.liteInstance.Quit === 'function') {
        try { await ctx.liteInstance.Quit(); } catch (_) {}
      }

      hideOverlay();
      setState(STATE.FULL_RUNNING);
    } finally {
      ctx.switchInProgress = false;
    }
  }

  function installGlobalHooks() {
    window.GameOver = async function GameOver() {
      console.info('[orchestrator] GameOver called');
      if (ctx.switchInProgress || ctx.state === STATE.FULL_RUNNING) return;

      if (ctx.preloadDone) {
        await activateFull(false);
        return;
      }

      showOverlay('Подгружаем full билд...');
      await startFullPreload();
      await activateFull(false);
    };

    window.GameLevelReached = function GameLevelReached(level) {
      const trigger = Number(ctx.manifest?.preload?.levelTrigger || 4);
      if (Number(level) >= trigger) {
        startFullPreload().catch((e) => console.error('[orchestrator] preload by level failed', e));
      }
    };
  }

  async function boot() {
    dom.liteRoot = qs('lite-root');
    dom.fullRoot = qs('full-root');
    dom.loadingOverlay = qs('loading-overlay');
    dom.loadingText = qs('loading-text');
    dom.loadingFill = qs('loading-fill');

    installGlobalHooks();

    try {
      ctx.manifest = await fetchManifest();
      clearStaleReadyVersion();
      ctx.fadeDurationMs = Number(ctx.manifest.preload?.fadeDurationMs || 220);

      dom.liteRoot.classList.add('active');
      dom.fullRoot.classList.add('hidden');

      if (isFullReadyForCurrentVersion()) {
        await startFullDirect();
      } else {
        await startLite();
      }
    } catch (e) {
      console.error('[orchestrator] boot failed, trying lite fallback', e);
      hideOverlay();
      showOverlay('Не удалось получить манифест. Запускаем lite режим.');
      setTimeout(() => hideOverlay(), 1500);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
