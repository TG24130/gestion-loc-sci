// Initialisation Firebase partagée (app unique) — importée par firebaseAuth.js,
// firestoreSync.js et firebaseStorageSync.js pour éviter une double init
// (initializeApp ne peut être appelé qu'une seule fois par config).
// IMPORTANT : les 3 fichiers importent ce module avec exactement le même
// suffixe "?v=..." — un suffixe différent ferait charger 3 instances
// distinctes de ce module (donc 3 appels à initializeApp), ce qui lève une
// erreur "Firebase App named '[DEFAULT]' already exists". Toujours mettre à
// jour les 3 imports ensemble.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';

// Projet Firebase de PRODUCTION (gestion-loc-sci). Ces valeurs ne sont pas
// secrètes pour une application côté client : la protection réelle des
// données vient des règles de sécurité Firestore/Storage.
const firebaseConfig = {
  apiKey: 'AIzaSyCkeml8RESwOKKAtB29kYAWQ2aeUfjvFMY',
  authDomain: 'gestion-loc-sci.firebaseapp.com',
  projectId: 'gestion-loc-sci',
  storageBucket: 'gestion-loc-sci.firebasestorage.app',
  messagingSenderId: '77453400805',
  appId: '1:77453400805:web:332b2ea621eee198b4920c',
};

export const firebaseApp = initializeApp(firebaseConfig);
