// Synchronisation des fichiers joints (photos EDL, PDF baux/documents...) avec
// Firebase Storage. IndexedDB (js/filesDb.js) reste le cache local rapide et
// la source utilisée hors-ligne ; ce module gère seulement l'aller-retour
// avec le cloud, appelé par filesDb.js. Expose window.QfFileSync.
import { firebaseApp } from './firebaseInit.js?v=2026072130';
import {
  getStorage,
  ref,
  uploadBytes,
  getBlob,
  deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';

const storage = getStorage(firebaseApp);

function pathFor(uid, id) {
  return `users/${uid}/files/${id}`;
}

async function upload(uid, id, blob) {
  await uploadBytes(ref(storage, pathFor(uid, id)), blob);
}

async function download(uid, id) {
  try {
    return await getBlob(ref(storage, pathFor(uid, id)));
  } catch (e) {
    if (e && e.code === 'storage/object-not-found') return null;
    throw e;
  }
}

async function remove(uid, id) {
  try {
    await deleteObject(ref(storage, pathFor(uid, id)));
  } catch (e) {
    if (e && e.code === 'storage/object-not-found') return;
    throw e;
  }
}

window.QfFileSync = { upload, download, remove };
