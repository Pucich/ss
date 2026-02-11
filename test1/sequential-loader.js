(function () {
  const DEFAULTS = {
    fullBuildUrl: (window.CMP_BUILD_CONFIG && window.CMP_BUILD_CONFIG.fullUrl) || '/prod_bilds/2025.12.25_new_api_serv/',
    prefetchDelayMs: 25000,
    prefetchTimeoutMs: 45000,
    prefetchConcurrency: 2,
    overlayFadeMs: 220,
    loadingText: 'Загружаем полную версию…',
  };

  const cfg = Object.assign({}, DEFAULTS, window.SequentialLoaderConfig || {});
  const fullBaseUrl = new URL(cfg.fullBuildUrl, window.location.origin).toString();
  const fullIndexUrl = new URL('index.html', fullBaseUrl).toString();
  const versionKey = `cmp_full_version:${fullBaseUrl}`;
  const readyKey = `cmp_full_ready:${fullBaseUrl}`;

  let prefetchPromise = null;
  let switching = false;

  function markNotReady() {
    localStorage.setItem(readyKey, '0');
  }

  function markReady(version) {
    localStorage.setItem(readyKey, '1');
    if (version) {
      localStorage.setItem(versionKey, version);
    }
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
    ].join(';');
    overlay.textContent = cfg.loadingText;
    document.body.appendChild(overlay);
    return overlay;
  }

  function showOverlay() {
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

  function parseBuildAssets(html, baseUrl) {
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

  async function prefetchBuild() {
    if (prefetchPromise) return prefetchPromise;

    prefetchPromise = (async () => {
      markNotReady();
      preconnect(fullBaseUrl);

      const indexResp = await fetchWithTimeout(fullIndexUrl, cfg.prefetchTimeoutMs);
      if (!indexResp.ok) throw new Error(`Cannot fetch full index: ${indexResp.status}`);

      const html = await indexResp.text();
      const version = `len:${html.length}`;
      const urls = parseBuildAssets(html, fullBaseUrl);
      const cache = await caches.open(`cmp-full-prefetch:${fullBaseUrl}`);

      await cache.put(fullIndexUrl, new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }));

      const queue = [...urls];
      const workers = Array.from({ length: Math.max(1, cfg.prefetchConcurrency) }, async () => {
        while (queue.length) {
          const nextUrl = queue.shift();
          if (!nextUrl) return;
          try {
            const response = await fetchWithTimeout(nextUrl, cfg.prefetchTimeoutMs);
            if (response.ok) {
              await cache.put(nextUrl, response.clone());
            }
          } catch (err) {
            console.warn('[SequentialLoader] Prefetch failed', nextUrl, err);
          }
        }
      });

      await Promise.all(workers);
      markReady(version);
      console.log('[SequentialLoader] Full build prefetched');
      return true;
    })().catch((err) => {
      console.warn('[SequentialLoader] Prefetch error', err);
      markNotReady();
      return false;
    });

    return prefetchPromise;
  }

  function goToFullBuild() {
    if (switching) return;
    switching = true;
    showOverlay();
    setTimeout(() => {
      window.location.replace(fullBaseUrl);
    }, cfg.overlayFadeMs);
  }

  window.GameOver = async function () {
    console.log('[SequentialLoader] GameOver hook called');
    const ready = localStorage.getItem(readyKey) === '1';
    if (ready) {
      goToFullBuild();
      return;
    }

    showOverlay();
    await prefetchBuild();
    goToFullBuild();
  };

  const network = navigator.connection || {};
  const slowNetwork = network.saveData || /(^|\b)(slow-2g|2g)\b/.test(network.effectiveType || '');
  const delay = slowNetwork ? cfg.prefetchDelayMs + 15000 : cfg.prefetchDelayMs;

  setTimeout(() => {
    prefetchBuild();
  }, delay);
})();
