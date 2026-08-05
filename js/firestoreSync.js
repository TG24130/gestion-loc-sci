// Synchronisation des données métier avec Firestore. Un document Firestore
// est limité à 1 Mo : avec des données réelles accumulées (signatures
// intégrées dans les baux rédigés, historique de documents...), un seul
// document pour tout `data` dépasse cette limite, et même `documents` seul
// (historique des quittances/reçus/etc., non borné) peut la dépasser à lui
// seul. On découpe donc en plusieurs documents par catégorie, et
// `documents` est en plus réparti en lots dont la taille RÉELLE en octets
// est bornée (ni un découpage par année, ni un simple découpage par nombre
// d'entrées ne suffisent : l'activité peut être concentrée sur une seule
// année, et une entrée peut peser beaucoup plus qu'une autre selon son
// contenu) pour rester loin de la limite quelle que soit la donnée.
// Expose window.QfSync pour que js/app.js (script classique) puisse s'y
// brancher.
import { firebaseApp } from './firebaseInit.js?v=2026072140';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  collection,
  doc,
  writeBatch,
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

// Le document "meta" regroupe les champs toujours petits. Chaque autre clé
// de js/storage.js (defaultData), sauf "documents", a son propre document,
// nommé comme la clé, contenant { [clé]: valeur }. "documents" est réparti
// dans des documents "documents_0", "documents_1", ... par lots dont la
// taille en octets est bornée (voir chunksOf).
const META_KEYS = ['schemaVersion', 'sci', 'bailModele', 'syncMeta'];
const ARRAY_KEYS = [
  'biens', 'locataires', 'charges', 'baux', 'etatsDesLieux',
  'documentsAdmin', 'documentsLocataires', 'credits', 'bailRedactions',
  'facturesTravaux', 'bienGabarits', 'edlRedactions', 'edlModeles',
];
const DOC_BUCKET_PREFIX = 'documents_';
// Découpage par taille réelle (pas par nombre d'entrées, ni par date) : la
// taille d'une entrée peut varier fortement (le champ `ctx` embarque le
// contexte complet du document généré), donc seul un budget en octets
// garantit de rester sous la limite Firestore de 1 Mo, quelle que soit la
// répartition. Marge large sous 1 048 576 (encodage Firestore + wrapper).
const MAX_CHUNK_BYTES = 500000;

function chunksOf(items) {
  const arr = items || [];
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  arr.forEach((item) => {
    const itemBytes = JSON.stringify(item).length;
    if (current.length > 0 && currentBytes + itemBytes > MAX_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

let unsubscribe = null;
// Identifiants de lots "documents" connus (vus côté serveur, ou écrits par
// ce client) : permet de vider proprement un lot devenu vide/obsolète au
// lieu de laisser une donnée périmée trainer dans un document plus réécrit.
let knownDocumentBucketIds = [];

function dataCollectionFor(uid) {
  return collection(db, 'users', uid, 'data');
}

async function save(uid, data) {
  const meta = {};
  META_KEYS.forEach((k) => { meta[k] = data[k]; });

  const batch = writeBatch(db);
  batch.set(doc(dataCollectionFor(uid), 'meta'), meta);
  ARRAY_KEYS.forEach((k) => {
    batch.set(doc(dataCollectionFor(uid), k), { [k]: data[k] || [] });
  });

  const chunks = chunksOf(data.documents);
  const currentIds = chunks.map((_, i) => DOC_BUCKET_PREFIX + i);
  const allIds = Array.from(new Set([...knownDocumentBucketIds, ...currentIds]));
  allIds.forEach((id) => {
    const idx = currentIds.indexOf(id);
    batch.set(doc(dataCollectionFor(uid), id), { documents: idx >= 0 ? chunks[idx] : [] });
  });

  await batch.commit();
  knownDocumentBucketIds = currentIds;
}

// Reconstruit l'objet `data` à plat à partir des documents individuels
// { meta: {...}, biens: {biens:[...]}, ..., documents_0: {documents:[...]}, ... }
function reconstruct(docsById) {
  const out = {};
  if (docsById.meta) Object.assign(out, docsById.meta);
  ARRAY_KEYS.forEach((k) => {
    if (docsById[k] && k in docsById[k]) out[k] = docsById[k][k];
  });
  out.documents = [];
  Object.keys(docsById)
    .filter((id) => id.indexOf(DOC_BUCKET_PREFIX) === 0)
    .forEach((id) => {
      out.documents = out.documents.concat(docsById[id].documents || []);
    });
  return out;
}

// onRemoteChange(remoteData) est appelé avec les données distantes à chaque
// changement confirmé par le serveur, ou avec null si aucun document
// n'existe encore pour ce compte (premier démarrage).
function start(uid, onRemoteChange) {
  stop();
  unsubscribe = onSnapshot(
    dataCollectionFor(uid),
    (snap) => {
      // On n'agit JAMAIS sur un instantané optimiste/local : ni sur le cache
      // local (potentiellement périmé, ex: juste après une suppression
      // manuelle côté serveur pas encore reflétée partout), ni sur nos
      // propres écritures encore en attente de confirmation (hasPendingWrites
      // — un batch de plusieurs documents peut n'être que partiellement
      // reflété dans un instantané intermédiaire, ce qui donnerait une
      // reconstruction incohérente si on l'appliquait). On attend une
      // confirmation serveur complète avant de toucher aux données locales.
      if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
      const docsById = {};
      snap.forEach((d) => { docsById[d.id] = d.data(); });
      knownDocumentBucketIds = Object.keys(docsById)
        .filter((id) => id.indexOf(DOC_BUCKET_PREFIX) === 0);
      // On se base sur la présence du document "meta" (toujours écrit en
      // premier par save()), pas sur "la collection a au moins un document" :
      // un résidu d'un ancien schéma (ex: un vieux document "main") ne doit
      // pas faire croire que le compte a déjà de vraies données synchronisées.
      if (!docsById.meta) {
        onRemoteChange(null);
        return;
      }
      onRemoteChange(reconstruct(docsById));
    },
    (err) => {
      console.error('Erreur de synchronisation Firestore', err);
    }
  );
}

function stop() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  knownDocumentBucketIds = [];
}

window.QfSync = { save, start, stop };
