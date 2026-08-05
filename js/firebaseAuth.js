// Authentification Firebase (module ES — ce projet n'a pas de build/npm,
// on charge donc le SDK modulaire directement depuis le CDN officiel).
// Expose window.QfAuth pour que js/app.js (script classique) puisse s'y
// brancher, et emet un evenement "qf-auth-change" a chaque changement d'etat
// de connexion (connexion, deconnexion, resolution initiale de la session).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

// Projet Firebase de TEST (gestion-loc-sci-test). Ces valeurs ne sont pas
// secretes pour une application cote client : la protection reelle des
// donnees viendra des regles de securite Firestore/Storage (Phase 5), pas
// de la confidentialite de cette configuration.
const firebaseConfig = {
  apiKey: 'AIzaSyC73xOSfkjIMxtvKUvArPbLj7tVRJZrDYg',
  authDomain: 'gestion-loc-sci-test.firebaseapp.com',
  projectId: 'gestion-loc-sci-test',
  storageBucket: 'gestion-loc-sci-test.firebasestorage.app',
  messagingSenderId: '618504225539',
  appId: '1:618504225539:web:6be5d91c8fbb4c2f3f1f36',
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

window.QfAuth = {
  currentUser: null,
  signIn(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
  },
  signOut() {
    return signOut(auth);
  },
};

onAuthStateChanged(auth, (user) => {
  window.QfAuth.currentUser = user;
  window.dispatchEvent(new CustomEvent('qf-auth-change', { detail: { user } }));
});
