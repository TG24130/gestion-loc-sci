# Gestion Loc SCI

Application de gestion locative pour une SCI (quittances, baux, charges,
états des lieux, documents administratifs, crédits...).

Production : https://tg24130.github.io/gestion-loc-sci/

## Nature de l'application

- **100 % client, sans build.** HTML/CSS/JS pur (ES2017+), aucun framework,
  aucun `package.json`, aucun bundler. Les fichiers sont servis tels quels.
- **Aucun backend, aucune base de données.** Toutes les données vivent dans
  le navigateur :
  - `localStorage`, clé `qf_data_v1` — un seul objet JSON contenant tous les
    tableaux (biens, locataires, documents, baux, charges, états des
    lieux...). Structure définie dans `js/storage.js`.
  - `IndexedDB`, base `qf_files_db` — les fichiers binaires (photos, PDF
    scannés, justificatifs) référencés depuis `localStorage` par un
    `fileId`. Gérée par `js/filesDb.js`.
- **PWA installable** (téléphone/PC), service worker en stratégie
  « réseau d'abord » (`sw.js`) : toujours la version la plus récente en
  ligne, avec repli sur le cache pour un accès hors-ligne.
- **Déploiement** : push sur `main` → GitHub Pages reconstruit
  automatiquement en 1-2 minutes. **Aucune revue, aucun test automatique,
  aucun environnement de test** avant la production.

## Démarrer en local

Aucune installation nécessaire. Servir le dossier `webapp/` avec n'importe
quel serveur statique, par exemple :

```bash
python -m http.server 5173 --directory webapp
```

puis ouvrir `http://localhost:5173`.

## Fichiers principaux

| Fichier | Rôle |
|---|---|
| `index.html` | Toutes les vues de l'application (une section par écran) |
| `js/app.js` | Toute la logique applicative (un seul IIFE) |
| `js/storage.js` | Lecture/écriture de `localStorage` |
| `js/filesDb.js` | Lecture/écriture d'`IndexedDB` (fichiers binaires) |
| `js/documents.js` | Aperçu HTML des documents (quittance, avenant...) |
| `js/pdfBuilder.js` | Génération PDF des documents courts (1 page) |
| `js/richTextPdf.js` | Rendu PDF de l'éditeur de bail (texte riche) |
| `js/edlPdf.js` | Génération PDF multi-pages de l'état des lieux |
| `js/numberToWords.js` | Montant en toutes lettres (français) |
| `sw.js` / `manifest.json` | PWA (service worker, icônes, etc.) |

## ⚠️ Avant toute expérimentation

**Cette application gère de vraies données personnelles** (locataires,
signatures, documents). Avant de tester une modification ou d'importer un
jeu de données :

1. Exporter une sauvegarde (**bouton "Exporter mes données (.zip)"** dans le
   menu de gauche) et la conserver ailleurs que sur l'appareil en cours.
2. Ne jamais importer un fichier de sauvegarde dont on n'est pas sûr —
   l'import remplace intégralement les données actuelles sans étape de
   récupération automatique.

Il n'existe **aucune sauvegarde automatique** : la seule protection contre
une perte de données (panne disque, nettoyage de navigateur, erreur de
manipulation) est l'export manuel régulier.

## Limites connues

- Pas de tests automatisés, pas de CI, pas de lint.
- Le "code d'accès" (écran de verrouillage) est une protection visuelle,
  pas une véritable barrière de sécurité — voir la note affichée dans
  l'écran "Ma SCI" à ce sujet.
- Un audit applicatif complet est disponible dans
  `../audit-application-2026-08.md` (hors de ce dépôt) : architecture,
  sécurité, fiabilité, plan d'action priorisé.
