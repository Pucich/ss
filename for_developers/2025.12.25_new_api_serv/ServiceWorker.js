const cacheName = "NGames-cblocks1-webgl_opt_online_high";
const prefetchCachePrefix = "cmp-full-prefetch:";
const shellContentToCache = [
  "Build/2025.12.25_new_api_serv.loader.js",
  "TemplateData/style.css"
];
const heavyBuildAssets = [
  "Build/2025.12.25_new_api_serv.framework.js.br",
  "Build/2025.12.25_new_api_serv.data.br",
  "Build/2025.12.25_new_api_serv.wasm.br"
];

function toAbsolute(path) {
  return new URL(path, self.registration.scope).toString();
}

async function matchByRequestOrUrl(cache, requestOrUrl) {
  const request = typeof requestOrUrl === 'string' ? new Request(requestOrUrl) : requestOrUrl;
  return (await cache.match(request)) || (await cache.match(request.url));
}

self.addEventListener('install', function (e) {
  console.log('[Service Worker] Install');

  e.waitUntil((async function () {
    const runtimeCache = await caches.open(cacheName);
    console.log('[Service Worker] Caching all: app shell and content');

    await runtimeCache.addAll(shellContentToCache);

    for (const relativePath of heavyBuildAssets) {
      const absoluteUrl = toAbsolute(relativePath);

      const runtimeHit = await matchByRequestOrUrl(runtimeCache, absoluteUrl);
      if (runtimeHit) {
        console.log('[Service Worker] install-hit-runtime', absoluteUrl);
        continue;
      }

      const prefetchHit = await matchPrefetchCache(absoluteUrl) || await matchPrefetchByFilename(relativePath);
      if (prefetchHit) {
        console.log('[Service Worker] install-hit-prefetch', absoluteUrl);
        await runtimeCache.put(absoluteUrl, prefetchHit.clone());
        continue;
      }

      console.log('[Service Worker] install-deferred-miss', absoluteUrl);
    }

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});


async function matchPrefetchByFilename(relativePath) {
  const fileName = String(relativePath).split('/').pop();
  if (!fileName) return null;

  const keys = await caches.keys();
  for (const key of keys) {
    if (!key.startsWith(prefetchCachePrefix)) continue;
    const cache = await caches.open(key);
    const requests = await cache.keys();
    for (const req of requests) {
      if (!req || !req.url || !req.url.endsWith('/' + fileName)) continue;
      const hit = await cache.match(req);
      if (hit) {
        console.log(`[Service Worker] Prefetch filename hit: ${fileName} from ${key}`);
        return hit;
      }
    }
  }
  return null;
}

async function matchPrefetchCache(requestOrUrl) {
  const request = typeof requestOrUrl === 'string' ? new Request(requestOrUrl) : requestOrUrl;
  const keys = await caches.keys();
  for (const key of keys) {
    if (!key.startsWith(prefetchCachePrefix)) continue;
    const cache = await caches.open(key);
    const hit = await matchByRequestOrUrl(cache, request);
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
    let response = (await caches.match(e.request)) || (await caches.match(e.request.url));
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
    cache.put(e.request.url, response.clone());
    return response;
  })());
});
