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
import { firebaseApp } from './firebaseInit.js?v=2026091102';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  writeBatch,
  onSnapshot,
} from './vendor/firebase/firebase-firestore.js';

// Cache local persistant (IndexedDB) : les écritures faites hors-ligne sont
// mises en file d'attente automatiquement par le SDK et envoyées dès que la
// connexion revient (usage terrain : état des lieux rédigé sans réseau).
// Gestionnaire MULTI-ONGLETS : avec le gestionnaire mono-onglet, dès qu'un
// deuxième onglet de l'app était ouvert, il perdait la persistance
// ("Failed to obtain exclusive access to the persistence layer") et repassait
// en cache mémoire — synchronisation dégradée sans que rien ne le signale à
// l'écran.
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager({}) }),
});

// Champs simples, regroupés dans l'unique document "meta" (toujours petits).
const META_KEYS = ['schemaVersion', 'sci', 'bailModele', 'syncMeta', 'reglagesAnnonce'];
// Tableaux de fiches, éclatés en un document Firestore par fiche.
const RECORD_KEYS = [
  'biens', 'locataires', 'documents', 'charges', 'baux', 'etatsDesLieux',
  'documentsAdmin', 'documentsLocataires', 'credits', 'bailRedactions',
  'facturesTravaux', 'bienGabarits', 'edlRedactions', 'edlModeles',
  'annonceRedactions', 'candidatures', 'visites',
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
// uid actuellement écouté — permet à start() d'ignorer un ré-abonnement pour
// le MÊME compte (deux évènements d'authentification consécutifs) au lieu de
// tout réinitialiser via stop(), ce qui jetterait une sauvegarde en attente.
let currentUid = null;
// Dernier état serveur connu : docId -> signature. Sert de base au diff.
let shadow = new Map();
// Vrai une fois qu'un instantané confirmé par le serveur a été reçu. Tant que
// c'est faux, on n'émet AUCUNE suppression (on ne sait pas ce que contient
// réellement le cloud, supprimer serait le seul geste irréversible).
let shadowFromServer = false;
// Sauvegarde demandée avant d'avoir vu le serveur (ou avant d'avoir pu
// fusionner le dernier instantané) : rejouée dès que possible.
let pendingSave = null;
// Fonctions resolve/reject des promesses rendues par QfSync.save() pendant
// que la sauvegarde est en file d'attente — réglées quand flushPending()
// aboutit (ou échoue), jamais avant : sans ça, l'appelant (app.js) croit la
// synchro terminée alors que rien n'a encore été écrit.
let pendingSettlers = [];
// Ids dont l'app a une connaissance SÛRE et À JOUR (fusionnés dans `data` par
// onRemoteChange, ou écrits par cet appareil lui-même) — PAR DOCUMENT, pas un
// simple drapeau global : un instantané écarté (saisie en cours) ne doit
// bloquer la suppression QUE des documents qu'il a apportés, pas de TOUS les
// documents déjà connus par ailleurs, sous peine de laisser une vraie
// suppression locale sans effet (et de ressusciter la fiche au tour suivant).
let idsConnusDeLApp = new Set();
// Vrai dès qu'un état a été transmis à l'app au moins une fois.
let hasEmitted = false;
// Callback optionnel (voir QfSync.setErrorHandler) prévenu d'un échec de
// LECTURE (onSnapshot) — un échec d'écriture est déjà signalé au niveau de
// chaque save() via son rejet de promesse.
let onErrorHandler = null;

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

async function save(uid, data, opts) {
  const allowDeletes = !opts || opts.allowDeletes !== false;
  // additiveOnly : n'écrit QUE les documents que le serveur ne connaît pas
  // encore. Utilisé par flushPending() pour son tout premier rejeu, dont le
  // seul rôle légitime est de publier ce qui a été créé pendant l'attente de
  // confirmation — jamais d'écraser un document déjà côté serveur (meta ou
  // fiche) avec une version locale potentiellement pas encore fusionnée.
  const additiveOnly = !!(opts && opts.additiveOnly);
  const desired = buildDesired(data);

  // Garde-fou explicite : mieux vaut une erreur nommée qu'un échec opaque.
  // La limite Firestore est en OCTETS UTF-8, pas en caractères UTF-16 : un
  // texte accentué (bail, EDL) pèse jusqu'à 2 octets par caractère, donc
  // .length seul laissait passer des fiches réellement trop grosses.
  // Les fiches fautives sont ÉCARTÉES (pas juste signalées) : sinon UNE SEULE
  // fiche trop grosse bloquait la synchronisation de TOUTES les autres, sans
  // que rien ne le signale à l'écran tant que le save() ne finit pas par
  // échouer une bonne fois — l'utilisateur croyait ses données répliquées.
  // `ecartees` (pas seulement retirées de `desired`) : une fiche déjà publiée
  // en petite taille puis devenue trop grosse ne doit PAS être prise pour une
  // suppression simplement parce qu'elle a disparu de `desired` — elle doit
  // rester intacte côté serveur, juste non mise à jour cette fois-ci.
  const troVolumineuses = [];
  const ecartees = new Set();
  desired.forEach((value, id) => {
    const octets = value.j ? new TextEncoder().encode(value.j).length : 0;
    if (octets > MAX_RECORD_BYTES) {
      troVolumineuses.push(`${value.c} (${Math.round(octets / 1024)} Ko, limite 1 Mo)`);
      ecartees.add(id);
      desired.delete(id);
    }
  });

  // Écritures : uniquement ce qui a changé par rapport au dernier état connu.
  // "meta" (nom de SCI, SIRET, modèle de bail, signature) est un DOCUMENT
  // UNIQUE réécrit en bloc à chaque appel — contrairement aux fiches, il n'a
  // pas de clé stable qui protège l'ancien contenu. Tant que le serveur n'a
  // pas encore répondu (appareil neuf, réseau lent, cache local vidé par une
  // réinstallation du raccourci...), la version locale peut être vide/par
  // défaut : l'écrire écraserait le vrai "meta" du cloud. On attend donc la
  // première confirmation serveur avant d'y toucher — QfSync.save rejoue déjà
  // la sauvegarde complète via pendingSave/flushPending une fois ce moment
  // venu, meta y compris, avec la vraie donnée locale par alors chargée.
  const writes = [];
  desired.forEach((value, id) => {
    if (id === META_ID && !shadowFromServer) return;
    if (additiveOnly && shadow.has(id)) return; // jamais écraser un doc déjà connu du serveur
    if (shadow.get(id) !== sigOf(value)) writes.push({ type: 'set', id, value });
  });

  // Suppressions : uniquement si l'on connaît vraiment l'état du serveur ET
  // que l'appelant les autorise ET que ce document PRÉCIS est réellement
  // connu de l'app (idsConnusDeLApp) — pas un simple drapeau global : un
  // instantané écarté (saisie en cours) ne doit bloquer la suppression QUE
  // des documents qu'IL apportait, pas de tout ce qui est par ailleurs connu.
  // Les fiches écartées pour taille (`ecartees`) ne sont jamais prises pour
  // des suppressions non plus : elles restent intactes côté serveur, juste
  // pas mises à jour cette fois-ci.
  const deletes = [];
  if (shadowFromServer && allowDeletes) {
    shadow.forEach((_sig, id) => {
      if (desired.has(id) || ecartees.has(id)) return;
      if (!idsConnusDeLApp.has(id)) return;
      deletes.push({ type: 'delete', id });
    });
  }

  if (writes.length > 0 || deletes.length > 0) {
    // Écritures d'abord, suppressions ensuite : à aucun instant une fiche
    // n'est absente du cloud alors qu'elle devrait y être.
    await commitOps(uid, writes.concat(deletes));

    if (additiveOnly) {
      // Rejeu partiel : ne pas reconstruire le shadow à partir de `desired`
      // seul, ça effacerait la trace des documents distants absents du local
      // (pas encore fusionnés). On se contente d'y ajouter ce qui vient
      // d'être écrit ; le prochain instantané serveur remet de toute façon le
      // shadow à jour dans son intégralité. Ce qui vient d'être écrit est
      // maintenant connu avec certitude, même si le reste ne l'est pas.
      writes.forEach((w) => { shadow.set(w.id, sigOf(w.value)); idsConnusDeLApp.add(w.id); });
    } else {
      shadow = new Map();
      desired.forEach((value, id) => shadow.set(id, sigOf(value)));
    }
  }
  // Mise à jour de idsConnusDeLApp INDÉPENDANTE du fait qu'un commit ait eu
  // lieu : un save() complet (non additif) qui ne change rien reflète quand
  // même la connaissance actuelle et complète de l'app sur `desired`.
  if (!additiveOnly) idsConnusDeLApp = new Set(desired.keys());

  if (troVolumineuses.length) {
    // Levée APRÈS le commit des fiches valides : elles sont bien parties,
    // seules les fautives ne le sont pas — l'appelant (onErrorHandler, la
    // pastille d'échec) doit néanmoins être prévenu.
    throw new Error(
      'Fiche(s) trop volumineuse(s), NON synchronisée(s) (le reste a bien été envoyé) : '
      + troVolumineuses.join(', ')
    );
  }
}

// Sérialise les appels à save() : sans ça, deux save() lancés à quelques
// millisecondes d'écart (l'utilisateur enchaîne deux actions) construisent
// chacun leur `desired`/diff sur la base du MÊME shadow de départ ; si le
// plus ancien commite APRÈS le plus récent, son diff (calculé sur des
// données déjà dépassées) écrase le shadow local avec un état antérieur — la
// modification la plus récente semble alors publiée (shadow la connaît) mais
// ne l'est en réalité pas, et disparaît silencieusement au prochain
// instantané confirmé.
let writeChain = Promise.resolve();
function queued(uid, data, opts) {
  const run = () => save(uid, data, opts);
  const p = writeChain.then(run, run);
  writeChain = p.catch(() => {}); // une erreur ne doit jamais bloquer la suite de la file
  return p;
}

// Rejoue une sauvegarde qui avait été demandée avant de connaître l'état
// serveur. allowDeletes:false + additiveOnly:true : ce rejeu ne doit jamais
// supprimer ni écraser quoi que ce soit côté serveur — voir les commentaires
// sur `deletes` et `additiveOnly` dans save(). Une exception dans
// onRemoteChange (rendu, etc.) ne doit pas empêcher ce rejeu d'avoir lieu.
function flushPending(uid) {
  if (!pendingSave) return;
  const data = pendingSave;
  const settlers = pendingSettlers;
  pendingSave = null;
  pendingSettlers = [];
  queued(uid, data, { allowDeletes: false, additiveOnly: true })
    .then(() => { settlers.forEach((s) => s.resolve()); })
    .catch((e) => {
      console.error('Échec de la synchronisation différée', e);
      // Le compte a changé entre-temps (stop() + start() d'un AUTRE uid,
      // pendant que ce rejeu était en vol) : ne PAS remettre ces données en
      // file pour le nouveau compte — ce serait écrire les données de
      // l'ancien utilisateur chez le nouveau à la prochaine confirmation.
      if (uid !== currentUid) { settlers.forEach((s) => s.reject(e)); return; }
      // Remise en file (sauf si une sauvegarde plus récente l'a déjà
      // remplacée entre-temps) : sans ça, cette donnée était perdue en
      // silence — jamais réessayée, jamais publiée.
      if (!pendingSave) pendingSave = data;
      if (onErrorHandler) onErrorHandler(e);
      settlers.forEach((s) => s.reject(e));
    });
}

// onRemoteChange(remoteData, infos) est appelé avec les données distantes à
// chaque changement confirmé par le serveur (ou null si le compte n'a encore
// aucune donnée synchronisée), et un objet `infos` avec :
//   infos.jamaisPublie(cat, rec) -> vrai si cette fiche locale (catégorie
//     `cat`, ex: "biens") n'a jamais existé côté serveur, ni avant ni dans cet
//     instantané : c'est une création locale pas encore publiée (pas une
//     suppression distante), à conserver lors de la fusion avec le distant.
// onRemoteChange doit renvoyer explicitement `false` s'il n'a PAS appliqué
// l'instantané (saisie en cours, écho de notre propre écriture...) : les
// documents apportés par CET instantané restent alors hors de
// idsConnusDeLApp, donc protégés d'une suppression tant qu'ils n'auront pas
// été réellement fusionnés (voir idsConnusDeLApp et son usage dans save()).
function start(uid, onRemoteChange) {
  // Deux évènements d'authentification consécutifs pour le MÊME compte (Firebase
  // peut réémettre onAuthStateChanged) ne doivent PAS repartir de zéro : stop()
  // jetterait une sauvegarde en attente et remettrait shadowFromServer à faux,
  // pour rien — l'écoute déjà active reste parfaitement valide pour ce uid.
  if (unsubscribe && currentUid === uid) return;
  stop();
  currentUid = uid;
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

      // Capturé AVANT d'écraser `shadow` : sert à distinguer une fiche locale
      // "jamais publiée" (absente à la fois de l'ancien ET du nouveau shadow)
      // d'une fiche "supprimée par un autre appareil" (présente avant,
      // absente maintenant) — seule la première doit survivre à la fusion.
      const shadowAvant = shadow;

      shadow = newShadow;
      shadowFromServer = true;
      // onRemoteChange D'ABORD, flushPending ENSUITE : une sauvegarde en
      // attente (pendingSave) référence le MÊME objet `data` que l'appelant
      // (app.js) — elle n'est pas une copie figée. La rejouer avant que
      // onRemoteChange ait fusionné l'instantané distant dans `data` publie
      // encore la version locale (potentiellement vide après réinstallation),
      // exactement le bug que ce garde-fou est censé éviter.
      if (unchanged) { flushPending(uid); return; }

      hasEmitted = true;
      try {
        const infos = {
          jamaisPublie(cat, rec) {
            const id = recordDocId(cat, recordKey(rec));
            return !shadowAvant.has(id) && !newShadow.has(id);
          },
        };
        // onRemoteChange peut renvoyer `false` pour dire "je n'ai pas
        // appliqué cet instantané" (saisie en cours, écho) : dans ce cas,
        // `shadow` a bien été mis à jour ci-dessus (nécessaire pour les
        // futurs diffs), mais `data` local n'a PAS été réconcilié — on
        // n'ajoute donc PAS les ids de CET instantané à idsConnusDeLApp
        // (ceux déjà connus par ailleurs — écritures propres à cet appareil —
        // le restent, seuls les nouveaux venus d'un autre appareil restent
        // protégés d'une suppression tant qu'ils n'ont pas été fusionnés).
        if (onRemoteChange(rebuild(docsById), infos) !== false) {
          idsConnusDeLApp = new Set(newShadow.keys());
        }
      } catch (e) {
        // Une exception ici (ex: erreur de rendu côté app.js) ne doit pas
        // empêcher flushPending : sinon une sauvegarde en attente resterait
        // bloquée indéfiniment, et remonterait le risque d'écrasement que
        // le rejeu additif est justement censé éliminer.
        console.error('Erreur pendant l\'application des données distantes', e);
      }
      flushPending(uid);
    },
    (err) => {
      console.error('Erreur de synchronisation Firestore', err);
      // Erreur de LECTURE (règles refusées, quota, réseau) : l'app doit
      // pouvoir la signaler à l'écran, pas seulement en console — même
      // besoin que pour un échec d'écriture (voir onErrorHandler ci-dessous).
      if (onErrorHandler) onErrorHandler(err);
    }
  );
}

function stop() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  currentUid = null;
  shadow = new Map();
  shadowFromServer = false;
  pendingSave = null;
  // Rejetées (pas simplement abandonnées) : sans ça, une sauvegarde faite
  // hors ligne puis jamais rejouée (déconnexion avant tout instantané) reste
  // une promesse qui ne se règle jamais — .catch() côté app.js (pastille
  // d'échec) ne se déclenche donc jamais non plus, et la perte est invisible.
  pendingSettlers.forEach((s) => s.reject(new Error('Synchronisation interrompue (déconnexion)')));
  pendingSettlers = [];
  idsConnusDeLApp = new Set();
  hasEmitted = false;
}

window.QfSync = {
  save(uid, data) {
    if (!shadowFromServer) {
      // On ne connaît pas encore l'état du cloud : on N'ÉCRIT RIEN tout de
      // suite. `shadow` étant encore vide à cet instant, une écriture
      // immédiate ne se compare à rien et part inconditionnellement — y
      // compris pour une fiche dont l'id coïncide avec une fiche RÉELLE déjà
      // sur le serveur (ex: appareil au cache local vidé par une
      // réinstallation, mais rechargé avec une sauvegarde périmée), ce qui
      // l'écrase avant même de savoir qu'elle existait. On met donc en
      // attente et on laisse flushPending() rejouer — de façon strictement
      // additive (voir save()/additiveOnly) — dès que le serveur aura
      // répondu et que shadow reflète enfin son vrai contenu. La promesse
      // rendue ne se règle qu'à ce moment-là (voir pendingSettlers) : la
      // résoudre tout de suite ferait croire à l'appelant que c'est déjà fait.
      pendingSave = data;
      return new Promise((resolve, reject) => { pendingSettlers.push({ resolve, reject }); });
    }
    return queued(uid, data);
  },
  start,
  stop,
  // Catégories de fiches synchronisées (mêmes clés que RECORD_KEYS) —
  // utilisé par app.js pour parcourir les mêmes tableaux que ce module lors
  // de la fusion d'un instantané distant (voir infos.jamaisPublie).
  recordCategories: RECORD_KEYS.slice(),
  // Signalé sur un échec de LECTURE (onSnapshot) — quota, règles refusées,
  // réseau. app.js l'utilise pour afficher la même pastille que pour un
  // échec d'écriture, sinon le symptôme resterait invisible à l'écran.
  setErrorHandler(fn) { onErrorHandler = fn; },
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
      documentsConnusDeLApp: idsConnusDeLApp.size,
    };
  },
  // Exposé pour les tests automatisés (voir tests/syncLogic.test.js).
  _internals: { buildDesired, rebuild, sigOf, recordKey, safeKey },
};
