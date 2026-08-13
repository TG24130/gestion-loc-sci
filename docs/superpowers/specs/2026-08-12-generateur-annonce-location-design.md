# Générateur d'annonce de location — design

Date : 2026-08-12
Statut : validé, prêt pour le plan d'implémentation

## Objectif

Permettre de rédiger dans Gestion Loc SCI une annonce de location nue
d'habitation, conforme aux mentions légales obligatoires, prête à coller dans
le formulaire de dépôt de Leboncoin, avec ses photos ordonnées et exportables.

## Usage attendu

Le dépôt se fait depuis un **PC Windows**. C'est ce qui rend l'archive ZIP
pertinente comme format d'export, et ce qui laisse ouverte la possibilité du
remplissage automatique du formulaire dans un sous-projet ultérieur — celui-ci
exige un Chrome de bureau et ne pourrait pas fonctionner depuis un téléphone.

Déroulé complet d'une publication :

1. Menu → *Publication et gestion annonce* → *Publication*
2. Sélection du bien ; la rédaction existante s'affiche
3. Mise à jour de ce qui a changé (disponibilité, loyer)
4. « Copier l'annonce » — le texte assemblé part dans le presse-papier
5. « Exporter les photos » — une archive ZIP est téléchargée, puis extraite
6. Sur le formulaire de dépôt : collage du texte, puis sélection de toutes les
   photos du dossier extrait

Les préfixes numériques des fichiers (`01-`, `02-`…) font que le formulaire les
reçoit dans l'ordre voulu, sans manipulation photo par photo. La première
devient la vignette.

L'utilisateur effectue donc deux gestes manuels : coller le texte, sélectionner
les photos. Tout le reste — assemblage, conformité, ordre, redimensionnement —
est préparé par l'application.

## Périmètre

Ce document couvre **uniquement la rédaction**. Il ne couvre ni la publication
automatisée sur Leboncoin, ni la récupération des messages, ni les réponses
automatiques. Ces deux sujets feront chacun l'objet d'un spec distinct et
dépendent de celui-ci.

Type de bien couvert : **location nue à usage d'habitation**. Les baux
commerciaux, les locations meublées et les parkings relèvent d'autres régimes
et ne sont pas traités ici.

Les biens concernés se situent à Bergerac (24), commune non soumise à
l'encadrement des loyers. Le spec ne prévoit donc aucune mention de loyer de
référence majoré ni de complément de loyer.

## Contraintes du contexte

L'application est un client statique sans backend, servi par GitHub Pages
(voir `README.md`). Les données vivent dans IndexedDB, synchronisées par
Firestore ; les fichiers binaires transitent par Firebase Storage.

Il n'existe ni intégration continue, ni environnement de test : un push sur
`main` atteint la production en une à deux minutes. Une erreur dans une mention
légale se découvrirait donc sur une annonce déjà en ligne. C'est la raison pour
laquelle la génération est isolée dans une fonction pure couverte par des tests.

## Décisions d'architecture

### Un module autonome plutôt qu'un ajout à `app.js`

`app.js` pèse 206 Ko en un seul IIFE. La logique de génération va dans
`js/annonce.js`, sur le modèle de `documents.js`, `pdfBuilder.js` et
`edlPdf.js`. `app.js` ne reçoit que le câblage d'interface.

Le module est un IIFE global (comme `storage.js`), et non un module ES : c'est
ce qui permet de le charger par `vm` dans les tests Node, comme le fait déjà
`tests/syncLogic.test.js`.

### Génération hybride

Les blocs chiffrés et légaux sont générés à partir des données. Le descriptif
littéraire — environnement, distribution, matériaux — reste un texte libre
rédigé par l'utilisateur, restitué mot pour mot.

Ce choix est délibéré : le texte existant est précis et vivant ; un texte
assemblé par gabarit serait moins bon. L'outil supprime le risque d'oubli
légal, il ne réécrit pas.

### Répartition des données

Les caractéristiques permanentes du bien (surface, DPE, chauffage) vivent sur
l'objet `bien` : elles ne changent pas d'une annonce à l'autre. Les éléments
datés (texte, loyer du moment, disponibilité, photos) vivent dans une entité
`annonceRedactions`, liée par `bienId` — la convention déjà en place pour
`bailRedactions` et `edlRedactions`.

## Modèle de données

### Champs ajoutés à `bien`

| Groupe | Champs |
|---|---|
| Nature | `typeBien`, `nbPieces`, `nbChambres`, `anneeConstruction`, `normeConstruction` |
| Surface | `surfaceHabitable` (m², valeur exacte du mesurage) |
| Énergie | `dpeClasse`, `gesClasse`, `dpeConsommation` (kWh/m²/an), `dpeDateRealisation`, `energieCoutMin`, `energieCoutMax`, `energieAnneeReference` |
| Équipement | `chauffageType`, `eauChaudeType`, `climatisation`, `stationnement`, `exterieurs`, `annexes` |

Tous ces champs sont optionnels au niveau du stockage. Leur absence est
signalée par un avertissement au moment de la génération, pas par un refus
d'enregistrement.

### Nouvelle collection `annonceRedactions[]`

```js
{
  id, bienId,
  titre,
  texteLibre,                // descriptif rédigé par l'utilisateur
  loyer, charges,            // pré-remplis depuis le bien, modifiables
  chargesDetail: [],         // ce que couvre la provision
  chargesResteACharge,       // ex. ordures ménagères
  depotGarantie,
  disponibleLe,
  honoraires,                // 0 en location directe
  photos: [{ fileId, ordre }],
  statut,                    // brouillon | publiee | archivee
  createdAt, updatedAt
}
```

`statut` est positionné à la main par l'utilisateur : rien dans ce périmètre ne
publie, donc rien ne le met à jour automatiquement.

Ajoutée à `defaultData()` dans `storage.js`, **et à `RECORD_KEYS` dans
`firestoreSync.js`**.

Ce second point est obligatoire, contrairement à ce que ce document affirmait
initialement : `firestoreSync.js` n'itère pas sur les clés de `data`, il
transporte deux listes explicites — `META_KEYS` et `RECORD_KEYS`. Une clé
absente des deux est silencieusement perdue au passage d'un appareil à l'autre.
Vérifié par un test qui échouait avec `obtenu undefined` avant la correction.

Volume : deux à trois kilo-octets par rédaction. Sans rapport avec la limite
d'un mégaoctet par document Firestore.

### Réglages du générateur

Une clé de premier niveau `reglagesAnnonce`, saisie une fois et surchargeable
par annonce : `critereContrat`, `ratioRevenus` (défaut `3`), `modalitesVisite`,
`canalContact`. Ajoutée à `defaultData()` et à `META_KEYS`.

**Clé séparée plutôt que champs ajoutés à `sci`** : la fusion de
`Storage.load()` est superficielle (`Object.assign(defaultData(), parsed)`), si
bien qu'un `sci` déjà enregistré remplace l'objet par défaut **en bloc**. Des
champs ajoutés à `sci` resteraient donc indéfinis sur toute donnée existante,
et `ratioRevenus` n'aurait jamais sa valeur par défaut. Une clé de premier
niveau bénéficie au contraire de la fusion.

## Le module `js/annonce.js`

### Contrat

```js
construireAnnonce(bien, redaction, reglagesSci)
// → { texte: string, avertissements: [{ champ, gravite, message }] }
```

Fonction pure : ni DOM, ni IndexedDB, ni réseau.

### Ordre du texte produit

1. Titre
2. **Bloc « le logement » — généré**
3. Texte libre, restitué sans modification
4. Bloc performance énergétique — généré
5. Bloc conditions financières — généré
6. Bloc candidature et visite — généré

### Contenu des blocs générés

**Le logement** — résumé factuel placé avant le descriptif : type de bien,
surface habitable, nombre de pièces et de chambres, année et norme de
construction, puis une ligne par équipement renseigné (chauffage, eau chaude,
**climatisation**, stationnement, extérieurs, annexes).

Ce bloc a été ajouté après coup : la première version du spec listait ces
champs sans qu'aucun bloc ne les utilise. Dix des dix-huit caractéristiques
étaient donc saisies, stockées et synchronisées **sans jamais apparaître dans
l'annonce**. Le défaut est apparu quand il a fallu ajouter la climatisation,
qui n'avait nulle part où aller.

La surface habitable est annoncée ici et **pas** dans le bloc financier, pour
éviter de la répéter. L'année de construction s'écrit « année 2016 » et non
« construite en 2016 » : le participe devrait s'accorder avec un type de bien
que l'utilisateur saisit librement.

**Performance énergétique** — classes DPE et GES, consommation en kWh/m²/an,
date de réalisation du diagnostic, fourchette des dépenses annuelles d'énergie
et année de référence des prix.

La date de réalisation du DPE et l'année de référence des prix de l'énergie
sont deux données distinctes : un diagnostic réalisé en octobre 2025 peut
porter des prix indexés au 1er janvier 2023.

**Conditions financières** — loyer hors charges, montant et modalité des
charges (provision avec régularisation annuelle) et leur objet, charges restant
au locataire, dépôt de garantie, surface habitable, commune, date de
disponibilité, honoraires le cas échéant.

**Candidature et visite** — critère de contrat, revenu minimum calculé depuis
`ratioRevenus` et le loyer hors charges, modalités de visite, canal de contact.

### Avertissements

Deux niveaux.

**Bloquant** — mention légale absente : surface habitable, classe DPE, classe
GES, fourchette de dépenses énergétiques, année de référence des prix, loyer,
montant et modalité des charges, dépôt de garantie, commune, date de
disponibilité.

**Attention** — qualité, sans blocage : mention « environ » à proximité d'une
surface dans le texte libre, diagnostic de plus de dix ans, descriptif de moins
de 300 caractères, et **répétition** — un motif de loyer, de DPE, de caution,
de critère de candidature ou de visite détecté dans le texte libre alors qu'il
figure déjà dans un bloc généré.

Le bouton de copie reste actif malgré les bloquants : la décision de publier
appartient à l'utilisateur. Les avertissements s'affichent au-dessus du
résultat et leur nombre apparaît sur le bouton.

## Interface

### Navigation

Un groupe déroulant ajouté en fin de `<nav>`, construit comme les cinq groupes
existants :

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

Une seule entrée pour l'instant. Le groupe accueillera les vues des sous-projets
suivants.

### Écran Publication

Quatre blocs sur une page.

1. **Choix du bien** — sélection du bien, liste de ses rédactions, actions
   « Nouvelle » et « Dupliquer ».
2. **Caractéristiques du bien** — repliable, replié par défaut une fois rempli.
   La saisie a lieu ici mais **écrit dans `data.biens`**. La modale de la fiche
   Bien n'est pas modifiée.
3. **Rédaction** — titre, texte libre, loyer et charges, détail des charges,
   dépôt, disponibilité, photos.
4. **Résultat** — texte assemblé, avertissements au-dessus, boutons « Copier
   l'annonce » et « Exporter les photos ».

### Distribution des pièces

Le bloc de rédaction propose de pré-remplir le texte libre avec la liste des
pièces issues de `bienGabarits`.

**Décision : `bienGabarits` n'est pas modifié.** Ses pièces portent un nom et un
type, pas de surface ; le pré-remplissage fournit donc les noms sans les mètres
carrés, que l'utilisateur complète dans le texte libre. Ajouter une surface aux
pièces du gabarit toucherait aux états des lieux, qui fonctionnent et ne sont
pas couverts par des tests. Ce sera reconsidéré si le besoin se confirme à
l'usage.

## Photos

Aucune brique de stockage nouvelle. `FilesDb.saveFile` écrit dans IndexedDB
puis envoie vers Firebase Storage, avec reprise via `qf_pending_uploads` en cas
d'échec réseau. Seul le `fileId` figure dans les données synchronisées : les
photos ne transitent jamais par Firestore.

**Redimensionnement avant stockage** : 1920 px sur le grand côté, JPEG qualité
0,85, via `canvas`. Une photo de téléphone passe d'environ 6 Mo à 400 Ko, sans
différence visible en ligne.

**Ordre** : la première photo sert de vignette. Réordonnancement par boutons
monter/descendre, plus fiable au doigt que le glisser-déposer. Pas de légende :
le formulaire de dépôt n'en accepte pas.

**Export** : archive ZIP via `js/vendor/jszip.min.js`, déjà embarqué. Les
fichiers sont préfixés par leur rang (`01-facade.jpg`, `02-sejour.jpg`) pour que
l'envoi manuel conserve l'ordre.

## Gestion des erreurs

| Situation | Comportement |
|---|---|
| Fichier non-image ou supérieur à 15 Mo | Refus avant stockage, message explicite |
| `FilesDb.getFile` renvoie `null` | Photo signalée manquante, annonce utilisable |
| Échec d'envoi vers Storage | Couvert par la file `qf_pending_uploads` existante |
| Bien supprimé, rédactions orphelines | Affichage « Bien supprimé », comme pour les locataires |
| Bien sans caractéristiques renseignées | Génération possible, avertissements bloquants affichés |

## Tests

Fichier `tests/annonce.test.js`, lancé par `node tests/annonce.test.js`, sur le
modèle de `tests/syncLogic.test.js` : chargement du module par `vm`, sans
navigateur, sans réseau, sans Firebase.

- **Cas de référence** : un bien complet produit un texte attendu, comparé
  intégralement. Toute altération d'un bloc légal fait échouer le test.
- **Un test par mention obligatoire** : retirer la donnée déclenche
  l'avertissement bloquant correspondant.
- **Détection de répétition** : un texte libre contenant un montant de loyer
  déclenche l'avertissement de doublon.
- **Restitution du texte libre** : le descriptif fourni ressort identique,
  caractère pour caractère.

## Hors périmètre

- Publication automatisée sur Leboncoin.
- Récupération des messages et réponses automatiques.
- Locations meublées, baux commerciaux, parkings.
- Communes soumises à l'encadrement des loyers.
- Aperçu mis en page et export PDF de l'annonce.
- Modification de `bienGabarits` et des états des lieux.
