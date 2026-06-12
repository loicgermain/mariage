const CACHE = 'mariage-v19';
const ASSETS = ['/mariage/', '/mariage/index.html', '/mariage/app.js', '/mariage/data.js', '/mariage/firebase.js', '/mariage/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Network-first : on tente le réseau, on met à jour le cache au passage, et on
// retombe sur le cache hors ligne. Le cache runtime permet à SheetJS (export
// Excel) et au SDK Firebase de fonctionner même sans connexion après 1ʳᵉ visite.
// Pour les fichiers de l'app (même origine), on force `cache: 'reload'` afin de
// contourner le cache HTTP du navigateur (GitHub Pages envoie max-age=600) :
// sinon une nouvelle version peut mettre ~10 min à apparaître, même après refresh.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  e.respondWith(
    fetch(e.request, sameOrigin ? { cache: 'reload' } : undefined).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
