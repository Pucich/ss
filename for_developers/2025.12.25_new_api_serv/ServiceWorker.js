const STATIC_CACHE_NAME = "NGames-cblocks1-webgl_opt_online_high";
const FULL_VERSION = "2025.12.25_new_api_serv";
const FULL_BASE_PATH = "/for_developers/2025.12.25_new_api_serv/";
const PREFETCH_CACHE_NAME = `cmp-full-prefetch:${self.location.origin}${FULL_BASE_PATH}:${FULL_VERSION}`;

const contentToCache = [
  "Build/2025.12.25_new_api_serv.loader.js",
  "Build/2025.12.25_new_api_serv.framework.js.br",
  "Build/2025.12.25_new_api_serv.data.br",
  "Build/2025.12.25_new_api_serv.wasm.br",
  "TemplateData/style.css"
];

const CRITICAL_PATTERN = /\/Build\/.*\.(loader\.js|framework\.js\.br|data\.br|wasm\.br|symbols\.json\.br)$/;

self.addEventListener('install', function (e) {
  console.log('[Service Worker] Install');

  e.waitUntil((async function () {
    const cache = await caches.open(STATIC_CACHE_NAME);
    console.log('[Service Worker] Caching all: app shell and content');
    await cache.addAll(contentToCache);
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    const stalePrefix = `cmp-full-prefetch:${self.location.origin}${FULL_BASE_PATH}:`;
    await Promise.all(keys.map(async (key) => {
      if (key.startsWith(stalePrefix) && key !== PREFETCH_CACHE_NAME) {
        await caches.delete(key);
      }
    }));
    await self.clients.claim();
  })());
});

async function fetchWithCacheFallback(request) {
  const staticCache = await caches.open(STATIC_CACHE_NAME);
  const prefetchCache = await caches.open(PREFETCH_CACHE_NAME);

  const fromPrefetch = await prefetchCache.match(request);
  if (fromPrefetch) {
    return fromPrefetch;
  }

  const fromStatic = await staticCache.match(request);
  if (fromStatic) {
    return fromStatic;
  }

  const response = await fetch(request);
  if (response && response.ok) {
    if (CRITICAL_PATTERN.test(new URL(request.url).pathname)) {
      await prefetchCache.put(request, response.clone());
    } else {
      await staticCache.put(request, response.clone());
    }
  }
  return response;
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(e.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;
  const isFullScope = requestUrl.pathname.startsWith(FULL_BASE_PATH);

  if (!isSameOrigin || !isFullScope) {
    return;
  }

  e.respondWith(fetchWithCacheFallback(e.request));
});
