// Initialisation Firebase partagée (app unique) — importée par firebaseAuth.js
// et firestoreSync.js pour éviter une double init (initializeApp ne peut être
// appelé qu'une seule fois par config).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';

// Projet Firebase de TEST (gestion-loc-sci-test). Ces valeurs ne sont pas
// secrètes pour une application côté client : la protection réelle des
// données vient des règles de sécurité Firestore/Storage (Phase 5), pas de
// la confidentialité de cette configuration.
const firebaseConfig = {
  apiKey: 'AIzaSyC73xOSfkjIMxtvKUvArPbLj7tVRJZrDYg',
  authDomain: 'gestion-loc-sci-test.firebaseapp.com',
  projectId: 'gestion-loc-sci-test',
  storageBucket: 'gestion-loc-sci-test.firebasestorage.app',
  messagingSenderId: '618504225539',
  appId: '1:618504225539:web:6be5d91c8fbb4c2f3f1f36',
};

export const firebaseApp = initializeApp(firebaseConfig);
