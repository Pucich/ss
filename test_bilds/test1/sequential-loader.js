(function () {
  'use strict';

  var DEFAULT_CONFIG = {
    liteBaseUrl: '/for_developers/2025.09.09_testLite_predprenimatel/',
    fullBaseUrl: '/for_developers/2025.12.25_new_api_serv/',
    fullVersion: '2025.12.25',
    manifestPath: 'build-manifest.json'
  };

  var PREFETCH_DELAY_MS = 10000;
  var SWITCH_OVERLAY_MS = 1200;
  var PREFETCH_CONCURRENCY = 2;
  var TARGET_SWITCH_LEVEL = 6;
  var READY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var CACHE_PREFIX = 'cmp-full-prefetch:';
  var FULL_READY_TIMEOUT_MS = 20000;
  var LEGACY_FULL_RUNTIME_CACHE = 'NGames-cblocks1-webgl_opt_online_high';

  var config = null;
  var prefetchPromise = null;
  var prefetchStarted = false;
  var highestReachedLevel = 0;
  var levelHookObserved = false;
  var timerId = null;

  function normalizeBaseUrl(url) {
    if (!url) return '/';
    return url.endsWith('/') ? url : (url + '/');
  }

  function resolveConfig(baseConfig) {
    var seqCfg = (window && window.SequentialLoaderConfig) || {};
    var merged = {
      liteBaseUrl: normalizeBaseUrl(baseConfig.liteBaseUrl || DEFAULT_CONFIG.liteBaseUrl),
      fullBaseUrl: normalizeBaseUrl(seqCfg.fullBaseUrl || baseConfig.fullBaseUrl || DEFAULT_CONFIG.fullBaseUrl),
      fullVersion: seqCfg.fullVersion || baseConfig.fullVersion || DEFAULT_CONFIG.fullVersion,
      manifestPath: seqCfg.manifestPath || baseConfig.manifestPath || DEFAULT_CONFIG.manifestPath,
      targetSwitchLevel: Number(seqCfg.targetSwitchLevel || baseConfig.targetSwitchLevel || TARGET_SWITCH_LEVEL),
      fullRuntimeCaches: Array.isArray(seqCfg.fullRuntimeCaches) ? seqCfg.fullRuntimeCaches.slice() : [LEGACY_FULL_RUNTIME_CACHE]
    };

    return merged;
  }

  function storageKey(cfg) {
    return 'cmp:prefetch:' + cfg.fullBaseUrl;
  }

  function readState(cfg) {
    try {
      var raw = localStorage.getItem(storageKey(cfg));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.log('[SequentialLoader] failed to read state', e);
      return null;
    }
  }

  function writeState(cfg, status, reason) {
    var next = {
      status: status,
      version: cfg.fullVersion,
      timestamp: Date.now(),
      reason: reason || ''
    };
    try {
      localStorage.setItem(storageKey(cfg), JSON.stringify(next));
    } catch (e) {
      console.log('[SequentialLoader] failed to write state', e);
    }
    return next;
  }

  function isReadyState(cfg) {
    var state = readState(cfg);
    if (!state || state.status !== 'ready') return false;
    if (state.version !== cfg.fullVersion) return false;
    if (!state.timestamp) return false;
    return (Date.now() - state.timestamp) <= READY_TTL_MS;
  }

  function cacheNameFor(cfg) {
    return CACHE_PREFIX + cfg.fullVersion + ':' + cfg.fullBaseUrl;
  }

  async function cleanupStaleCaches(cfg) {
    if (!window.caches || typeof window.caches.keys !== 'function') return;

    try {
      var keys = await caches.keys();
      var suffix = ':' + cfg.fullBaseUrl;
      await Promise.all(keys.map(function (key) {
        if (!key.startsWith(CACHE_PREFIX) || !key.endsWith(suffix)) return Promise.resolve();
        if (key === cacheNameFor(cfg)) return Promise.resolve();
        console.log('[SequentialLoader] deleting stale cache', key);
        return caches.delete(key);
      }));
    } catch (e) {
      console.log('[SequentialLoader] stale cache cleanup failed', e);
    }
  }

  async function preparePrefetchPolicy(cfg) {
    var state = readState(cfg);
    if (!state) return false;

    if (state.status === 'ready' && state.version === cfg.fullVersion && state.timestamp && (Date.now() - state.timestamp) <= READY_TTL_MS) {
      prefetchStarted = true;
      console.log('[SequentialLoader] prefetch skipped: ready state is fresh');
      return true;
    }

    if (state.version && state.version !== cfg.fullVersion) {
      console.log('[SequentialLoader] version changed, clearing stale caches');
      await cleanupStaleCaches(cfg);
      try {
        localStorage.removeItem(storageKey(cfg));
      } catch (e) {
        console.log('[SequentialLoader] failed to clear stale state', e);
      }
    }

    if (state.status === 'ready' && state.version === cfg.fullVersion) {
      console.log('[SequentialLoader] ready state expired by TTL, re-prefetch required');
    }

    return false;
  }

  function toAbsolute(url) {
    return new URL(url, window.location.origin).toString();
  }

  function fullIndexUrl(cfg) {
    return toAbsolute(cfg.fullBaseUrl + 'index.html');
  }

  function fullManifestUrl(cfg) {
    return toAbsolute(cfg.fullBaseUrl + cfg.manifestPath);
  }

  function fullFileUrl(cfg, relativePath) {
    return toAbsolute(cfg.fullBaseUrl + relativePath.replace(/^\/+/, ''));
  }

  async function buildTargetCaches(cfg) {
    var list = [];
    if (!window.caches || typeof window.caches.open !== 'function') return list;

    try {
      list.push(await caches.open(cacheNameFor(cfg)));
    } catch (e) {
      console.log('[SequentialLoader] failed to open sequential cache', e);
    }

    var runtimeNames = Array.isArray(cfg.fullRuntimeCaches) ? cfg.fullRuntimeCaches : [];
    for (var i = 0; i < runtimeNames.length; i += 1) {
      var runtimeName = runtimeNames[i];
      if (!runtimeName || typeof runtimeName !== 'string') continue;
      try {
        list.push(await caches.open(runtimeName));
      } catch (e) {
        console.log('[SequentialLoader] failed to open runtime cache ' + runtimeName, e);
      }
    }

    return list;
  }

  async function fetchAndStore(url, targetCaches) {
    var cachesList = Array.isArray(targetCaches) ? targetCaches : [];

    for (var i = 0; i < cachesList.length; i += 1) {
      var existing = await cachesList[i].match(url);
      if (existing) {
        return;
      }
    }

    var response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' for ' + url);
    }

    if (cachesList.length) {
      for (var j = 0; j < cachesList.length; j += 1) {
        await cachesList[j].put(url, response.clone());
      }
    } else {
      // Fallback path: consume body to ensure resource is downloaded.
      await response.arrayBuffer();
    }
  }

  async function runWithConcurrency(items, worker, concurrency) {
    var index = 0;

    async function runWorker() {
      while (index < items.length) {
        var current = items[index++];
        await worker(current);
      }
    }

    var workers = [];
    for (var i = 0; i < Math.min(concurrency, items.length); i += 1) {
      workers.push(runWorker());
    }
    await Promise.all(workers);
  }

  async function startPrefetch(trigger) {
    if (!config) return;
    if (prefetchPromise) return prefetchPromise;
    if (isReadyState(config)) {
      prefetchStarted = true;
      console.log('[SequentialLoader] prefetch skipped: already ready for current version');
      return;
    }

    prefetchStarted = true;
    console.log('[SequentialLoader] prefetch started, trigger =', trigger);

    prefetchPromise = (async function () {
      writeState(config, 'prefetching', trigger);

      var targetCaches = [];
      if (window.caches && typeof window.caches.open === 'function') {
        targetCaches = await buildTargetCaches(config);
      } else {
        console.log('[SequentialLoader] Cache API unavailable, fallback to fetch-only');
      }

      try {
        var indexUrl = fullIndexUrl(config);
        await fetchAndStore(indexUrl, targetCaches);

        var manifestUrl = fullManifestUrl(config);
        var manifestResponse = await fetch(manifestUrl, { credentials: 'same-origin' });
        if (!manifestResponse.ok) {
          throw new Error('HTTP ' + manifestResponse.status + ' for manifest');
        }

        var manifestData = await manifestResponse.json();
        if (targetCaches.length) {
          for (var c = 0; c < targetCaches.length; c += 1) {
            await targetCaches[c].put(manifestUrl, new Response(JSON.stringify(manifestData), {
              headers: { 'Content-Type': 'application/json' }
            }));
          }
        }

        var files = Array.isArray(manifestData.files) ? manifestData.files.slice() : [];
        await runWithConcurrency(files, function (relativePath) {
          return fetchAndStore(fullFileUrl(config, relativePath), targetCaches);
        }, PREFETCH_CONCURRENCY);

        writeState(config, 'ready', trigger);
        console.log('[SequentialLoader] prefetch ready');
      } catch (error) {
        writeState(config, 'failed', String(error && error.message ? error.message : error));
        console.log('[SequentialLoader] prefetch failed', error);
      }
    })();

    return prefetchPromise;
  }

  function showOverlay(text) {
    var overlay = document.getElementById('sequential-loader-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'sequential-loader-overlay';
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.background = '#0d0f16 url(/for_developers/2025.09.09_testLite_predprenimatel/loading_bg.jpg) center / cover no-repeat';
      overlay.style.color = '#fff';
      overlay.style.font = '600 18px/1.4 Arial, sans-serif';
      overlay.style.zIndex = '2147483647';
      overlay.style.textAlign = 'center';
      overlay.style.padding = '24px';
      document.body.appendChild(overlay);
    }
    overlay.textContent = text || 'Подготавливаем полную версию…';
    return overlay;
  }

  function hideOverlay() {
    var overlay = document.getElementById('sequential-loader-overlay');
    if (!overlay) return;
    overlay.style.opacity = '0';
    setTimeout(function () {
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }, 300);
  }

  function mountFullIframe(fullUrl) {
    var existing = document.getElementById('full-build-iframe');
    if (existing) {
      console.log('[SequentialLoader] full iframe already mounted');
      return;
    }

    showOverlay('Загружаем полную версию…');

    var iframe = document.createElement('iframe');
    iframe.id = 'full-build-iframe';
    iframe.src = fullUrl;
    iframe.style.position = 'fixed';
    iframe.style.left = '0';
    iframe.style.top = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.style.zIndex = '2147483646';
    iframe.style.opacity = '0';
    iframe.style.background = '#000';
    iframe.style.transition = 'opacity 250ms ease';
    iframe.allow = 'autoplay; fullscreen; gamepad; xr-spatial-tracking';

    iframe.onload = function () {
      var liteContainer = document.getElementById('unity-container');
      if (liteContainer) {
        liteContainer.style.visibility = 'hidden';
        liteContainer.style.pointerEvents = 'none';
      }
      var liteCanvas = document.getElementById('unity-canvas') || document.querySelector('canvas');
      if (liteCanvas) {
        liteCanvas.style.visibility = 'hidden';
      }

      requestAnimationFrame(function () {
        iframe.style.opacity = '1';
      });

      var settled = false;
      function finishOverlay(reason) {
        if (settled) return;
        settled = true;
        console.log('[SequentialLoader] full handoff overlay finished:', reason);
        hideOverlay();
        window.removeEventListener('message', onMessage);
      }

      function onMessage(event) {
        if (!event || event.source !== iframe.contentWindow) return;
        var data = event.data || {};
        if (data.type === 'CMP_FULL_READY') {
          finishOverlay('full-ready-message');
        }
        if (data.type === 'CMP_FULL_FAILED') {
          finishOverlay('full-failed-message');
        }
      }

      window.addEventListener('message', onMessage);
      setTimeout(function () {
        finishOverlay('timeout');
      }, FULL_READY_TIMEOUT_MS);
    };

    document.body.appendChild(iframe);
  }

  function switchToFull(reason) {
    if (!config) return;

    if (highestReachedLevel < config.targetSwitchLevel) {
      console.log('[SequentialLoader] handoff blocked: level gate not reached', highestReachedLevel, '<', config.targetSwitchLevel);
      return;
    }

    var target = fullIndexUrl(config);
    var ready = isReadyState(config);
    console.log('[SequentialLoader] gameover switch, reason =', reason, 'ready =', ready, 'mode=iframe');

    if (ready) {
      mountFullIframe(target);
      return;
    }

    showOverlay('Подготавливаем полную версию…');
    setTimeout(function () {
      mountFullIframe(target);
    }, SWITCH_OVERLAY_MS);
  }

  function extractLevelFromConsoleArgs(argsLike) {
    try {
      var text = Array.prototype.map.call(argsLike, function (item) {
        return typeof item === 'string' ? item : String(item);
      }).join(' ');

      // Unity logs often contain rich text tags like <color=...>...</color>.
      text = text.replace(/<[^>]*>/g, ' ');

      var m1 = text.match(/_userSystem\.Level\s*(\d+)/i);
      if (m1) return Number(m1[1]);

      var m2 = text.match(/Playing\s+cur\s+level\s*(\d+)/i);
      if (m2) return Number(m2[1]);

      var m3 = text.match(/Level\s*(\d+)\s*ended\s*with\s*win/i);
      if (m3) return Number(m3[1]);

      return null;
    } catch (e) {
      return null;
    }
  }

  function installConsoleLevelBridge() {
    if (window.__cmpConsoleLevelBridgeInstalled) return;
    window.__cmpConsoleLevelBridgeInstalled = true;

    var originalLog = console.log;
    console.log = function () {
      try {
        var parsedLevel = extractLevelFromConsoleArgs(arguments);
        if (parsedLevel && parsedLevel > 0 && typeof window.GameLevelReached === 'function') {
          window.GameLevelReached(parsedLevel);
        }
      } catch (e) {
        // no-op
      }
      return originalLog.apply(console, arguments);
    };

    console.log('[SequentialLoader] console level bridge installed');
  }

  function installLevelTrigger() {
    var previous = typeof window.GameLevelReached === 'function' ? window.GameLevelReached : null;

    window.GameLevelReached = function (level) {
      var normalized = Number(level);
      if (!Number.isFinite(normalized)) {
        normalized = 0;
      }

      levelHookObserved = true;
      if (normalized > highestReachedLevel) {
        highestReachedLevel = normalized;
      }

      console.log('[SequentialLoader] level reached', normalized, 'highest =', highestReachedLevel);

      if (normalized >= 2 && !prefetchStarted) {
        console.log('[SequentialLoader] level trigger prefetch (>=2)');
        startPrefetch('level>=2');
      }

      if (previous) {
        return previous.apply(this, arguments);
      }
    };
  }

  function installGameOverTrigger() {
    var original = typeof window.GameOver === 'function' ? window.GameOver : null;

    var wrapped = function () {
      if (original) {
        try {
          original.apply(this, arguments);
        } catch (e) {
          console.log('[SequentialLoader] original GameOver error', e);
        }
      }
      switchToFull('GameOver');
    };

    Object.defineProperty(window, 'GameOver', {
      configurable: true,
      enumerable: true,
      get: function () {
        return wrapped;
      },
      set: function (nextFn) {
        original = typeof nextFn === 'function' ? nextFn : null;
      }
    });

    window.GameOver = original;
  }

  function installTimerTrigger() {
    setTimeout(function () {
      if (!levelHookObserved) {
        console.log('[SequentialLoader] level hook not found');
      }
    }, 12000);

    console.log('[SequentialLoader] timer prefetch scheduled for 10s');
    timerId = setTimeout(function () {
      console.log('[SequentialLoader] timer trigger prefetch');
      startPrefetch('timer-10s');
    }, PREFETCH_DELAY_MS);
  }

  async function loadBuildConfig() {
    try {
      var response = await fetch('./build-config.json', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var json = await response.json();
      return resolveConfig(json || {});
    } catch (e) {
      console.log('[SequentialLoader] build-config.json unavailable, fallback to defaults', e);
      return resolveConfig({});
    }
  }

  async function init() {
    config = await loadBuildConfig();
    await preparePrefetchPolicy(config);
    installTimerTrigger();
    installLevelTrigger();
    installConsoleLevelBridge();
    installGameOverTrigger();
  }

  init();
})();
