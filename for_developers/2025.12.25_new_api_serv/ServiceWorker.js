const cacheName = "NGames-cblocks1-webgl_opt_online_high";
const prefetchCachePrefix = "cmp-full-prefetch:";
const contentToCache = [
  "Build/2025.12.25_new_api_serv.loader.js",
  "Build/2025.12.25_new_api_serv.framework.js.br",
  "Build/2025.12.25_new_api_serv.data.br",
  "Build/2025.12.25_new_api_serv.wasm.br",
  "TemplateData/style.css"
];

self.addEventListener('install', function (e) {
  console.log('[Service Worker] Install');

  e.waitUntil((async function () {
    const cache = await caches.open(cacheName);
    console.log('[Service Worker] Caching all: app shell and content');
    await cache.addAll(contentToCache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

async function matchPrefetchCache(request) {
  const keys = await caches.keys();
  for (const key of keys) {
    if (!key.startsWith(prefetchCachePrefix)) continue;
    const cache = await caches.open(key);
    const hit = await cache.match(request.url) || await cache.match(request);
    if (hit) {
      console.log(`[Service Worker] Prefetch cache hit: ${request.url} from ${key}`);
      return hit;
    }
  }
  return null;
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') {
    return;
  }

  e.respondWith((async function () {
    let response = await caches.match(e.request);
    if (response) {
      return response;
    }

    response = await matchPrefetchCache(e.request);
    if (response) {
      const runtimeCache = await caches.open(cacheName);
      runtimeCache.put(e.request, response.clone());
      return response;
    }

    response = await fetch(e.request);
    const cache = await caches.open(cacheName);
    cache.put(e.request, response.clone());
    return response;
  })());
});
