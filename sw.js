const CACHE = 'welkomeo-v53';
// config.js exclu du pré-cache — contenu dynamique (KV)
const FILES = ['./index.html', './manifest.json', './admin.html', './gestion.html', './reset.html', './paiement.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
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
  // Ne pas intercepter les requêtes vers d'autres domaines (Google Maps, fonts, etc.)
  if (!e.request.url.startsWith(self.location.origin)) return;

  // config.js → réseau en priorité (contenu dynamique depuis KV)
  if (e.request.url.includes('/config.js')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(r => {
      if (r) return r;
      return fetch(e.request).catch(() => {
        // Fallback vers index.html uniquement pour les navigations, pas pour les JS/CSS
        if (e.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
