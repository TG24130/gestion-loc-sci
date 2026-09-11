# Bibliothèques vendored

Ces fichiers sont copiés tels quels (pas de gestionnaire de paquets pour ce
projet). Vérifier la somme SHA-256 avant de remplacer un fichier permet de
détecter une altération accidentelle ou malveillante.

| Fichier | Bibliothèque | Version | SHA-256 |
|---|---|---|---|
| `jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) | 2.5.1 (build 2022-01-28) | `98ccf17aa10c20bb1301762618fcc9b6ab3a4e7f26b6071d64d0b41154df3875` |
| `jszip.min.js` | [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e` |
| `firebase/firebase-app.js` | [Firebase JS SDK](https://firebase.google.com/docs/web/setup) | 10.14.1 | `19f05d67deadb1a1fba077c18611c3c9b2fdd5b4ebbd0a5e391498925ebae23e` |
| `firebase/firebase-auth.js` | Firebase JS SDK (import interne réécrit, voir note) | 10.14.1 | `1c1b9ea1bd9ece91a2a4397c7334b1f0f94b65fca84529b7e6f9ba9a60c49b1f` |
| `firebase/firebase-firestore.js` | Firebase JS SDK (import interne réécrit, voir note) | 10.14.1 | `0366e74c38a107145013a4ae806c170f9309057ff5405f3cf908adcb0826d9bb` |
| `firebase/firebase-storage.js` | Firebase JS SDK (import interne réécrit, voir note) | 10.14.1 | `0cae158ec8ca34cd35f4a7c093aff927802d0e7c01316c7bc1ba13b6924b16e1` |

Les 4 fichiers Firebase étaient chargés depuis `www.gstatic.com` jusqu'au 11/09/2026 ;
vendorisés car le service worker (`sw.js`) ne met en cache que les requêtes de même
origine — un CDN externe non vendorisé reste donc indisponible hors ligne, ce qui
bloquait l'app sur l'écran "Vérification de votre session…" en 4G faible.

**Modification** (contrairement à jsPDF/JSZip, ces 3 fichiers ne sont pas strictement
tels quels) : `firebase-auth.js`, `firebase-firestore.js` et `firebase-storage.js`
importent en interne `firebase-app.js` via une URL CDN absolue codée en dur par
Google. Cette URL a été réécrite en `./firebase-app.js` (import relatif local) —
sans ce correctif, chaque module recrée sa propre instance Firebase App déconnectée
de celle initialisée par l'app (`firebaseInit.js`), avec l'erreur
`Component auth has not been registered yet`. Toute mise à jour de version doit
répéter ce correctif :
```bash
sed -i 's#https://www.gstatic.com/firebasejs/VERSION/firebase-app.js#./firebase-app.js#g' js/vendor/firebase/firebase-auth.js js/vendor/firebase/firebase-firestore.js js/vendor/firebase/firebase-storage.js
```

Vérification (PowerShell) :

```powershell
Get-FileHash js\vendor\jspdf.umd.min.js -Algorithm SHA256
Get-FileHash js\vendor\jszip.min.js -Algorithm SHA256
Get-FileHash js\vendor\firebase\firebase-app.js -Algorithm SHA256
Get-FileHash js\vendor\firebase\firebase-auth.js -Algorithm SHA256
Get-FileHash js\vendor\firebase\firebase-firestore.js -Algorithm SHA256
Get-FileHash js\vendor\firebase\firebase-storage.js -Algorithm SHA256
```

jsPDF 2.5.1 date de 2022 ; une mise à jour vers la branche 3.x est
envisageable mais doit être testée manuellement sur les 6 types de PDF
générés par l'application (quittance, reçu partiel, relance, avenant,
courrier libre, état des lieux) avant tout remplacement.
