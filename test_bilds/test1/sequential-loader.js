(function () {
  const DEFAULTS = {
    fullBuildUrl: (window.CMP_BUILD_CONFIG && window.CMP_BUILD_CONFIG.fullUrl) || '/prod_bilds/2025.12.25_new_api_serv/',
    fullVersion: (window.CMP_BUILD_CONFIG && window.CMP_BUILD_CONFIG.fullVersion) || 'unknown',
    manifestPath: 'build-manifest.json',
    manifestTimeoutMs: 12000,
    prefetchDelayMs: 25000,
    prefetchTimeoutMs: 45000,
    prefetchConcurrency: 2,
    overlayFadeMs: 220,
    staleAfterMs: 7 * 24 * 60 * 60 * 1000,
    loadingText: 'Загружаем полную версию…',
    waitingText: 'Подготавливаем полную версию…',
    retryDelayMs: 10000,
    gameOverWaitTimeoutMs: 8000,
    switchRetryTimeoutMs: 15000,
  };

  const cfg = Object.assign({}, DEFAULTS, window.SequentialLoaderConfig || {});
  const fullBaseUrl = new URL(cfg.fullBuildUrl, window.location.origin).toString();
  const fullIndexUrl = new URL('index.html', fullBaseUrl).toString();
  const manifestUrl = new URL(cfg.manifestPath, fullBaseUrl).toString();
  const storageKey = `cmp_full_state:${fullBaseUrl}`;
  const legacyReadyKey = `cmp_full_ready:${fullBaseUrl}`;
  const legacyVersionKey = `cmp_full_version:${fullBaseUrl}`;
  const telemetryKey = `cmp_full_telemetry:${fullBaseUrl}`;

  let prefetchPromise = null;
  let switching = false;
  let levelHookTriggered = false;
  let retryTimer = null;
  let prefetchQueued = false;

  function now() {
    return Date.now();
  }


  function writeTelemetry(patch) {
    try {
      const raw = localStorage.getItem(telemetryKey);
      const prev = raw ? JSON.parse(raw) : {};
      localStorage.setItem(telemetryKey, JSON.stringify(Object.assign({}, prev, patch, { updatedAt: now() })));
    } catch (err) {
      console.warn('[SequentialLoader] Failed to write telemetry', err);
    }
  }


  function queuePrefetch(trigger) {
    if (prefetchPromise || prefetchQueued) return;
    prefetchQueued = true;

    const run = () => {
      prefetchQueued = false;
      prefetchBuild(trigger || 'queued');
    };

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 2000 });
      return;
    }

    setTimeout(run, 0);
  }

  function readState() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (err) {
      console.warn('[SequentialLoader] Failed to parse state', err);
      return null;
    }
  }

  function writeState(next) {
    const prev = readState() || {};
    const merged = Object.assign({}, prev, next);
    localStorage.setItem(storageKey, JSON.stringify(merged));
    return merged;
  }


  function migrateLegacyReadyState() {
    const state = readState();
    if (state) return;

    const legacyReady = localStorage.getItem(legacyReadyKey) === '1';
    if (!legacyReady) return;

    const legacyVersion = localStorage.getItem(legacyVersionKey);
    if (legacyVersion && legacyVersion !== cfg.fullVersion) {
      return;
    }

    writeState({
      status: 'ready',
      version: cfg.fullVersion,
      updatedAt: now(),
      reason: 'migrated-legacy-ready',
    });
    console.log('[SequentialLoader] Legacy ready state migrated');
  }

  function resetState(reason) {
    localStorage.setItem(legacyReadyKey, '0');
    return writeState({
      status: 'idle',
      version: cfg.fullVersion,
      updatedAt: now(),
      reason: reason || 'reset',
    });
  }

  function markPrefetching(reason) {
    localStorage.setItem(legacyReadyKey, '0');
    return writeState({
      status: 'prefetching',
      version: cfg.fullVersion,
      updatedAt: now(),
      reason: reason || 'prefetching',
    });
  }

  function markReady(reason) {
    localStorage.setItem(legacyReadyKey, '1');
    localStorage.setItem(legacyVersionKey, cfg.fullVersion);
    return writeState({
      status: 'ready',
      version: cfg.fullVersion,
      updatedAt: now(),
      reason: reason || 'ready',
    });
  }

  function markFailed(reason) {
    localStorage.setItem(legacyReadyKey, '0');
    return writeState({
      status: 'failed',
      version: cfg.fullVersion,
      updatedAt: now(),
      reason: reason || 'failed',
    });
  }

  function isStateReady(state) {
    if (!state || state.status !== 'ready') return false;
    if (state.version !== cfg.fullVersion) return false;
    if (!state.updatedAt || (now() - state.updatedAt > cfg.staleAfterMs)) return false;
    return true;
  }

  async function cleanupOldCaches() {
    const current = `cmp-full-prefetch:${fullBaseUrl}:${cfg.fullVersion}`;
    const keys = await caches.keys();
    const prefix = `cmp-full-prefetch:${fullBaseUrl}:`;
    await Promise.all(keys.map(async (key) => {
      if (key.startsWith(prefix) && key !== current) {
        await caches.delete(key);
      }
    }));
  }

  function makeOverlay() {
    let overlay = document.getElementById('build-switch-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'build-switch-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:#0d0f16',
      'color:#fff',
      'font:600 16px/1.4 Arial,sans-serif',
      'letter-spacing:.02em',
      'opacity:0',
      `transition:opacity ${cfg.overlayFadeMs}ms ease`,
      'pointer-events:none',
      'text-align:center',
      'padding:24px',
    ].join(';');

    const text = document.createElement('div');
    text.id = 'build-switch-overlay-text';
    text.textContent = cfg.loadingText;
    overlay.appendChild(text);

    document.body.appendChild(overlay);
    return overlay;
  }

  function setOverlayText(text) {
    const overlay = makeOverlay();
    const node = overlay.querySelector('#build-switch-overlay-text');
    if (node) {
      node.textContent = text;
    } else {
      overlay.textContent = text;
    }
  }

  function showOverlay(text) {
    if (text) setOverlayText(text);
    const overlay = makeOverlay();
    overlay.style.pointerEvents = 'auto';
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
    });
  }

  function preconnect(url) {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = new URL(url).origin;
    document.head.appendChild(link);
  }

  function parseBuildAssetsFallback(html, baseUrl) {
    const matches = new Set();
    const patterns = [
      /loaderUrl\s*=\s*buildUrl\s*\+\s*"([^"]+)"/g,
      /dataUrl\s*:\s*buildUrl\s*\+\s*"([^"]+)"/g,
      /frameworkUrl\s*:\s*buildUrl\s*\+\s*"([^"]+)"/g,
      /codeUrl\s*:\s*buildUrl\s*\+\s*"([^"]+)"/g,
      /symbolsUrl\s*:\s*buildUrl\s*\+\s*"([^"]+)"/g,
    ];

    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(html)) !== null) {
        matches.add(new URL(`Build${m[1]}`, baseUrl).toString());
      }
    }

    matches.add(new URL('TemplateData/style.css', baseUrl).toString());
    matches.add(new URL('good_loading.js', baseUrl).toString());
    return Array.from(matches);
  }

  async function fetchWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadManifest(html) {
    try {
      const resp = await fetchWithTimeout(manifestUrl, cfg.manifestTimeoutMs);
      if (!resp.ok) throw new Error(`status=${resp.status}`);
      const json = await resp.json();
      const files = Array.isArray(json && json.files) ? json.files : [];
      const critical = Array.isArray(json && json.critical) ? json.critical : [];
      if (!files.length) throw new Error('manifest has no files');

      const allUrls = files.map((path) => new URL(path, fullBaseUrl).toString());
      const criticalSet = new Set(critical.map((path) => new URL(path, fullBaseUrl).toString()));

      if (!criticalSet.size) {
        allUrls
          .filter((u) => /\.loader\.js$|\.framework\.js\.br$|\.data\.br$|\.wasm\.br$|\.symbols\.json\.br$/.test(u))
          .forEach((u) => criticalSet.add(u));
      }

      return {
        source: 'manifest',
        urls: Array.from(new Set([fullIndexUrl, ...allUrls])),
        criticalUrls: Array.from(criticalSet),
      };
    } catch (err) {
      console.warn('[SequentialLoader] Manifest unavailable, fallback parser will be used', err);
      const fallbackUrls = parseBuildAssetsFallback(html, fullBaseUrl);
      const criticalUrls = fallbackUrls.filter((u) => /\.loader\.js$|\.framework\.js\.br$|\.data\.br$|\.wasm\.br$|\.symbols\.json\.br$/.test(u));
      return {
        source: 'fallback',
        urls: Array.from(new Set([fullIndexUrl, ...fallbackUrls])),
        criticalUrls,
      };
    }
  }

  async function prefetchUrls(cache, urls, criticalSet) {
    const failedCritical = new Set();
    const queue = [...urls];
    const workers = Array.from({ length: Math.max(1, cfg.prefetchConcurrency) }, async () => {
      while (queue.length) {
        const nextUrl = queue.shift();
        if (!nextUrl) return;
        try {
          const response = await fetchWithTimeout(nextUrl, cfg.prefetchTimeoutMs);
          if (!response.ok) {
            if (criticalSet.has(nextUrl)) failedCritical.add(nextUrl);
            console.warn('[SequentialLoader] Prefetch status is not ok', nextUrl, response.status);
            continue;
          }
          await cache.put(nextUrl, response.clone());
        } catch (err) {
          if (criticalSet.has(nextUrl)) failedCritical.add(nextUrl);
          console.warn('[SequentialLoader] Prefetch failed', nextUrl, err);
        }
      }
    });

    await Promise.all(workers);
    return failedCritical;
  }

  async function validateCriticalInCache(cache, criticalUrls) {
    const missing = [];
    for (const url of criticalUrls) {
      const hit = await cache.match(url);
      if (!hit) missing.push(url);
    }
    return missing;
  }



  async function hasCriticalAssetsInCache() {
    const cacheName = `cmp-full-prefetch:${fullBaseUrl}:${cfg.fullVersion}`;
    const cache = await caches.open(cacheName);

    let criticalUrls = [];
    try {
      const cachedManifestResp = await cache.match(manifestUrl);
      if (cachedManifestResp) {
        const cachedManifest = await cachedManifestResp.json();
        const files = Array.isArray(cachedManifest && cachedManifest.files) ? cachedManifest.files : [];
        const critical = Array.isArray(cachedManifest && cachedManifest.critical) ? cachedManifest.critical : [];
        if (critical.length) {
          criticalUrls = critical.map((path) => new URL(path, fullBaseUrl).toString());
        } else {
          criticalUrls = files
            .map((path) => new URL(path, fullBaseUrl).toString())
            .filter((u) => /\.loader\.js$|\.framework\.js\.br$|\.data\.br$|\.wasm\.br$|\.symbols\.json\.br$/.test(u));
        }
      }
    } catch (err) {
      console.warn('[SequentialLoader] Cannot parse cached manifest for cache check', err);
    }

    if (!criticalUrls.length) {
      try {
        const resp = await fetchWithTimeout(manifestUrl, cfg.manifestTimeoutMs);
        if (resp.ok) {
          const manifest = await resp.json();
          const files = Array.isArray(manifest && manifest.files) ? manifest.files : [];
          const critical = Array.isArray(manifest && manifest.critical) ? manifest.critical : [];
          if (critical.length) {
            criticalUrls = critical.map((path) => new URL(path, fullBaseUrl).toString());
          } else {
            criticalUrls = files
              .map((path) => new URL(path, fullBaseUrl).toString())
              .filter((u) => /\.loader\.js$|\.framework\.js\.br$|\.data\.br$|\.wasm\.br$|\.symbols\.json\.br$/.test(u));
          }
          await cache.put(manifestUrl, new Response(JSON.stringify(manifest), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }));
        }
      } catch (err) {
        console.warn('[SequentialLoader] Cannot fetch manifest for cache check', err);
      }
    }

    if (!criticalUrls.length) {
      const cachedRequests = await cache.keys();
      criticalUrls = cachedRequests
        .map((req) => req.url)
        .filter((u) => /\.loader\.js$|\.framework\.js\.br$|\.data\.br$|\.wasm\.br$|\.symbols\.json\.br$/.test(u));
    }

    if (!criticalUrls.length) return false;

    const missing = await validateCriticalInCache(cache, criticalUrls);
    return missing.length === 0;
  }

  function scheduleRetry(reason) {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      console.log('[SequentialLoader] Retrying prefetch after failure', reason || 'unspecified');
      prefetchBuild('retry');
    }, cfg.retryDelayMs);
  }

  async function prefetchBuild(trigger) {
    if (prefetchPromise) return prefetchPromise;

    prefetchPromise = (async () => {
      const currentState = readState();
      if (isStateReady(currentState)) {
        console.log('[SequentialLoader] Full build already ready for current version');
        return true;
      }

      writeTelemetry({ prefetchStartAt: now(), prefetchTrigger: trigger || 'manual' });
      markPrefetching(trigger || 'manual');
      await cleanupOldCaches();
      preconnect(fullBaseUrl);

      const indexResp = await fetchWithTimeout(fullIndexUrl, cfg.prefetchTimeoutMs);
      if (!indexResp.ok) throw new Error(`Cannot fetch full index: ${indexResp.status}`);

      const html = await indexResp.text();
      const manifest = await loadManifest(html);
      const cacheName = `cmp-full-prefetch:${fullBaseUrl}:${cfg.fullVersion}`;
      const cache = await caches.open(cacheName);

      await cache.put(fullIndexUrl, new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }));
      if (manifest.source === 'manifest') {
        try {
          const manifestResp = await fetchWithTimeout(manifestUrl, cfg.manifestTimeoutMs);
          if (manifestResp.ok) {
            const manifestJson = await manifestResp.json();
            await cache.put(manifestUrl, new Response(JSON.stringify(manifestJson), {
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }));
          }
        } catch (err) {
          console.warn('[SequentialLoader] Failed to cache manifest response', err);
        }
      }

      const criticalSet = new Set(manifest.criticalUrls);
      const failedCritical = await prefetchUrls(cache, manifest.urls, criticalSet);
      const missing = await validateCriticalInCache(cache, manifest.criticalUrls);

      if (failedCritical.size || missing.length) {
        const failedList = [...failedCritical, ...missing];
        markFailed(`critical-missing:${failedList.length}`);
        writeTelemetry({ prefetchFailedAt: now(), prefetchFailReason: `critical-missing:${failedList.length}` });
        console.warn('[SequentialLoader] Prefetch incomplete, critical assets are missing', failedList);
        scheduleRetry('critical-missing');
        return false;
      }

      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      markReady(`source:${manifest.source}`);
      writeTelemetry({ prefetchReadyAt: now(), prefetchSource: manifest.source });
      console.log('[SequentialLoader] Full build prefetched and validated');
      return true;
    })().catch((err) => {
      console.warn('[SequentialLoader] Prefetch error', err);
      markFailed('exception');
      writeTelemetry({ prefetchFailedAt: now(), prefetchFailReason: 'exception' });
      scheduleRetry('exception');
      return false;
    }).finally(() => {
      prefetchPromise = null;
    });

    return prefetchPromise;
  }

  function goToFullBuild(useOverlay) {
    if (switching) return;
    switching = true;

    if (!useOverlay) {
      window.location.replace(fullBaseUrl);
      return;
    }

    showOverlay(cfg.loadingText);
    setTimeout(() => {
      window.location.replace(fullBaseUrl);
    }, cfg.overlayFadeMs);
  }

  window.GameOver = async function () {
    console.log('[SequentialLoader] GameOver hook called');
    writeTelemetry({ switchRequestedAt: now() });

    const stateReady = isStateReady(readState());
    if (stateReady) {
      const cacheReady = await hasCriticalAssetsInCache();
      if (cacheReady) {
        writeTelemetry({ switchInstantAt: now(), switchMode: 'instant' });
        goToFullBuild(false);
        return;
      }
      console.warn('[SequentialLoader] State says ready but cache validation failed; forcing blocking prefetch');
    }

    showOverlay(cfg.waitingText);
    const waitStart = now();
    await Promise.race([
      prefetchBuild('gameover'),
      new Promise((resolve) => setTimeout(resolve, cfg.gameOverWaitTimeoutMs)),
    ]);

    let finalReady = isStateReady(readState()) && await hasCriticalAssetsInCache();
    if (!finalReady) {
      await Promise.race([
        prefetchBuild('gameover-retry'),
        new Promise((resolve) => setTimeout(resolve, cfg.switchRetryTimeoutMs)),
      ]);
      finalReady = isStateReady(readState()) && await hasCriticalAssetsInCache();
    }

    writeTelemetry({
      switchBlockingAt: now(),
      switchMode: 'blocking',
      switchWaitMs: now() - waitStart,
      switchFinalReady: finalReady,
    });
    goToFullBuild(true);
  };

  window.GameLevelReached = function (level) {
    const levelNum = Number(level);
    if (Number.isNaN(levelNum)) return;
    if (levelNum >= 3 && !levelHookTriggered) {
      levelHookTriggered = true;
      console.log('[SequentialLoader] Starting prefetch from level hook', levelNum);
      queuePrefetch('level');
    }
  };

  migrateLegacyReadyState();

  const initialState = readState();
  if (!initialState || initialState.version !== cfg.fullVersion) {
    resetState('version-sync');
  }

  const network = navigator.connection || {};
  const slowNetwork = network.saveData || /(^|\b)(slow-2g|2g)\b/.test(network.effectiveType || '');
  const delay = slowNetwork ? cfg.prefetchDelayMs + 15000 : cfg.prefetchDelayMs;

  setTimeout(() => {
    console.log('[SequentialLoader] Starting prefetch from timer');
    queuePrefetch('timer');
  }, delay);

  window.addEventListener('online', () => {
    const state = readState();
    if (!isStateReady(state)) {
      console.log('[SequentialLoader] Network restored, queueing prefetch');
      queuePrefetch('online');
    }
  });

})();
