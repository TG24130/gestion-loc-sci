// Authentification Firebase (module ES — ce projet n'a pas de build/npm,
// on charge donc le SDK modulaire directement depuis le CDN officiel).
// Expose window.QfAuth pour que js/app.js (script classique) puisse s'y
// brancher, et emet un evenement "qf-auth-change" a chaque changement d'etat
// de connexion (connexion, deconnexion, resolution initiale de la session).
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { firebaseApp } from './firebaseInit.js?v=2026080607';

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
