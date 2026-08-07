// Synchronisation des données métier avec Firestore.
//
// Modèle : UNE FICHE = UN DOCUMENT FIRESTORE.
//   users/{uid}/data/meta              -> champs simples (sci, bailModele...)
//   users/{uid}/data/rec-<cat>-<clé>   -> une fiche (un bien, une quittance...)
//
// Ce découpage remplace l'ancien modèle "un gros document par catégorie", qui
// posait deux problèmes graves constatés en production :
//   1. la limite Firestore de 1 Mo par document était dépassée dès que
//      l'historique réel grossissait (échec silencieux de toute la synchro) ;
//   2. chaque appareil réécrivait la totalité d'une catégorie à partir de sa
//      copie locale, donc un appareil qui n'avait pas encore reçu la fiche
//      créée sur l'autre appareil l'effaçait du cloud.
//
// Ici, un appareil n'écrit QUE les fiches qu'il a réellement modifiées (diff
// avec le dernier état serveur connu) : il ne peut plus effacer ce qu'il n'a
// pas touché, et aucune fiche seule n'approche la limite de 1 Mo.
//
// Expose window.QfSync pour que js/app.js (script classique) puisse s'y brancher.
import { firebaseApp } from './firebaseInit.js?v=2026080611';
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
// connexion revient (usage terrain : état des lieux rédigé sans réseau).
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }),
});

// Champs simples, regroupés dans l'unique document "meta" (toujours petits).
const META_KEYS = ['schemaVersion', 'sci', 'bailModele', 'syncMeta'];
// Tableaux de fiches, éclatés en un document Firestore par fiche.
const RECORD_KEYS = [
  'biens', 'locataires', 'documents', 'charges', 'baux', 'etatsDesLieux',
  'documentsAdmin', 'documentsLocataires', 'credits', 'bailRedactions',
  'facturesTravaux', 'bienGabarits', 'edlRedactions', 'edlModeles',
];

const META_ID = 'meta';
const REC_PREFIX = 'rec-';
// Firestore limite un lot à 500 opérations : marge de sécurité.
const MAX_BATCH_OPS = 400;
// Garde-fou : une fiche seule ne doit jamais approcher la limite de 1 Mo.
const MAX_RECORD_BYTES = 900000;

// ---------- Clés de documents ----------

function hash36(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Un identifiant de document Firestore ne peut pas contenir "/" ni être "."
// ou "..". Les ids générés par l'app (Storage.uid) sont alphanumériques, mais
// des données importées pourraient contenir autre chose : on nettoie, et on
// suffixe par une empreinte de l'original si le nettoyage a changé quelque
// chose, pour ne pas faire collisionner deux fiches distinctes.
function safeKey(raw) {
  const s = String(raw);
  const clean = s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return clean === s ? s : clean + '~' + hash36(s);
}

// Les fiches de l'app portent toutes un id (Storage.uid). Pour une éventuelle
// fiche sans id (donnée ancienne ou importée), on retombe sur une empreinte du
// contenu : stable tant que la fiche ne change pas, donc toujours sans écrasement.
function recordKey(rec) {
  if (rec && typeof rec.id === 'string' && rec.id !== '') return safeKey(rec.id);
  return 'h' + hash36(JSON.stringify(rec));
}

function recordDocId(cat, key) {
  return REC_PREFIX + cat + '-' + key;
}

// ---------- Représentation d'un document ----------
// Chaque document Firestore a la même forme : { c: catégorie, i: rang, j: JSON }.
// Stocker la fiche en JSON (plutôt qu'en champs Firestore natifs) évite tous les
// pièges de conversion (valeurs undefined, tableaux imbriqués des états des
// lieux...) et rend la comparaison "a changé / n'a pas changé" triviale.

function sigOf(docData) {
  if (!docData) return '';
  return (docData.c || '') + '|' + (docData.i == null ? '' : docData.i) + '|' + (docData.j || '');
}

// Construit l'état complet voulu (docId -> { c, i, j }) à partir de `data`.
function buildDesired(data) {
  const desired = new Map();

  const meta = {};
  META_KEYS.forEach((k) => { meta[k] = data[k]; });
  desired.set(META_ID, { c: '_meta', i: 0, j: JSON.stringify(meta) });

  RECORD_KEYS.forEach((cat) => {
    const list = Array.isArray(data[cat]) ? data[cat] : [];
    const seen = new Set();
    list.forEach((rec, index) => {
      let key = recordKey(rec);
      // Deux fiches ne peuvent pas partager la même clé : on désambiguïse.
      while (seen.has(key)) key = key + '_' + index;
      seen.add(key);
      desired.set(recordDocId(cat, key), { c: cat, i: index, j: JSON.stringify(rec) });
    });
  });

  return desired;
}

// Reconstruit l'objet `data` à partir des documents Firestore.
// Renvoie null si le document "meta" est absent : le compte n'a pas encore de
// données synchronisées (un résidu d'un ancien schéma ne doit pas faire croire
// le contraire).
function rebuild(docsById) {
  const metaDoc = docsById.get(META_ID);
  if (!metaDoc || !metaDoc.j) return null;

  let out;
  try {
    out = JSON.parse(metaDoc.j);
  } catch (e) {
    console.error('Document meta illisible', e);
    return null;
  }

  const byCat = {};
  RECORD_KEYS.forEach((cat) => { byCat[cat] = []; });

  docsById.forEach((docData, id) => {
    if (id === META_ID || id.indexOf(REC_PREFIX) !== 0) return; // ignore les résidus d'anciens schémas
    if (!docData || !byCat[docData.c]) return;
    try {
      byCat[docData.c].push({ i: Number(docData.i) || 0, rec: JSON.parse(docData.j) });
    } catch (e) {
      console.error('Fiche illisible ignorée', id, e);
    }
  });

  RECORD_KEYS.forEach((cat) => {
    byCat[cat].sort((a, b) => a.i - b.i);
    out[cat] = byCat[cat].map((x) => x.rec);
  });

  return out;
}

// ---------- État de synchronisation ----------

let unsubscribe = null;
// Dernier état serveur connu : docId -> signature. Sert de base au diff.
let shadow = new Map();
// Vrai une fois qu'un instantané confirmé par le serveur a été reçu. Tant que
// c'est faux, on n'émet AUCUNE suppression (on ne sait pas ce que contient
// réellement le cloud, supprimer serait le seul geste irréversible).
let shadowFromServer = false;
// Sauvegarde demandée avant d'avoir vu le serveur : rejouée dès que possible.
let pendingSave = null;
// Vrai dès qu'un état a été transmis à l'app au moins une fois.
let hasEmitted = false;

// Deux états serveur sont-ils identiques ? (comparaison de signatures, sans
// re-sérialiser toutes les données — l'app peut peser plusieurs Mo.)
function sameShadow(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, sig] of a) {
    if (b.get(id) !== sig) return false;
  }
  return true;
}

function dataCollectionFor(uid) {
  return collection(db, 'users', uid, 'data');
}

async function commitOps(uid, ops) {
  const col = dataCollectionFor(uid);
  for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
    const batch = writeBatch(db);
    ops.slice(i, i + MAX_BATCH_OPS).forEach((op) => {
      if (op.type === 'set') batch.set(doc(col, op.id), op.value);
      else batch.delete(doc(col, op.id));
    });
    await batch.commit();
  }
}

async function save(uid, data) {
  const desired = buildDesired(data);

  // Garde-fou explicite : mieux vaut une erreur nommée qu'un échec opaque.
  desired.forEach((value, id) => {
    if (value.j && value.j.length > MAX_RECORD_BYTES) {
      throw new Error(
        `Fiche trop volumineuse pour être synchronisée (${value.c}, ${Math.round(value.j.length / 1024)} Ko, limite 1 Mo) — document ${id}`
      );
    }
  });

  // Écritures : uniquement ce qui a changé par rapport au dernier état connu.
  const writes = [];
  desired.forEach((value, id) => {
    if (shadow.get(id) !== sigOf(value)) writes.push({ type: 'set', id, value });
  });

  // Suppressions : uniquement si l'on connaît vraiment l'état du serveur.
  // Ce sont les fiches réellement supprimées sur cet appareil, et les résidus
  // des anciens schémas (documents "main", "biens", "documents_0"...).
  const deletes = [];
  if (shadowFromServer) {
    shadow.forEach((_sig, id) => {
      if (!desired.has(id)) deletes.push({ type: 'delete', id });
    });
  }

  if (writes.length === 0 && deletes.length === 0) return;

  // Écritures d'abord, suppressions ensuite : à aucun instant une fiche n'est
  // absente du cloud alors qu'elle devrait y être.
  await commitOps(uid, writes.concat(deletes));

  shadow = new Map();
  desired.forEach((value, id) => shadow.set(id, sigOf(value)));
}

// Rejoue une sauvegarde qui avait été demandée avant de connaître l'état serveur.
function flushPending(uid) {
  if (!pendingSave) return;
  const data = pendingSave;
  pendingSave = null;
  save(uid, data).catch((e) => console.error('Échec de la synchronisation différée', e));
}

// onRemoteChange(remoteData) est appelé avec les données distantes à chaque
// changement confirmé par le serveur, ou avec null si le compte n'a encore
// aucune donnée synchronisée.
function start(uid, onRemoteChange) {
  stop();
  unsubscribe = onSnapshot(
    dataCollectionFor(uid),
    // includeMetadataChanges est INDISPENSABLE ici : par défaut, Firestore ne
    // délivre un nouvel instantané que si des DOCUMENTS ont changé. Quand le
    // cache local contient déjà exactement ce que le serveur renvoie, la seule
    // différence est la métadonnée fromCache (true -> false) : sans cette
    // option, la confirmation serveur n'est jamais délivrée, et comme on
    // ignore les instantanés issus du cache, la synchronisation reste bloquée
    // indéfiniment — écoute active, mais plus rien ne se passe.
    { includeMetadataChanges: true },
    (snap) => {
      // On n'établit l'état de référence que sur une confirmation du serveur :
      // un instantané servi depuis le cache local peut être périmé, et s'en
      // servir comme base de diff ferait supprimer des fiches à tort.
      if (snap.metadata.fromCache) return;

      const docsById = new Map();
      snap.forEach((d) => { docsById.set(d.id, d.data()); });

      const newShadow = new Map();
      docsById.forEach((docData, id) => newShadow.set(id, sigOf(docData)));

      // Le serveur ne fait que confirmer ce que cet appareil connaît déjà :
      // inutile de reconstruire et de réappliquer les données (c'est ce qui
      // faisait brièvement clignoter l'écran après un enregistrement).
      const unchanged = hasEmitted && shadowFromServer && sameShadow(newShadow, shadow);

      shadow = newShadow;
      shadowFromServer = true;
      flushPending(uid);
      if (unchanged) return;

      hasEmitted = true;
      onRemoteChange(rebuild(docsById));
    },
    (err) => {
      console.error('Erreur de synchronisation Firestore', err);
    }
  );
}

function stop() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  shadow = new Map();
  shadowFromServer = false;
  pendingSave = null;
  hasEmitted = false;
}

window.QfSync = {
  save(uid, data) {
    if (!shadowFromServer) {
      // On ne connaît pas encore l'état du cloud : on écrit quand même (ajouts
      // et mises à jour ne peuvent rien détruire), et on rejouera la
      // sauvegarde complète — suppressions comprises — dès que le serveur aura
      // répondu.
      pendingSave = data;
    }
    return save(uid, data);
  },
  start,
  stop,
  // État interne, consultable depuis la console du navigateur pour
  // diagnostiquer une synchronisation qui ne démarre pas :
  //   QfSync._state()
  // serveurRepondu=false signifie qu'aucun instantané confirmé par le serveur
  // n'est jamais arrivé (connexion bloquée/hors-ligne), donc rien n'est publié.
  _state() {
    return {
      ecouteActive: !!unsubscribe,
      serveurRepondu: shadowFromServer,
      documentsCotéServeur: shadow.size,
      donneesTransmisesALApp: hasEmitted,
      sauvegardeEnAttente: !!pendingSave,
    };
  },
  // Exposé pour les tests automatisés (voir tests/syncLogic.test.js).
  _internals: { buildDesired, rebuild, sigOf, recordKey, safeKey },
};
