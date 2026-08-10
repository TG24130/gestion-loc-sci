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
import { firebaseApp } from './firebaseInit.js?v=2026081003';

const auth = getAuth(firebaseApp);

window.QfAuth = {
  currentUser: null,
  // Passe a true des que Firebase a repondu. Indispensable depuis que le
  // chargement des donnees de app.js est asynchrone (IndexedDB) : l'evenement
  // "qf-auth-change" peut etre emis AVANT que app.js n'ait pu s'y abonner.
  // L'application rejoue alors cet etat au lieu de rester verrouillee.
  resolved: false,
  signIn(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
  },
  signOut() {
    return signOut(auth);
  },
};

onAuthStateChanged(auth, (user) => {
  window.QfAuth.currentUser = user;
  window.QfAuth.resolved = true;
  window.dispatchEvent(new CustomEvent('qf-auth-change', { detail: { user } }));
});
