// Service worker : réseau en priorité (toujours la version la plus récente en ligne),
// avec repli sur le cache pour un accès hors-ligne (ex: pas de réseau sur le téléphone).
// IMPORTANT : incrementer APP_VERSION a chaque deploiement notable, en meme
// temps que le suffixe ?v= dans index.html et dans les 3 imports de
// firebaseInit.js?v=... (js/firebaseAuth.js, js/firestoreSync.js,
// js/firebaseStorageSync.js). L'evenement 'activate' supprime tous les caches
// dont le nom differe, ce qui force les appareils a repartir du reseau. Sans
// cela, un telephone pouvait continuer a servir une version ancienne
// indefiniment (constate sur iPhone : le tableau de bord affichait encore
// 'Derniers documents' apres plusieurs deploiements).
const APP_VERSION = '2026091102';
const CACHE_NAME = 'gls-cache-' + APP_VERSION;
const V = '?v=' + APP_VERSION;

// Liste explicite (et non au fil de l'eau) : sans ca, il existe une fenetre
// juste apres une mise a jour ou l'app n'est pas utilisable hors ligne, et
// une erreur de precache passait totalement inapercue (voir 'install').
const CORE_ASSETS = [
  // './index.html' et './manifest.json' SANS suffixe : ce sont les URL
  // réellement demandées au lancement de la PWA depuis l'icône (start_url du
  // manifest, et la requête de la plateforme pour le manifest lui-même n'a
  // pas de query) — la version avec ?v= ne correspond qu'aux liens internes
  // de la page, jamais à ces deux requêtes-là.
  './', './index.html', './index.html' + V, './manifest.json', './manifest.json' + V,
  './css/style.css' + V,
  './js/app.js' + V, './js/firebaseInit.js' + V,
  './js/firebaseAuth.js' + V, './js/firestoreSync.js' + V, './js/firebaseStorageSync.js' + V,
  './js/numberToWords.js' + V, './js/storage.js' + V, './js/filesDb.js' + V,
  './js/documents.js' + V, './js/pdfBuilder.js' + V, './js/richTextPdf.js' + V,
  './js/edlPdf.js' + V, './js/annonce.js' + V, './js/candidature.js' + V,
  './js/vendor/jspdf.umd.min.js', './js/vendor/jszip.min.js',
  './js/vendor/firebase/firebase-app.js',
  './js/vendor/firebase/firebase-auth.js',
  './js/vendor/firebase/firebase-firestore.js',
  './js/vendor/firebase/firebase-storage.js',
  './icons/favicon-32.png', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-512-maskable.png', './icons/apple-touch-icon.png',
];

// Délai maximal accordé au réseau avant de servir le cache, UNIQUEMENT si une
// version en cache existe déjà. Sans lui, sur un réseau faible mais pas
// franchement coupé (4G à 1 barre), fetch() n'échoue qu'après le très long
// timeout du navigateur : le repli cache n'arrive jamais à temps, et l'app
// reste bloquée à l'écran de connexion — exactement le symptôme qui a motivé
// ce service worker. La requête réseau elle-même n'est jamais annulée : elle
// continue en tâche de fond et rafraîchit le cache si elle finit par aboutir.
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
      .catch((e) => {
        // Ne pas avaler l'échec en silence : un precache raté doit rester
        // visible (console du navigateur) plutôt que de faire croire à une
        // garantie hors-ligne qui n'existe pas.
        console.error('[sw] échec du précache — hors-ligne non garanti tant que ces fichiers ne sont pas visités au moins une fois', e);
      })
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

  // netPromise doit être créée ICI, de façon synchrone dans le handler (donc
  // AVANT tout `await`), pour pouvoir la passer à waitUntil : appeler
  // waitUntil après un await lève InvalidStateError. Sans waitUntil, le
  // navigateur peut arrêter le service worker dès que respondWith() est
  // résolu (via le repli cache) — sur un réseau lent, le fetch en tâche de
  // fond et le cache.put qui doit rafraîchir le cache n'aboutissent jamais.
  const netPromise = fetch(event.request).then((response) => {
    // Ne mettre en cache qu'une vraie réponse réussie : une 404/5xx
    // transitoire (déploiement en cours côté GitHub Pages) sinon prise en
    // cache à la place du bon fichier, et reservie hors ligne jusqu'au
    // prochain changement d'APP_VERSION.
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
    }
    return response;
  });
  event.waitUntil(netPromise.catch(() => {}));

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (!cached) {
      // Rien en cache pour cette ressource : seul le réseau peut répondre,
      // quelle que soit sa lenteur — pas de timeout ici, sinon une première
      // visite sur un réseau lent échouerait plus vite qu'avant ce correctif.
      return netPromise;
    }

    // Une version en cache existe : on la sert si le réseau met trop de temps
    // à répondre (ou échoue), sans jamais abandonner la requête réseau
    // elle-même. Une 404/5xx transitoire ne doit pas non plus gagner la
    // course face à une version en cache par ailleurs valide.
    const netOuCache = netPromise.then((r) => (r.ok ? r : cached)).catch(() => cached);
    const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
    return Promise.race([netOuCache, timeout]);
  })());
});
