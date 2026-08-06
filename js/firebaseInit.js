// Initialisation Firebase partagée (app unique) — importée par firebaseAuth.js,
// firestoreSync.js et firebaseStorageSync.js pour éviter une double init
// (initializeApp ne peut être appelé qu'une seule fois par config).
// IMPORTANT : les 3 fichiers importent ce module avec exactement le même
// suffixe "?v=..." — un suffixe différent ferait charger 3 instances
// distinctes de ce module (donc 3 appels à initializeApp), ce qui lève une
// erreur "Firebase App named '[DEFAULT]' already exists". Toujours mettre à
// jour les 3 imports ensemble.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';

// Ces valeurs ne sont pas secrètes pour une application côté client : la
// protection réelle des données vient des règles de sécurité Firestore/Storage.

// Projet de PRODUCTION : les vraies données de la SCI.
const PROD_CONFIG = {
  apiKey: 'AIzaSyCkeml8RESwOKKAtB29kYAWQ2aeUfjvFMY',
  authDomain: 'gestion-loc-sci.firebaseapp.com',
  projectId: 'gestion-loc-sci',
  storageBucket: 'gestion-loc-sci.firebasestorage.app',
  messagingSenderId: '77453400805',
  appId: '1:77453400805:web:332b2ea621eee198b4920c',
};

// Projet de TEST : données jetables, sert à valider avant tout déploiement.
const TEST_CONFIG = {
  apiKey: 'AIzaSyC73xOSfkjIMxtvKUvArPbLj7tVRJZrDYg',
  authDomain: 'gestion-loc-sci-test.firebaseapp.com',
  projectId: 'gestion-loc-sci-test',
  storageBucket: 'gestion-loc-sci-test.firebasestorage.app',
  messagingSenderId: '618504225539',
  appId: '1:618504225539:web:6be5d91c8fbb4c2f3f1f36',
};

// Le choix du projet est déduit de l'adresse, PAS d'un réglage manuel : une
// session de test en local ne peut donc structurellement pas écrire dans les
// vraies données, même par erreur. Seul le site déployé parle à la production.
// (Leçon de l'incident du 05/08/2026 : la migration avait été mise au point
// directement contre le projet de production.)
function isDevHost(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === ''                       // fichier ouvert en local (file://)
    || /^192\.168\./.test(hostname)          // réseau local (test depuis le téléphone)
    || /^10\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

export const IS_TEST_ENV = isDevHost(location.hostname);
const firebaseConfig = IS_TEST_ENV ? TEST_CONFIG : PROD_CONFIG;

export const firebaseApp = initializeApp(firebaseConfig);

// Repère visuel permanent en environnement de test : impossible de confondre
// une fenêtre de test avec l'application réelle (source de confusion pendant
// le dépannage de l'incident).
if (IS_TEST_ENV) {
  const badge = document.createElement('div');
  badge.textContent = 'PROJET DE TEST — ' + firebaseConfig.projectId;
  badge.style.cssText = [
    'position:fixed', 'z-index:99999', 'left:0', 'right:0', 'bottom:0',
    'background:#b45309', 'color:#fff', 'font:600 11px system-ui,sans-serif',
    'text-align:center', 'padding:3px 6px', 'letter-spacing:.04em',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(badge);
}
