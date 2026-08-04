# Bibliothèques vendored

Ces fichiers sont copiés tels quels (pas de gestionnaire de paquets pour ce
projet). Vérifier la somme SHA-256 avant de remplacer un fichier permet de
détecter une altération accidentelle ou malveillante.

| Fichier | Bibliothèque | Version | SHA-256 |
|---|---|---|---|
| `jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) | 2.5.1 (build 2022-01-28) | `98ccf17aa10c20bb1301762618fcc9b6ab3a4e7f26b6071d64d0b41154df3875` |
| `jszip.min.js` | [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e` |

Vérification (PowerShell) :

```powershell
Get-FileHash js\vendor\jspdf.umd.min.js -Algorithm SHA256
Get-FileHash js\vendor\jszip.min.js -Algorithm SHA256
```

jsPDF 2.5.1 date de 2022 ; une mise à jour vers la branche 3.x est
envisageable mais doit être testée manuellement sur les 6 types de PDF
générés par l'application (quittance, reçu partiel, relance, avenant,
courrier libre, état des lieux) avant tout remplacement.
