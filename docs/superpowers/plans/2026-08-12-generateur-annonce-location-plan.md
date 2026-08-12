# Générateur d'annonce de location — plan d'implémentation

Spec de référence : `docs/superpowers/specs/2026-08-12-generateur-annonce-location-design.md`

Six phases. Chacune est autonome, exécutable dans un contexte neuf, et laisse
l'application fonctionnelle. Ne rien pousser : un push sur `main` déclenche le
déploiement en production en une à deux minutes.

---

## Phase 0 — Découverte (faite, à lire avant toute implémentation)

### APIs autorisées, vérifiées dans le code

| Besoin | API réelle | Source |
|---|---|---|
| Lire/écrire l'état | `Storage.load()`, `Storage.save(data)`, `Storage.uid()`, `Storage.mergeWithDefaults(partial)` | `js/storage.js:150` |
| Stocker un fichier | `FilesDb.saveFile(id, blob)` | `js/filesDb.js:77` |
| Relire un fichier | `FilesDb.getFile(id)` → `Blob` ou `null` | `js/filesDb.js:105` |
| Supprimer un fichier | `FilesDb.deleteFile(id)` | `js/filesDb.js:123` |
| Archive ZIP | `JSZip`, global, déjà chargé | `index.html:1166` |

### Patterns à copier

**Enregistrement d'un fichier** — copier `js/app.js:1635-1644` :
l'identifiant vient de `Storage.uid()`, l'appel est dans un `try/catch`, et
l'échec n'annule pas l'enregistrement de la fiche — il affiche une alerte et
poursuit.

**Ouverture d'un fichier stocké** — copier `openStoredFile`, `js/app.js:1552`,
qui gère explicitement le cas `blob === null`.

**Déclaration d'une vue** — trois endroits :
1. `index.html:67-131` — le bouton dans `<nav>`
2. `index.html` — une `<section id="view-..." class="view">`, la dernière
   existante étant `view-facturestravaux` à la ligne 1055
3. `js/app.js:229` — `showView()` mappe `data-view` vers `'view-' + view`, et
   appelle la fonction de rendu

**Groupes de menu** — `js/app.js:211` (`groupeDeLaVue`) : un groupe partage
**une seule** `<section>` pour toutes ses entrées. `charges-tontes` et
`charges-chaudiere` affichent tous deux `view-charges`. Le sous-état est géré
en JavaScript, pas par des sections distinctes.

### Anti-patterns à éviter

- **Ne pas déclarer le module en `const` de haut niveau.** `storage.js` fait
  `const Storage = (function(){…})()`. Ce style est **intestable** avec le
  harnais existant : `vm.runInContext` n'expose pas les `const` de haut niveau
  sur l'objet sandbox. Suivre `firestoreSync.js`, qui termine par
  `window.QfSync = {…}`. Le module exposera `window.QfAnnonce`.
- **Aucun `import` ES dans `js/annonce.js`.** Les imports sont réservés aux
  `js/firebase*.js`, chargés en `type="module"`. Le harnais de test lève une
  erreur explicite si des imports subsistent (`tests/syncLogic.test.js:69`).
- **Ne pas écrire les photos dans Firestore.** Passer exclusivement par
  `FilesDb`, qui route vers Firebase Storage. Seul le `fileId` figure dans
  l'état synchronisé.
- **Ne pas modifier `js/firestoreSync.js`.** `mergeWithDefaults` suffit à faire
  remonter la nouvelle clé.
- **Ne pas toucher à `bienGabarits` ni aux états des lieux** (décision du spec).

### Le piège du cache

`index.html` charge chaque script avec `?v=2026081004`, et `sw.js:8` définit
`CACHE_NAME = 'gls-cache-2026081004'`. Le commentaire du fichier documente un
incident réel : sans incrément, un iPhone continue de servir une version
ancienne indéfiniment.

**À chaque phase touchant un fichier servi, incrémenter les deux :** le `?v=`
de tous les `<script>` d'`index.html`, et `CACHE_NAME` dans `sw.js`. Même
valeur des deux côtés.

---

## Phase 1 — Le module pur et ses tests

Aucun fichier existant n'est modifié. L'application continue de fonctionner à
l'identique : rien ne charge encore le module.

### À implémenter

Créer `js/annonce.js`, terminé par `window.QfAnnonce = { construireAnnonce };`

```js
construireAnnonce(bien, redaction, reglagesSci)
// → { texte: string, avertissements: [{ champ, gravite, message }] }
```

`gravite` vaut `'bloquant'` ou `'attention'`.

Le texte est assemblé dans l'ordre : titre, `redaction.texteLibre` **restitué
sans aucune modification**, puis les trois blocs générés — performance
énergétique, conditions financières, candidature et visite. Contenu détaillé
des blocs : section « Contenu des blocs générés » du spec.

Le revenu minimum du bloc candidature se calcule :
`reglagesSci.ratioRevenus × redaction.loyer`.

Avertissements bloquants : `surfaceHabitable`, `dpeClasse`, `gesClasse`,
`energieCoutMin`/`energieCoutMax`, `energieAnneeReference`, `loyer`, `charges`,
`depotGarantie`, commune, `disponibleLe`.

Avertissements « attention » : « environ » à proximité d'une surface dans le
texte libre, `dpeDateRealisation` de plus de dix ans, `texteLibre` de moins de
300 caractères, et répétition d'un motif (loyer, DPE, caution, critère de
candidature, visite) déjà couvert par un bloc généré.

### Tests

Créer `tests/annonce.test.js`, lancé par `node tests/annonce.test.js`.

Copier le harnais de `tests/syncLogic.test.js` : `fs.readFileSync` du module,
`vm.createContext(sandbox)`, `vm.runInContext(src, sandbox)`, puis
`sandbox.window.QfAnnonce`. Le sandbox n'a besoin d'aucun stub Firebase, et
aucun import n'est à retirer — le module n'en a pas.

Réutiliser le micro-harnais de `tests/syncLogic.test.js:117` (compteurs
`passed`/`failed`), sans ajouter de dépendance.

Cas à couvrir :
1. Un bien complet produit le texte attendu, comparé intégralement.
2. Un test par mention obligatoire : la retirer déclenche son bloquant, et lui
   seul.
3. Un texte libre contenant un montant de loyer déclenche l'avertissement de
   répétition.
4. Le texte libre ressort caractère pour caractère, y compris ses retours à la
   ligne et ses caractères accentués.

### Vérification

- `node tests/annonce.test.js` passe, zéro échec
- `node tests/syncLogic.test.js` passe toujours
- `grep -n "^import" js/annonce.js` ne renvoie rien
- `grep -n "window.QfAnnonce" js/annonce.js` renvoie la ligne finale
- L'application se charge et se comporte à l'identique (aucun fichier servi
  n'a été modifié)

---

## Phase 2 — Le modèle de données

### À implémenter

Dans `js/storage.js`, fonction `defaultData()` (ligne 20) : ajouter
`annonceRedactions: []` à côté de `bailRedactions` et `edlRedactions`.

Ajouter à l'objet `sci` de la même fonction : `critereContrat`,
`ratioRevenus`, `modalitesVisite`, `canalContact`, tous en chaîne vide sauf
`ratioRevenus` à `3`.

Les champs ajoutés au `bien` (spec, « Champs ajoutés à `bien` ») ne demandent
aucune déclaration : `data.biens` contient des objets libres, et
`openBienModal` (`js/app.js:510`) n'est pas modifié dans cette phase.

### Vérification

- L'application démarre sur des données existantes sans perte : ouvrir, vérifier
  que biens, locataires et documents sont intacts
- `Storage.mergeWithDefaults({})` renvoie un objet contenant `annonceRedactions`
- `node tests/syncLogic.test.js` passe toujours
- **Exporter une sauvegarde `.zip` avant de tester**, conformément au README

### Anti-pattern

Ne pas incrémenter `schemaVersion` : l'ajout est rétrocompatible et
`mergeWithDefaults` le gère. Modifier ce numéro ferait diverger les appareils.

---

## Phase 3 — Navigation et vue vide

Objectif : la vue existe, s'affiche, et est vide. Aucun risque fonctionnel.

### À implémenter

**`index.html`, dans `<nav>`** — après le groupe `facturestravaux`, en copiant
sa structure exacte (`index.html:123-130`) :

```html
<button type="button" class="nav-group-label nav-group-toggle collapsed"
        data-toggle-group="annonces">
  <span>Publication et gestion annonce</span>
  <span class="nav-group-arrow"></span>
</button>
<div class="nav-subgroup collapsed" id="nav-subgroup-annonces">
  <button class="nav-btn nav-btn-sub" data-view="annonces-publication">Publication</button>
</div>
```

**`index.html`** — une `<section id="view-annonces" class="view">` après
`view-facturestravaux`. **Une seule section pour tout le groupe**, conformément
au pattern des groupes existants.

**`js/app.js:211`, `groupeDeLaVue`** — ajouter :
`if (view.indexOf('annonces-') === 0) return 'annonces';`

**`js/app.js:229`, `showView`** — ajouter `annonces-` à la chaîne de calcul du
`sectionId`, sur le modèle de `isFacturesTravaux`, et l'appel de rendu.

**Charger le module** — `index.html`, ajouter
`<script src="js/annonce.js?v=…"></script>` **avant** `js/app.js` (ligne 1174).

**Incrémenter le cache** : `?v=` sur tous les scripts d'`index.html`, et
`CACHE_NAME` dans `sw.js`.

### Vérification

- L'entrée apparaît, le groupe se déplie, la section vide s'affiche
- Les cinq autres groupes fonctionnent toujours
- Console sans erreur ; `window.QfAnnonce` est défini
- Toutes les vues existantes s'affichent encore

---

## Phase 4 — L'écran Publication

### À implémenter

Dans `js/app.js`, une fonction `renderAnnonces()` appelée depuis `showView`.
Quatre blocs, décrits dans la section « Écran Publication » du spec.

Le bloc **Caractéristiques du bien** écrit dans `data.biens` puis appelle
`save()`. La modale `openBienModal` n'est pas touchée.

Le bloc **Résultat** appelle `window.QfAnnonce.construireAnnonce(...)` à chaque
modification, affiche les avertissements au-dessus, et le compte des bloquants
sur le bouton de copie. **Le bouton reste actif** malgré les bloquants.

Copie : `navigator.clipboard.writeText(texte)`, avec repli sur un `<textarea>`
temporaire et `document.execCommand('copy')` si l'API est indisponible.

Pré-remplissage de la distribution : lire `data.bienGabarits` pour le
`bienId`, insérer les noms de pièces dans le texte libre. **Sans surfaces** —
les gabarits n'en portent pas.

**Incrémenter le cache.**

### Vérification

- Créer une rédaction, saisir les caractéristiques, voir le texte se construire
- Retirer la surface : l'avertissement bloquant apparaît, le bouton reste actif
- Copier, coller dans un éditeur : le texte est complet et le texte libre intact
- Recharger la page : la rédaction est toujours là
- `node tests/annonce.test.js` passe toujours

---

## Phase 5 — Photos et export

### À implémenter

Zone photos dans le bloc Rédaction : `<input type="file" accept="image/*" multiple>`.

**Avant stockage**, redimensionner par `canvas` : 1920 px sur le grand côté,
`toBlob(…, 'image/jpeg', 0.85)`. Refuser tout fichier non-image ou de plus de
15 Mo, avec un message explicite.

Stocker par `FilesDb.saveFile(Storage.uid(), blob)` en copiant le `try/catch`
de `js/app.js:1635-1644`. Enregistrer `{ fileId, ordre }` dans
`redaction.photos`.

Vignettes via `FilesDb.getFile`, en gérant `null` (photo signalée manquante,
écran utilisable). Réordonnancement par boutons monter/descendre. Suppression
par `FilesDb.deleteFile`.

Export : `JSZip`, un fichier par photo nommé `NN-<slug>.jpg` où `NN` est le
rang sur deux chiffres, puis téléchargement du blob généré.

**Incrémenter le cache.**

### Vérification

- Ajouter cinq photos ; vérifier dans l'onglet Application du navigateur que
  chaque entrée `qf_files_db` pèse quelques centaines de kilo-octets, pas
  plusieurs mégaoctets
- Réordonner, recharger : l'ordre est conservé
- Exporter, extraire : les fichiers sont préfixés `01-` à `05-` dans l'ordre
  affiché
- Supprimer une photo : elle disparaît de l'écran et d'IndexedDB
- Vérifier qu'aucune donnée d'image n'apparaît dans l'état sauvegardé par
  `Storage.save` — uniquement des `fileId`

---

## Phase 6 — Vérification finale

1. `node tests/annonce.test.js` et `node tests/syncLogic.test.js` : tout passe.
2. `grep -rn "^import" js/annonce.js` : rien.
3. `grep -n "gls-cache-" sw.js` et les `?v=` d'`index.html` portent la **même**
   valeur, différente de `2026081004`.
4. Toutes les vues préexistantes s'affichent et fonctionnent.
5. Parcours complet : sélectionner un bien, rédiger, ajouter des photos,
   copier, exporter, coller le texte et charger les photos sur le formulaire de
   dépôt — vérifier que l'ordre est respecté et le texte conforme.
6. Export d'une sauvegarde `.zip`, réimport sur un profil vierge : les
   rédactions et les photos reviennent.

### Ne pas faire

- Ne pas pousser. Le déploiement est la décision de l'utilisateur.
- Ne pas modifier `bienGabarits`, `edlPdf.js` ni les états des lieux.
- Ne pas incrémenter `schemaVersion`.
- Ne pas refactoriser `app.js` au-delà des ajouts décrits.
