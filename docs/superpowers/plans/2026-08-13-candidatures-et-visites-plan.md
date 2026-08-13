# Candidatures et visites — plan d'implémentation

Spec : `docs/superpowers/specs/2026-08-13-candidatures-et-visites-design.md`

Sept phases, livrées en **deux temps** :

- **Temps 1 — Candidatures** (phases 1 à 5). Utilisable seul : c'est là qu'est
  le travail de tri.
- **Temps 2 — Visites** (phases 6 et 7).

Chaque phase laisse l'application fonctionnelle. Ne rien pousser sans demande :
un push sur `main` atteint la production en une à deux minutes.

---

## Phase 0 — Découverte (faite, à lire avant d'implémenter)

### APIs réelles, vérifiées dans le code

| Besoin | API | Source |
|---|---|---|
| État | `Storage.load/save/uid/mergeWithDefaults` | `js/storage.js:150` |
| Fichiers | `FilesDb.saveFile/getFile/deleteFile` | `js/filesDb.js:77` |
| Réduction d'image | `resizeImageFile(file, maxDim, quality)` | `js/app.js:3198` |
| Ouverture d'une pièce | `openStoredFile(fileId, fileName)` | `js/app.js:1552` |
| Nom de fichier | `slugify(str)` | `js/app.js:4615` |
| PDF | `PdfBuilder.generate(type, ctx)`, `PdfBuilder.filename(type, ctx)` | `js/pdfBuilder.js:264` |
| Archive | `JSZip`, global | `index.html` |

### Patterns à copier

**Module pur testable** — `js/annonce.js` : IIFE terminé par
`window.QfAnnonce = {…}`. **Jamais** une `const` de haut niveau comme
`storage.js` : `vm.runInContext` ne l'expose pas sur le sandbox, le module
devient intestable.

**Écran avec saisie continue** — `renderAnnonces(forcer)` dans `js/app.js` :
rendu complet une fois, puis seules les zones calculées sont rafraîchies. Le
garde-fou en tête de fonction empêche la synchronisation Firestore de
reconstruire le DOM pendant une frappe, et ne vise **que** les champs de saisie
— l'étendre aux boutons les rendrait inertes. Les actions de l'écran appellent
`render…(true)`.

**Ajout d'un type de PDF** — `js/pdfBuilder.js` : une fonction par type
(`quittance`, `avenant`, `libre`), enregistrée dans `generate()`, s'appuyant sur
`drawHeader`, `drawTitle`, `drawTable`, `addWrapped`, `drawSignature`.

**Photos et pièces** — `ajouterPhotosAnnonce` dans `js/app.js` : validation du
type et de la taille, réduction, `FilesDb.saveFile(Storage.uid(), blob)` dans un
`try/catch` qui n'annule pas le reste.

### Les quatre listes de clés

Deux collections nouvelles (`candidatures`, `visites`). Chacune doit être
déclarée dans **quatre** endroits, sous peine de disparition silencieuse :

1. `defaultData()` — `js/storage.js`
2. `RECORD_KEYS` — `js/firestoreSync.js`
3. export `.zip` — boucle dédiée dans `js/app.js` (les pièces vivent sous
   `pieces`, que `filesOf()` ne reconnaît pas : les présenter explicitement à
   `addFiles`)
4. imports JSON **et** ZIP — les deux `Object.assign` de `js/app.js`

### Le cache

`index.html` et `sw.js` portent la même valeur (`CACHE_NAME` et tous les `?v=`).
Incrémenter les deux à chaque phase touchant un fichier servi. **Ne pas** étendre
le `sed` aux fichiers de `js/` : les trois modules Firebase importent
`firebaseInit.js?v=…` avec un suffixe figé, et un suffixe divergent entre eux
ferait charger trois instances Firebase.

---

## Phase 1 — Le module `js/candidature.js` et ses tests

Aucun fichier servi n'est modifié : l'application est strictement inchangée.

### À implémenter

`js/candidature.js`, terminé par
`window.QfCandidature = { calculerIndicateurs, construireMailRefus, calculerCreneaux };`

```js
calculerIndicateurs(candidature, bien)
// → { tauxEffort, resteAVivre, ratioLoyer, alertes: [] }

construireMailRefus(candidature, bien, sci)   // → { objet, corps }
calculerCreneaux(heureDebut, dureeCreneau, nombre)  // → ["09:00", …]
```

Formules dans la section « Indicateurs » du spec. Ressources nulles ou absentes :
indicateurs à `null`, jamais de division par zéro.

Le mail ne contient **aucun motif** de refus.

### Tests

`tests/candidature.test.js`, sur le harnais de `tests/annonce.test.js`
(`vm.createContext`, `sandbox.window.QfCandidature`).

- Indicateurs : cas nominal, ressources à zéro, charges nulles, candidat sous le
  ratio, deux candidats à ressources égales départagés par le reste à vivre.
- Créneaux : enchaînement, passage d'heure (11:45 + 30 min), durée non standard.
- Mail : contient le nom et l'adresse du bien ; **ne contient aucun** mot lié aux
  revenus, à la famille, aux animaux ou à l'origine — test par liste de mots
  interdits.

### Vérification

- `node tests/candidature.test.js` passe
- `node tests/annonce.test.js` et `node tests/syncLogic.test.js` passent toujours
- `grep -n "^import" js/candidature.js` ne renvoie rien
- `git status` ne liste que les deux fichiers nouveaux

---

## Phase 2 — Modèle de données

### À implémenter

`js/storage.js` : `candidatures: []` et `visites: []` dans `defaultData()`.

`js/firestoreSync.js` : les deux clés dans `RECORD_KEYS`.

`js/app.js` : les deux clés dans les **deux** `Object.assign` d'import, et une
boucle d'export par collection — pour `candidatures`, présenter `pieces` à
`addFiles` sous forme `{ date, files: [{fileId, fileName}] }`.

`tests/syncLogic.test.js` : ajouter les deux clés à `baseData()` avec une fiche
chacune, deux assertions dans le test 1, et **mettre à jour le compte de
documents** (il vérifie `server.store.size`).

### Vérification

- Écrire les assertions **avant** la correction et constater qu'elles échouent
  (`obtenu undefined`), puis qu'elles passent après
- `Storage.mergeWithDefaults({})` renvoie les deux tableaux
- Exporter une sauvegarde avant de tester
- Ne pas toucher `schemaVersion` : l'ajout est rétrocompatible

---

## Phase 3 — Menu et vues vides

### À implémenter

`index.html` : deux entrées dans le sous-groupe `annonces` existant —
`data-view="annonces-candidatures"` et `data-view="annonces-visites"` — et deux
sections. **Attention** : le groupe partage une seule `<section>` par convention
(`view-annonces`). Ici les trois écrans diffèrent trop : passer à trois sections
(`view-annonces`, `view-annonces-candidatures`, `view-annonces-visites`) et
adapter le calcul de `sectionId` dans `showView`, plutôt que d'entasser trois
écrans dans un même conteneur.

`js/app.js` : `renderCandidatures()` et `renderVisites()` appelées depuis
`showView`, vides pour l'instant. Charger `js/candidature.js` avant `app.js`.

Incrémenter le cache.

### Vérification

- Les trois entrées s'affichent, chacune ouvre sa section
- Les quinze vues préexistantes fonctionnent, une seule section active à la fois
- `window.QfCandidature` est défini, console sans erreur nouvelle

---

## Phase 4 — Écran Candidatures

### À implémenter

Liste filtrée par bien, une fiche par candidature : coordonnées, date de
réception, ressources, charges déclarées, notes, statut.

Les indicateurs sont recalculés à la frappe via `QfCandidature`, dans la seule
zone concernée — **reprendre le garde-fou de `renderAnnonces(forcer)`**, et
faire appeler `renderCandidatures(true)` par les actions.

Pièces : `<input type="file" multiple accept="image/*,.pdf,.doc,.docx,.odt">`.
Validation du type et de la taille (15 Mo), réduction des seules images,
`FilesDb.saveFile`. Ouverture par `openStoredFile`, qui gère déjà le repli pour
les formats non affichables.

Actions : **Retenir** · **Refuser** (affiche le mail, bouton copier, **efface les
pièces** puis `FilesDb.deleteFile`) · **Supprimer** (efface aussi les pièces).

Tri de la liste par taux d'effort et par reste à vivre.

Incrémenter le cache.

### Vérification

Dans le navigateur, avec de **vrais clics** et une **vraie frappe** — `.click()`
en JavaScript ne déplace pas le focus et masquerait une régression :

- Saisir vingt caractères d'affilée dans un champ : rien ne se perd
- Les quatre boutons répondent
- Importer un PDF, un JPG et un DOCX : les trois sont acceptés, seul le JPG est
  réduit
- Refuser une candidature : le mail s'affiche, et les pièces disparaissent
  d'IndexedDB (vérifier le compte dans `qf_files_db`)
- Recharger : tout est retrouvé

---

## Phase 5 — Fiche de renseignements en PDF

### À implémenter

`js/pdfBuilder.js` : une fonction `ficheRenseignements(doc, ctx)` sur le modèle
de `avenant`, enregistrée dans `generate()`, réutilisant `drawHeader`,
`drawTitle`, `drawTable` et `addWrapped`.

Contenu repris de la fiche existante, **sans** « régime matrimonial » ni « lieu
de mariage », en conservant « remboursement de prêts ». Adresse, loyer, charges
et dépôt de garantie viennent du bien.

Bouton de génération depuis l'écran Candidatures, pour le bien sélectionné.

Incrémenter le cache.

### Vérification

- Le PDF s'ouvre, la mise en page tient sur une page
- Les montants correspondent au bien choisi, pas à des valeurs figées
- Les deux champs retirés sont absents
- La liste des pièces à fournir est inchangée

---

## Phase 6 — Écran Visites

### À implémenter

Choix du bien, de la date, de l'heure de début et de la durée d'un créneau. Les
candidatures `retenue` du bien sont placées à la suite via `calculerCreneaux`.
Réordonnancement par boutons monter/descendre, comme les photos d'annonce ;
`heure` recalculée à chaque modification, l'ordre du tableau faisant foi.

Sortie copiable de la liste (nom, téléphone, heure) pour l'avoir sur soi.

Incrémenter le cache.

### Vérification

- Cinq candidats retenus produisent cinq créneaux enchaînés
- Réordonner puis recharger : l'ordre tient
- Aucun candidat retenu : message explicite, pas un planning vide
- Retirer un candidat retenu ailleurs : le planning reste cohérent

---

## Phase 7 — Vérification finale

1. Les trois suites de tests passent.
2. `grep -rn "^import" js/candidature.js` : rien.
3. `CACHE_NAME` et les `?v=` portent la même valeur, différente de la précédente.
4. Les vues préexistantes fonctionnent toutes.
5. Parcours complet : créer trois candidatures, importer des pièces de trois
   formats, en refuser une, planifier les visites des deux autres.
6. **Aller-retour de sauvegarde** : export `.zip`, effacement des blobs et
   altération d'un nom, réimport — candidatures, pièces et visites reviennent.

### Ne pas faire

- Pousser sans demande explicite.
- Modifier `schemaVersion`.
- Étendre le garde-fou de rendu aux boutons.
- Toucher aux suffixes `?v=` des modules Firebase.
