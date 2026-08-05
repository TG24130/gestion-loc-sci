// Stockage des fichiers joints (factures/devis) dans IndexedDB — évite d'alourdir
// le localStorage avec de gros fichiers en base64.
const FilesDb = (function () {
  const DB_NAME = 'qf_files_db';
  const STORE = 'files';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function putLocal(id, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getLocal(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteLocal(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function currentUid() {
    return window.QfAuth && window.QfAuth.currentUser ? window.QfAuth.currentUser.uid : null;
  }

  // Firebase Storage n'a pas de file d'attente hors-ligne native (contrairement
  // à Firestore) : on garde donc ici, en local, la liste des fichiers dont
  // l'envoi cloud reste à refaire (échec réseau, hors-ligne...), pour la
  // retenter automatiquement au retour de connexion (voir retryPendingUploads,
  // appelé par app.js sur l'évènement "online" et à la connexion).
  const PENDING_KEY = 'qf_pending_uploads';

  function getPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch (e) { return []; }
  }
  function addPending(id) {
    const list = getPending();
    if (!list.includes(id)) {
      list.push(id);
      localStorage.setItem(PENDING_KEY, JSON.stringify(list));
    }
  }
  function removePending(id) {
    const list = getPending().filter((x) => x !== id);
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  }

  async function saveFile(id, blob) {
    await putLocal(id, blob);
    const uid = currentUid();
    if (window.QfFileSync && uid) {
      window.QfFileSync.upload(uid, id, blob).then(() => removePending(id)).catch((e) => {
        console.error("Échec de l'envoi du fichier vers le cloud (reste disponible localement, sera retenté)", e);
        addPending(id);
      });
    } else {
      addPending(id);
    }
  }

  async function retryPendingUploads() {
    const uid = currentUid();
    if (!window.QfFileSync || !uid) return;
    for (const id of getPending()) {
      try {
        const blob = await getLocal(id);
        if (!blob) { removePending(id); continue; }
        await window.QfFileSync.upload(uid, id, blob);
        removePending(id);
      } catch (e) {
        console.error('Nouvel échec lors de la resynchronisation du fichier', id, e);
      }
    }
  }

  async function getFile(id) {
    const local = await getLocal(id);
    if (local) return local;
    const uid = currentUid();
    if (window.QfFileSync && uid) {
      try {
        const remote = await window.QfFileSync.download(uid, id);
        if (remote) {
          await putLocal(id, remote);
          return remote;
        }
      } catch (e) {
        console.error('Échec du téléchargement du fichier depuis le cloud', e);
      }
    }
    return null;
  }

  async function deleteFile(id) {
    await deleteLocal(id);
    removePending(id);
    const uid = currentUid();
    if (window.QfFileSync && uid) {
      window.QfFileSync.remove(uid, id).catch((e) => {
        console.error('Échec de la suppression du fichier dans le cloud', e);
      });
    }
  }

  return { saveFile, getFile, deleteFile, retryPendingUploads };
})();
