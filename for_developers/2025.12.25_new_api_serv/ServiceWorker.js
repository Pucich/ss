const cacheName = "NGames-cblocks1-webgl_opt_online_high:2025.12.25";
const legacyRuntimeCaches = [
  "NGames-cblocks1-webgl_opt_online_high"
];
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

async function matchInRuntimeCaches(requestOrUrl) {
  const runtimeCache = await caches.open(cacheName);
  const currentHit = await matchByRequestOrUrl(runtimeCache, requestOrUrl);
  if (currentHit) {
    return currentHit;
  }

  for (const legacyName of legacyRuntimeCaches) {
    const legacyCache = await caches.open(legacyName);
    const legacyHit = await matchByRequestOrUrl(legacyCache, requestOrUrl);
    if (legacyHit) {
      return legacyHit;
    }
  }

  return null;
}

async function pruneCacheByScope(cacheHandle, scopePrefix) {
  const requests = await cacheHandle.keys();
  await Promise.all(requests.map(async (req) => {
    if (!req || !req.url || req.url.startsWith(scopePrefix)) return;
    await cacheHandle.delete(req);
  }));
}

self.addEventListener('install', function (e) {
  console.log('[Service Worker] Install');

  e.waitUntil((async function () {
    const runtimeCache = await caches.open(cacheName);
    console.log('[Service Worker] Caching all: app shell and content');

    await runtimeCache.addAll(shellContentToCache);

    for (const relativePath of heavyBuildAssets) {
      const absoluteUrl = toAbsolute(relativePath);

      const runtimeHit = await matchInRuntimeCaches(absoluteUrl);
      if (runtimeHit) {
        console.log('[Service Worker] install-hit-runtime', absoluteUrl);
        await runtimeCache.put(absoluteUrl, runtimeHit.clone());
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
  e.waitUntil((async function () {
    const scopePrefix = self.registration.scope;
    const currentRuntime = await caches.open(cacheName);
    await pruneCacheByScope(currentRuntime, scopePrefix);

    for (const legacyName of legacyRuntimeCaches) {
      const legacyCache = await caches.open(legacyName);
      await pruneCacheByScope(legacyCache, scopePrefix);
    }

    await self.clients.claim();
  })());
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

  const requestUrl = new URL(e.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  e.respondWith((async function () {
    const runtimeCache = await caches.open(cacheName);
    let response = await matchByRequestOrUrl(runtimeCache, e.request);
    if (!response) {
      for (const legacyName of legacyRuntimeCaches) {
        const legacyCache = await caches.open(legacyName);
        response = await matchByRequestOrUrl(legacyCache, e.request);
        if (response) {
          await runtimeCache.put(e.request.url, response.clone());
          break;
        }
      }
    }

    if (response) {
      return response;
    }

    response = await matchPrefetchCache(e.request);
    if (response) {
      runtimeCache.put(e.request, response.clone());
      return response;
    }

    response = await fetch(e.request);
    const cache = await caches.open(cacheName);
    cache.put(e.request.url, response.clone());
    return response;
  })());
});
