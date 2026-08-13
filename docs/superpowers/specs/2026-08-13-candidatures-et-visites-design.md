# Candidatures et visites — design

Date : 2026-08-13
Statut : validé, prêt pour le plan d'implémentation
Suite de `2026-08-12-generateur-annonce-location-design.md`

## Objectif

Gérer, depuis l'application, ce qui se passe entre la publication d'une annonce
et la visite : recevoir les candidatures, comparer les dossiers, refuser
proprement, et organiser les visites d'un samedi matin.

## Périmètre

Le suivi s'arrête au **planning de visite**. Le choix du locataire, la rédaction
du bail et l'état des lieux restent le parcours existant de l'application, fait
à la main après la visite.

Volume attendu pour un bien : 15 à 20 demandes, 8 à 10 dossiers complets, 5 à 6
visites.

## Usage attendu

```
Annonce publiée
      ↓
Les demandes arrivent par mail, avec les pièces
      ↓
[CANDIDATURES]  une fiche par personne
                coordonnées, ressources, charges déclarées, pièces
                → taux d'effort et reste à vivre calculés
      ↓
   ┌──┴───────────────────────────┐
Retenue                        Refusée
   │                              │
pièces conservées          mail de refus proposé
   │                       pièces effacées
   ↓
Prise de rendez-vous par téléphone
   ↓
[VISITES]  planning du samedi matin, créneaux enchaînés
```

Les pièces sont **importées à la main** : l'application est un client statique,
elle ne peut pas relever une boîte mail. À raison de 8 à 10 dossiers par bien,
le coût reste acceptable.

## Modèle de données

### `candidatures[]`

```js
{
  id, bienId,
  nom, telephone, email,
  dateReception,
  statut,              // recue | dossier-recu | retenue | refusee
  ressources,          // total mensuel déclaré
  chargesDeclarees,    // crédits, pensions… déclarés
  pieces: [{ fileId, type, nom }],
  notes,
  dateDecision
}
```

`type` reprend les catégories du décret 2015-1437 : `identite`,
`bulletins-salaire`, `avis-imposition`, `justificatif-domicile`.

Les pièces arrivent en **formats variés** : PDF, Word, PNG, JPG — chaque
candidat envoie ce qu'il a sous la main.

Formats acceptés : `image/*` (dont HEIC d'iPhone), `application/pdf`, Word
(`.doc`, `.docx`) et OpenDocument (`.odt`). Tout le reste est refusé — une
archive, un exécutable ou une vidéo n'a rien à faire dans un dossier de
candidature.

Seules les **images** sont réduites avant enregistrement, par le
`resizeImageFile` existant. Il tolère déjà un format qu'il ne sait pas décoder :
il conserve alors le fichier d'origine. Les documents sont stockés tels quels,
aucun traitement n'étant possible côté client sans dépendance supplémentaire.

Conséquence sur l'aperçu : un PDF et une image s'affichent dans le navigateur,
un `.docx` non — il sera proposé au téléchargement. `openStoredFile` gère déjà
ce repli pour les pièces existantes de l'application.

### `visites[]`

```js
{
  id, bienId,
  date,                // le samedi retenu
  heureDebut,          // "09:00"
  dureeCreneau,        // en minutes
  creneaux: [{ candidatureId, heure }]
}
```

L'ordre du tableau `creneaux` fait foi ; `heure` est recalculée à chaque
modification, comme `ordre` pour les photos d'annonce.

### Les quatre endroits à mettre à jour

Deux collections nouvelles, donc quatre listes de clés explicites à compléter.
Une seule oubliée et la donnée disparaît en silence :

| Fichier | Liste | Conséquence d'un oubli |
|---|---|---|
| `js/storage.js` | `defaultData()` | La clé n'existe pas au démarrage |
| `js/firestoreSync.js` | `RECORD_KEYS` | Pas de synchronisation entre appareils |
| `js/app.js`, export `.zip` | boucles par collection | Absent de la sauvegarde |
| `js/app.js`, imports JSON et ZIP | `Object.assign` | Non restauré |

Les pièces suivent le chemin `FilesDb` : IndexedDB puis Firebase Storage. Elles
ne transitent jamais par Firestore. Comme pour les photos d'annonce, elles
vivent sous `pieces` et non `files`, donc `filesOf()` ne les voit pas : l'export
doit les lui présenter explicitement.

## Le module `js/candidature.js`

Même forme qu'`annonce.js` : IIFE exposant `window.QfCandidature`, sans DOM ni
réseau, testable par `node tests/candidature.test.js`.

```js
calculerIndicateurs(candidature, bien)
// → { tauxEffort, resteAVivre, ratioLoyer, alertes: [] }

construireMailRefus(candidature, bien, sci)
// → { objet, corps }

calculerCreneaux(heureDebut, dureeCreneau, nombre)
// → ["09:00", "09:30", …]
```

### Indicateurs

```
loyerTotal  = bien.loyer + bien.charges
tauxEffort  = loyerTotal / ressources
resteAVivre = ressources − chargesDeclarees − loyerTotal
ratioLoyer  = ressources / bien.loyer
```

Le ratio seul ne suffit pas : deux candidats à 2 400 € de ressources ne se
valent pas si l'un rembourse 600 € de crédit par mois. Le reste à vivre les
sépare, le ratio les confond.

### Mail de refus

Volontairement sobre : remerciement, information que la candidature n'est pas
retenue, rien d'autre. **Aucun motif détaillé** — un motif mal formulé
(situation de famille, origine des revenus, animal) se lit comme
discriminatoire, alors qu'un refus n'a pas à être justifié.

L'application **ne l'envoie pas** : objet et corps sont affichés et copiables
dans le presse-papier, comme le texte de l'annonce. L'utilisateur relit, colle
dans son client mail et envoie lui-même.

## Écrans

### Candidatures

Liste filtrée par bien, triable par taux d'effort et reste à vivre. Chaque fiche
porte les coordonnées, les montants déclarés, les pièces importées et les
indicateurs calculés.

Trois actions : **Retenir**, **Refuser**, **Supprimer**.

### Visites

Choix du bien, de la date, de l'heure de début et de la durée d'un créneau. Les
candidatures au statut `retenue` sont placées à la suite. Réordonnancement par
boutons monter/descendre, comme les photos. Une sortie imprimable ou copiable
pour avoir la liste sur soi le jour des visites.

## Fiche de renseignements

L'application génère la fiche à remplir par les candidats, en PDF, depuis les
données du bien — adresse, loyer, charges, dépôt de garantie. Elle réutilise
`pdfBuilder.js`, comme les quittances.

Deux champs sont retirés, un troisième est conservé après vérification :

- **Régime matrimonial** et **lieu de mariage** — l'article 1751 du Code civil
  rend les époux cotitulaires du bail **quel que soit leur régime**. L'information
  utile est le statut du couple (marié, pacsé, concubin, seul), déjà collectée
  par le champ « situation familiale ». Le contrat de mariage figure d'ailleurs
  parmi les documents dont la remise est interdite.
- **Remboursement de prêts** est **conservé** en déclaratif : c'est le
  justificatif — attestation d'absence de crédit, attestation bancaire — qui est
  interdit, pas le renseignement. Aucune pièce ne peut être exigée à l'appui.

Les pièces demandées par la fiche actuelle sont conformes au décret 2015-1437 et
restent inchangées : quittances ou taxe foncière, trois bulletins de salaire,
deux avis d'imposition, pièce d'identité recto-verso.

## Données personnelles

Un dossier contient une pièce d'identité, des bulletins de salaire et des avis
d'imposition. Trois à quatre candidats par bien ne seront jamais revus.

**Au refus, les pièces sont effacées** d'IndexedDB et de Firebase Storage. La
fiche est conservée — nom, contact, date, décision — pour garder trace de qui a
déjà candidaté. Aucune purge différée à déclencher, aucun stock à surveiller.

La suppression d'une candidature efface également ses pièces.

## Gestion des erreurs

| Situation | Comportement |
|---|---|
| Format hors liste acceptée, ou > 15 Mo | Refus avant stockage, message nommant le fichier et la raison |
| Image dans un format non décodable | Conservée telle quelle, sans réduction |
| `FilesDb.getFile` renvoie `null` | Pièce signalée manquante, fiche utilisable |
| Ressources à zéro ou absentes | Indicateurs masqués, pas de division par zéro |
| Bien supprimé, candidatures orphelines | Affichage « Bien supprimé » |
| Aucune candidature retenue | L'écran Visites l'indique au lieu d'un planning vide |

## Tests

`tests/candidature.test.js`, lancé par `node tests/candidature.test.js`, sur le
modèle de `tests/annonce.test.js`.

- Indicateurs : cas nominal, ressources nulles, charges déclarées nulles,
  candidat sous le ratio, deux candidats à ressources égales départagés par le
  reste à vivre.
- Créneaux : enchaînement correct, passage d'heure, durée non standard.
- Mail de refus : contient le nom et l'adresse du bien, **ne contient aucun
  motif** — un test vérifie l'absence de mots liés aux revenus, à la famille ou
  aux animaux.

## Hors périmètre

- Choix du locataire, bail, état des lieux — parcours existant.
- Toute relève automatique de boîte mail.
- L'envoi du mail de refus : l'application le rédige, l'utilisateur l'envoie.
- Le suivi des candidatures après la visite.
