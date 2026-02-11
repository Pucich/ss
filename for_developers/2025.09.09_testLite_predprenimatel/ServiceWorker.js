const cacheName = "NGames-cblocks1-build_cut_SergeyZ";
const contentToCache = [
    "Build/ColorMatchPuzzle.loader.js",
    "Build/ColorMatchPuzzle.framework.js.br",
    "Build/ColorMatchPuzzle.symbols.json.br",
    "Build/ColorMatchPuzzle.data.br",
    "Build/ColorMatchPuzzle.wasm.br",
    "TemplateData/style.css"

];

self.addEventListener('install', function (e) {
    console.log('[Service Worker] Install');
    
    e.waitUntil((async function () {
      const cache = await caches.open(cacheName);
      console.log('[Service Worker] Caching all: app shell and content');
      await cache.addAll(contentToCache);
    })());
});

self.addEventListener('fetch', function (e) {
    if (e.request.method !== 'GET') {
        return;
    }
    e.respondWith((async function () {
      let response = await caches.match(e.request);
      console.log(`[Service Worker] Fetching resource: ${e.request.url}`);
      if (response) { return response; }

      response = await fetch(e.request);
      const cache = await caches.open(cacheName);
      console.log(`[Service Worker] Caching new resource: ${e.request.url}`);
      cache.put(e.request, response.clone());
      return response;
    })());
});
