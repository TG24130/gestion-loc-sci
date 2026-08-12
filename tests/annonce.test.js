// Tests de la génération d'annonce (js/annonce.js).
//
// Ils tournent SANS navigateur, SANS réseau et SANS Firebase : le module est
// pur et n'a aucune dépendance. C'est la seule protection des mentions
// légales obligatoires, le projet n'ayant ni intégration continue ni
// environnement de test — sans eux, une erreur se découvrirait sur une
// annonce déjà publiée.
//
// Lancer :  node tests/annonce.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- Chargement du module ----------

function loadAnnonceModule() {
  const file = path.join(__dirname, '..', 'js', 'annonce.js');
  const src = fs.readFileSync(file, 'utf8');

  // Le module ne doit contenir aucun import ES : il est chargé par une balise
  // <script> classique, pas en type="module".
  if (/^import\s/m.test(src)) {
    throw new Error('js/annonce.js contient un import ES — il ne serait chargeable ni par le navigateur ni ici.');
  }

  const sandbox = { console, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'annonce.js' });

  if (!sandbox.window.QfAnnonce) {
    throw new Error('js/annonce.js n\'expose pas window.QfAnnonce (une const de haut niveau serait invisible ici).');
  }
  return sandbox.window.QfAnnonce;
}

const QfAnnonce = loadAnnonceModule();

// ---------- Micro-harnais ----------

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n         -> ' + detail : '')); }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, 'attendu ' + e + ', obtenu ' + a);
}

function bloquants(res) {
  return res.avertissements.filter((a) => a.gravite === 'bloquant').map((a) => a.champ);
}

function attentions(res) {
  return res.avertissements.filter((a) => a.gravite === 'attention').map((a) => a.champ);
}

// ---------- Jeu de données de référence ----------
//
// Le bien réel de Bergerac. Le descriptif est celui rédigé par l'utilisateur,
// débarrassé des six lignes finales devenues des blocs générés (loyer,
// charges, ordures, caution, critères, visites) : c'est exactement l'état
// attendu après reprise d'une annonce existante.

const DESCRIPTIF = [
  'Année 2016, norme RT 2012.',
  'Dans un quartier calme, proche tous commerces, collège/lycée Saint-Front à 300 m.',
  'École primaire à 700 m, gare à 500 m, supermarchés à 200 m.',
  'Dans une petite résidence de 5 maisons accolées non mitoyennes.',
  'Très agréable maison à ossature bois, 3 chambres, 1 place de parking privative.',
  'Terrasse avec pergola et jardinet exposés sud.',
  'Au rez-de-chaussée : entrée desservant une chambre de 13 m², une salle d\'eau avec WC',
  'et douche à l\'italienne, norme PMR, cuisine équipée ouverte sur pièce à vivre (30 m²)',
  'exposée sud et donnant sur la terrasse et le jardinet.',
  'À l\'étage : dégagement, WC, 2 chambres de 12 et 15 m², dressing ou bureau de 4 m².',
  'Local vélo et local poubelles.',
  'Isolation renforcée en laine de bois et ouate de cellulose, peinture naturelle.',
  'Chauffage et eau chaude sanitaire par chaudière gaz à condensation.',
  '2 panneaux photovoltaïques sur toiture.',
].join('\n');

function bienRef() {
  return {
    id: 'b1',
    nom: 'Maison Bergerac',
    adresse: '15 rue des Acacias\n24100 Bergerac',
    surfaceHabitable: 95,
    dpeClasse: 'B',
    gesClasse: 'B',
    dpeConsommation: 61,
    dpeDateRealisation: '2025-10',
    energieCoutMin: 650,
    energieCoutMax: 950,
    energieAnneeReference: 2023,
  };
}

function redactionRef() {
  return {
    id: 'a1',
    bienId: 'b1',
    titre: 'À louer proche centre-ville Bergerac, maison F4 de 95 m²',
    texteLibre: DESCRIPTIF,
    loyer: 755,
    charges: 35,
    chargesDetail: [
      'l\'entretien annuel de la chaudière',
      'l\'électricité des communs',
      'la tonte des jardins',
    ],
    chargesResteACharge: 'La taxe d\'enlèvement des ordures ménagères',
    depotGarantie: 755,
    disponibleLe: '2026-10-01',
    honoraires: 0,
    photos: [],
  };
}

function reglagesRef() {
  return {
    critereContrat: 'CDI',
    ratioRevenus: 3,
    modalitesVisite: 'Visites sur rendez-vous le samedi matin.',
    canalContact: 'Premier contact par mail.',
  };
}

function construire(modifBien, modifRedaction, modifReglages) {
  const bien = Object.assign(bienRef(), modifBien || {});
  const redaction = Object.assign(redactionRef(), modifRedaction || {});
  const reglages = Object.assign(reglagesRef(), modifReglages || {});
  return QfAnnonce.construireAnnonce(bien, redaction, reglages);
}

// ---------- 1. Cas de référence ----------

console.log('\n-- Cas de référence --');

const TEXTE_ATTENDU = [
  'À louer proche centre-ville Bergerac, maison F4 de 95 m²',
  '',
  DESCRIPTIF,
  '',
  'Performance énergétique : DPE classe B — GES classe B.',
  'Consommation : 61 kWh/m²/an. Diagnostic réalisé en octobre 2025.',
  'Montant estimé des dépenses annuelles d\'énergie pour un usage standard : entre 650 € et 950 € par an. Prix moyens des énergies indexés au 1er janvier 2023.',
  '',
  'Loyer mensuel : 755 € hors charges.',
  'Provision mensuelle sur charges : 35 €, régularisation annuelle, couvrant l\'entretien annuel de la chaudière, l\'électricité des communs et la tonte des jardins.',
  'La taxe d\'enlèvement des ordures ménagères à la charge du locataire.',
  'Dépôt de garantie : 755 € (un mois de loyer hors charges).',
  'Surface habitable : 95 m². Logement situé à Bergerac (24100).',
  'Disponible à compter du 1er octobre 2026.',
  'Aucun honoraire de location (location en direct).',
  '',
  'Candidature : justificatif de CDI et revenus nets mensuels d\'au moins 2 265 € (trois fois le loyer hors charges).',
  'Visites sur rendez-vous le samedi matin. Premier contact par mail.',
].join('\n');

const ref = construire();

check('le texte produit est exactement celui attendu', ref.texte === TEXTE_ATTENDU,
  'obtenu :\n---\n' + ref.texte + '\n---');
eq('une annonce complète ne produit aucun avertissement', ref.avertissements, []);

// ---------- 2. Le texte libre est restitué intact ----------

console.log('\n-- Restitution du descriptif --');

check('le descriptif ressort caractère pour caractère', ref.texte.indexOf(DESCRIPTIF) !== -1,
  'le descriptif a été altéré');

const bizarre = 'Ligne 1\n\n  Ligne 3 indentée\tavec tabulation\nŒuf, cœur, à côté — « guillemets »…';
const resBizarre = construire(null, { texteLibre: bizarre });
check('accents, tabulations, lignes vides et typographie sont préservés',
  resBizarre.texte.indexOf(bizarre) !== -1,
  'obtenu :\n---\n' + resBizarre.texte + '\n---');

// ---------- 3. Une mention obligatoire absente = un bloquant ----------

console.log('\n-- Mentions obligatoires --');

eq('surface habitable absente', bloquants(construire({ surfaceHabitable: null })), ['surfaceHabitable']);
eq('surface habitable à zéro', bloquants(construire({ surfaceHabitable: 0 })), ['surfaceHabitable']);
eq('classe DPE absente', bloquants(construire({ dpeClasse: '' })), ['dpeClasse']);
eq('classe GES absente', bloquants(construire({ gesClasse: '' })), ['gesClasse']);
eq('année de référence des prix absente', bloquants(construire({ energieAnneeReference: null })), ['energieAnneeReference']);
eq('estimation des dépenses absente',
  bloquants(construire({ energieCoutMin: null, energieCoutMax: null })), ['energieCout']);
eq('loyer absent', bloquants(construire(null, { loyer: null })), ['loyer']);
eq('charges absentes', bloquants(construire(null, { charges: null })), ['charges']);
eq('dépôt de garantie absent', bloquants(construire(null, { depotGarantie: null })), ['depotGarantie']);
eq('date de disponibilité absente', bloquants(construire(null, { disponibleLe: '' })), ['disponibleLe']);
eq('commune introuvable dans l\'adresse',
  bloquants(construire({ adresse: '15 rue des Acacias' })), ['commune']);

const vide = QfAnnonce.construireAnnonce({}, {}, {});
check('un bien entièrement vide signale les dix mentions obligatoires',
  bloquants(vide).length === 10, 'obtenu ' + JSON.stringify(bloquants(vide)));

// ---------- 4. Valeurs nulles légitimes ----------

console.log('\n-- Zéro n\'est pas « absent » --');

const sansCharges = construire(null, { charges: 0 });
eq('charges à zéro : aucun bloquant', bloquants(sansCharges), []);
check('charges à zéro : mention explicite', sansCharges.texte.indexOf('Aucune provision sur charges.') !== -1);

const sansDepot = construire(null, { depotGarantie: 0 });
eq('dépôt à zéro : aucun bloquant', bloquants(sansDepot), []);
check('dépôt à zéro : mention explicite', sansDepot.texte.indexOf('Aucun dépôt de garantie.') !== -1);

// ---------- 5. Détection des répétitions ----------

console.log('\n-- Répétitions avec les blocs générés --');

check('un loyer dans le descriptif est signalé',
  attentions(construire(null, { texteLibre: DESCRIPTIF + '\nLoyer mensuel 755 euros.' }))
    .indexOf('texteLibre.loyer') !== -1);
check('une caution dans le descriptif est signalée',
  attentions(construire(null, { texteLibre: DESCRIPTIF + '\nCaution un mois.' }))
    .indexOf('texteLibre.depot') !== -1);
check('un DPE dans le descriptif est signalé',
  attentions(construire(null, { texteLibre: DESCRIPTIF + '\nDPE B/B.' }))
    .indexOf('texteLibre.dpe') !== -1);
check('des critères de candidature dans le descriptif sont signalés',
  attentions(construire(null, { texteLibre: DESCRIPTIF + '\nJustifier d\'un CDI.' }))
    .indexOf('texteLibre.candidature') !== -1);
check('des modalités de visite dans le descriptif sont signalées',
  attentions(construire(null, { texteLibre: DESCRIPTIF + '\nVisites le samedi.' }))
    .indexOf('texteLibre.visite') !== -1);
eq('le descriptif de référence ne déclenche aucune répétition', attentions(ref), []);

// ---------- 6. Contrôles de qualité ----------

console.log('\n-- Qualité du descriptif --');

check('« 95 m2 environ » est signalé',
  attentions(construire(null, { texteLibre: DESCRIPTIF + '\nMaison de 95 m2 environ.' }))
    .indexOf('texteLibre.surface') !== -1);
check('« environ 95 m² » est signalé',
  attentions(construire(null, { texteLibre: DESCRIPTIF + '\nMaison de environ 95 m².' }))
    .indexOf('texteLibre.surface') !== -1);
check('un descriptif exact n\'est pas signalé',
  attentions(construire(null, { texteLibre: DESCRIPTIF + '\nMaison de 95 m².' }))
    .indexOf('texteLibre.surface') === -1);
check('un descriptif trop court est signalé',
  attentions(construire(null, { texteLibre: 'Petite maison.' })).indexOf('texteLibre') !== -1);
check('un diagnostic de plus de dix ans est signalé',
  attentions(construire({ dpeDateRealisation: '2010-05' })).indexOf('dpeDateRealisation') !== -1);
check('un diagnostic récent n\'est pas signalé',
  attentions(ref).indexOf('dpeDateRealisation') === -1);

// ---------- 7. Formatage ----------

console.log('\n-- Formatage --');

check('les milliers sont séparés par une espace',
  construire(null, { loyer: 1200 }).texte.indexOf('Loyer mensuel : 1 200 € hors charges.') !== -1);
check('les centimes utilisent la virgule',
  construire(null, { charges: 35.5 }).texte.indexOf('Provision mensuelle sur charges : 35,50 €') !== -1);
check('un coût énergétique unique s\'écrit « environ »',
  construire({ energieCoutMin: 800, energieCoutMax: 800 }).texte
    .indexOf('usage standard : environ 800 € par an.') !== -1);
check('un dépôt de deux mois est explicité',
  construire(null, { depotGarantie: 1510 }).texte
    .indexOf('Dépôt de garantie : 1 510 € (deux mois de loyer hors charges).') !== -1);
check('un dépôt non multiple du loyer reste un montant seul',
  construire(null, { depotGarantie: 900 }).texte
    .indexOf('Dépôt de garantie : 900 €.') !== -1);
check('le premier du mois s\'écrit « 1er »',
  ref.texte.indexOf('Disponible à compter du 1er octobre 2026.') !== -1);
check('les autres jours s\'écrivent en chiffres',
  construire(null, { disponibleLe: '2026-10-15' }).texte
    .indexOf('Disponible à compter du 15 octobre 2026.') !== -1);
check('des honoraires non nuls sont annoncés TTC',
  construire(null, { honoraires: 450 }).texte
    .indexOf('Honoraires de location à la charge du locataire : 450 € TTC.') !== -1);
check('le revenu minimum suit le ratio configuré',
  construire(null, null, { ratioRevenus: 4 }).texte
    .indexOf('au moins 3 020 € (quatre fois le loyer hors charges)') !== -1);

// ---------- Bilan ----------

console.log('\n' + passed + ' réussis, ' + failed + ' échoués.');
process.exit(failed === 0 ? 0 : 1);
