// Persistance locale des données de l'application.
//
// Les données vivent dans IndexedDB, et non plus dans localStorage : ce
// dernier est plafonné à ~5 Mo (compté en UTF-16, donc atteint dès ~2,5 M de
// caractères), ce qui bloquait l'enregistrement sur iPhone dès que
// l'historique réel grossissait. IndexedDB se compte en dizaines de Mo, voire
// davantage.
//
// La migration depuis localStorage est automatique et se fait une seule fois.
// L'ancienne entrée localStorage est CONSERVÉE telle quelle comme filet de
// sécurité (elle n'est plus jamais réécrite, donc elle ne grossit plus).
const Storage = (function () {
  const LEGACY_KEY = 'qf_data_v1';
  const DB_NAME = 'qf_app_db';
  const STORE = 'state';
  const STATE_KEY = 'data';

  let dbPromise = null;

  function defaultData() {
    return {
      schemaVersion: 1,
      sci: { nom: '', adresse: '', ville: '', email: '', tel: '', siret: '', signature: '', capitalSocial: '', gerant: '' },
      biens: [],
      locataires: [],
      documents: [],
      charges: [],
      baux: [],
      etatsDesLieux: [],
      documentsAdmin: [],
      documentsLocataires: [],
      credits: [],
      bailModele: '',
      bailRedactions: [],
      facturesTravaux: [],
      bienGabarits: [],
      edlRedactions: [],
      edlModeles: [],
      annonceRedactions: [],
      // Réglages du générateur d'annonce. Clé de premier niveau plutôt que
      // champs ajoutés à `sci` : la fusion de load() est superficielle, donc
      // un `sci` déjà enregistré remplacerait l'objet par défaut en bloc et
      // les nouveaux champs resteraient indéfinis sur les données existantes.
      reglagesAnnonce: { critereContrat: '', ratioRevenus: 3, modalitesVisite: '', canalContact: '' },
      // Horodatage de la dernière sauvegarde, pour repérer une modification
      // faite depuis un autre appareil (stratégie "dernière écriture gagne").
      syncMeta: { updatedAt: '', updatedBy: '' },
    };
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function readRaw() {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(STATE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    }));
  }

  function writeRaw(json) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(json, STATE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  // Chargement ASYNCHRONE : appeler `await Storage.load()`.
  async function load() {
    try {
      const json = await readRaw();
      if (json) return Object.assign(defaultData(), JSON.parse(json));

      // Rien dans IndexedDB : première ouverture depuis la migration.
      // On reprend ce qui existait dans localStorage, sans y toucher.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const parsed = Object.assign(defaultData(), JSON.parse(legacy));
        await writeRaw(JSON.stringify(parsed));
        console.info('Données reprises depuis localStorage vers IndexedDB (migration unique).');
        return parsed;
      }
      return defaultData();
    } catch (e) {
      console.error('Erreur de lecture des données locales', e);
      // Dernier recours : ne jamais démarrer sur des données vides si une
      // copie localStorage existe encore.
      try {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy) return Object.assign(defaultData(), JSON.parse(legacy));
      } catch (e2) { /* ignoré : on retombe sur des données vides */ }
      return defaultData();
    }
  }

  // Les écritures sont sérialisées : une transaction à la fois, dans l'ordre
  // d'appel. save() reste SYNCHRONE du point de vue de l'appelant (il y en a
  // une quarantaine dans app.js) et renvoie true ; un échec réel est signalé
  // via onSaveError, car il ne peut être connu qu'après coup.
  let writeChain = Promise.resolve();
  let onSaveError = null;
  let pendingWrites = 0;

  function save(data) {
    let json;
    try {
      // Capture immédiate : `data` continue d'être modifié par l'application.
      json = JSON.stringify(data);
    } catch (e) {
      console.error('Données non sérialisables', e);
      return false;
    }
    pendingWrites++;
    writeChain = writeChain
      .then(() => writeRaw(json))
      .catch((e) => {
        console.error('Échec de la sauvegarde locale', e);
        if (onSaveError) onSaveError(e);
      })
      .then(() => { pendingWrites--; });
    return true;
  }

  // Permet à app.js d'attendre que toutes les écritures soient terminées
  // (utilisé avant de quitter la page).
  function flush() { return writeChain; }

  // Vrai si une écriture n'est pas encore confirmée : sert à prévenir avant de
  // quitter la page (les écritures IndexedDB sont asynchrones).
  function hasPendingWrites() { return pendingWrites > 0; }

  function setSaveErrorHandler(fn) { onSaveError = fn; }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Complète un objet de données partiel (ex: reçu de Firestore, éventuellement
  // d'un schéma plus ancien) avec les clés par défaut manquantes.
  function mergeWithDefaults(partial) {
    return Object.assign(defaultData(), partial || {});
  }

  return { load, save, flush, hasPendingWrites, setSaveErrorHandler, uid, mergeWithDefaults };
})();
