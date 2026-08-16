// Service worker : réseau en priorité (toujours la version la plus récente en ligne),
// avec repli sur le cache pour un accès hors-ligne (ex: pas de réseau sur le téléphone).
// IMPORTANT : incrementer ce nom a chaque deploiement notable. L'evenement
// 'activate' supprime tous les caches dont le nom differe, ce qui force les
// appareils a repartir du reseau. Sans cela, un telephone pouvait continuer a
// servir une version ancienne indefiniment (constate sur iPhone : le tableau
// de bord affichait encore 'Derniers documents' apres plusieurs deploiements).
const CACHE_NAME = 'gls-cache-2026081609';
const CORE_ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
