// Synchronisation des données métier avec Firestore (un seul document par
// compte, qui reprend exactement la structure de js/storage.js). Expose
// window.QfSync pour que js/app.js (script classique) puisse s'y brancher.
import { firebaseApp } from './firebaseInit.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  doc,
  setDoc,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// Cache local persistant (IndexedDB) : les écritures faites hors-ligne sont
// mises en file d'attente automatiquement par le SDK et envoyées dès que la
// connexion revient (usage terrain visé par ce projet — ex: état des lieux
// rédigé dans un logement mal couvert). Un seul onglet à la fois gère ce
// cache (l'app n'est normalement ouverte que sur un appareil à la fois).
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }),
});

let unsubscribe = null;
// JSON de la dernière écriture faite par CE client, pour ignorer l'écho de
// ses propres écritures dans onSnapshot (évite un rafraîchissement inutile
// de l'UI juste après avoir soi-même enregistré).
let lastWrittenJSON = null;

function docRefFor(uid) {
  return doc(db, 'users', uid, 'data', 'main');
}

async function save(uid, data) {
  const json = JSON.stringify(data);
  lastWrittenJSON = json;
  await setDoc(docRefFor(uid), data);
}

// onRemoteChange(remoteData) est appelé avec les données distantes à chaque
// changement réel (hors écho de nos propres écritures), ou avec null si
// aucun document n'existe encore pour ce compte (premier démarrage).
function start(uid, onRemoteChange) {
  stop();
  unsubscribe = onSnapshot(
    docRefFor(uid),
    (snap) => {
      if (!snap.exists()) {
        onRemoteChange(null);
        return;
      }
      const remoteData = snap.data();
      const json = JSON.stringify(remoteData);
      if (json === lastWrittenJSON) return;
      onRemoteChange(remoteData);
    },
    (err) => {
      console.error('Erreur de synchronisation Firestore', err);
    }
  );
}

function stop() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  lastWrittenJSON = null;
}

window.QfSync = { save, start, stop };
