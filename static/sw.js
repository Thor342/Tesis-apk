const CACHE = 'neuropsico-v1';
const ORIGIN = self.location.origin;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      cache.addAll(['/', '/manifest.json', '/favicon.png'])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // No interceptar peticiones cross-origin (ej. Supabase API)
  if (!e.request.url.startsWith(ORIGIN)) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(cached =>
          cached || new Response('Sin conexión', { status: 503, statusText: 'Service Unavailable' })
        )
      )
  );
});
