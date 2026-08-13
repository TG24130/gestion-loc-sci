// Tests des calculs et textes de candidature (js/candidature.js).
//
// Sans navigateur, sans réseau, sans Firebase : le module est pur.
//
// Lancer :  node tests/candidature.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadModule() {
  const file = path.join(__dirname, '..', 'js', 'candidature.js');
  const src = fs.readFileSync(file, 'utf8');
  if (/^import\s/m.test(src)) {
    throw new Error('js/candidature.js contient un import ES — il ne serait chargeable ni par le navigateur ni ici.');
  }
  const sandbox = { console, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'candidature.js' });
  if (!sandbox.window.QfCandidature) {
    throw new Error('js/candidature.js n\'expose pas window.QfCandidature (une const de haut niveau serait invisible ici).');
  }
  return sandbox.window.QfCandidature;
}

const Q = loadModule();

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

function champs(res) {
  return res.alertes.map((a) => a.champ);
}

// Le bien de Bergerac : 755 € hors charges, 35 € de provision.
const BIEN = { id: 'b1', nom: 'Maison Bergerac', loyer: 755, charges: 35 };
const REGLAGES = { ratioRevenus: 3 };

function indic(candidature, bien, reglages) {
  return Q.calculerIndicateurs(candidature, bien || BIEN, reglages || REGLAGES);
}

// ---------- 1. Indicateurs ----------

console.log('\n-- Indicateurs --');

const solide = indic({ ressources: 2600, chargesDeclarees: 0 });
check('taux d\'effort calculé sur loyer + charges',
  Math.abs(solide.tauxEffort - (790 / 2600)) < 1e-9,
  'obtenu ' + solide.tauxEffort);
eq('reste à vivre sans charges déclarées', solide.resteAVivre, 2600 - 790);
check('ratio calculé sur le loyer hors charges',
  Math.abs(solide.ratioLoyer - (2600 / 755)) < 1e-9);
eq('un dossier solide ne déclenche aucune alerte', champs(solide), []);

// Le cas qui motive tout l'écran : mêmes ressources, dossiers différents.
const sansCredit = indic({ ressources: 2400, chargesDeclarees: 0 });
const avecCredit = indic({ ressources: 2400, chargesDeclarees: 600 });
eq('même ratio pour les deux',
  [sansCredit.ratioLoyer, avecCredit.ratioLoyer],
  [2400 / 755, 2400 / 755]);
check('le reste à vivre les sépare de 600 €',
  sansCredit.resteAVivre - avecCredit.resteAVivre === 600,
  sansCredit.resteAVivre + ' vs ' + avecCredit.resteAVivre);

// ---------- 2. Alertes ----------

console.log('\n-- Alertes --');

const sousRatio = indic({ ressources: 2000, chargesDeclarees: 0 });
check('ressources sous le ratio exigé', champs(sousRatio).indexOf('ratioLoyer') !== -1);
check('le message chiffre le ratio atteint',
  sousRatio.alertes.some((a) => a.champ === 'ratioLoyer' && a.message.indexOf('2.6') !== -1),
  JSON.stringify(sousRatio.alertes));

const noye = indic({ ressources: 1200, chargesDeclarees: 500 });
check('reste à vivre négatif signalé comme bloquant',
  noye.alertes.some((a) => a.champ === 'resteAVivre' && a.gravite === 'bloquant'));

const pile = indic({ ressources: 1290, chargesDeclarees: 500 });
eq('reste à vivre exactement nul', pile.resteAVivre, 0);
check('un reste à vivre nul est aussi bloquant',
  champs(pile).indexOf('resteAVivre') !== -1);

const ratioLimite = indic({ ressources: 755 * 3, chargesDeclarees: 0 });
check('pile au ratio exigé : pas d\'alerte de ratio',
  champs(ratioLimite).indexOf('ratioLoyer') === -1);

// ---------- 3. Ressources absentes ----------

console.log('\n-- Ressources absentes --');

[undefined, null, '', 0].forEach((valeur) => {
  const res = indic({ ressources: valeur });
  const etiquette = valeur === '' ? '(vide)' : String(valeur);
  eq('ressources ' + etiquette + ' : indicateurs à null',
    [res.tauxEffort, res.resteAVivre, res.ratioLoyer], [null, null, null]);
  check('ressources ' + etiquette + ' : alerte explicite',
    champs(res).indexOf('ressources') !== -1);
});

check('aucune division par zéro sur un bien sans loyer',
  indic({ ressources: 2000 }, { nom: 'X', loyer: 0, charges: 0 }).ratioLoyer === null);

// ---------- 4. Mail de refus ----------

console.log('\n-- Mail de refus --');

const mail = Q.construireMailRefus(
  { nom: 'Marie Dupont' },
  BIEN,
  { gerant: 'Thierry Grenier', nom: 'SCI GP2IE' }
);

check('l\'objet nomme le bien', mail.objet.indexOf('Maison Bergerac') !== -1, mail.objet);
check('le corps s\'adresse au candidat', mail.corps.indexOf('Marie Dupont') !== -1);
check('le corps nomme le bien', mail.corps.indexOf('Maison Bergerac') !== -1);
check('le corps est signé', mail.corps.indexOf('Thierry Grenier') !== -1);
check('le corps ne se termine pas par des lignes vides', !/\n\s*$/.test(mail.corps));

// LE test qui compte : aucun motif de refus, sous aucune forme.
const INTERDITS = [
  'revenu', 'ressource', 'salaire', 'insuffisant', 'faible', 'crédit', 'dette',
  'enfant', 'famille', 'marié', 'concubin', 'animal', 'chien', 'chat',
  'origine', 'nationalité', 'âge', 'garant', 'dossier incomplet', 'CDI', 'contrat',
];
const trouves = INTERDITS.filter((mot) => mail.corps.toLowerCase().indexOf(mot.toLowerCase()) !== -1);
eq('le mail ne contient AUCUN motif de refus', trouves, []);

const mailAnonyme = Q.construireMailRefus({}, BIEN, {});
check('sans nom, une formule de politesse neutre',
  mailAnonyme.corps.indexOf('Madame, Monsieur') !== -1);
check('sans gérant, pas de ligne de signature vide',
  !/\n\s*\n\s*$/.test(mailAnonyme.corps), JSON.stringify(mailAnonyme.corps.slice(-40)));

// ---------- 5. Créneaux de visite ----------

console.log('\n-- Créneaux de visite --');

eq('cinq visites de 30 minutes depuis 9h',
  Q.calculerCreneaux('09:00', 30, 5),
  ['09:00', '09:30', '10:00', '10:30', '11:00']);
eq('le passage d\'heure est correct',
  Q.calculerCreneaux('11:45', 30, 3),
  ['11:45', '12:15', '12:45']);
eq('une durée non standard fonctionne',
  Q.calculerCreneaux('09:00', 45, 4),
  ['09:00', '09:45', '10:30', '11:15']);
eq('un seul candidat', Q.calculerCreneaux('10:00', 30, 1), ['10:00']);
eq('aucun candidat : liste vide', Q.calculerCreneaux('09:00', 30, 0), []);
eq('heure invalide : liste vide', Q.calculerCreneaux('9h00', 30, 3), []);
eq('durée nulle : liste vide', Q.calculerCreneaux('09:00', 0, 3), []);
eq('heure sur un chiffre acceptée', Q.calculerCreneaux('9:00', 60, 2), ['09:00', '10:00']);

console.log('\n' + passed + ' réussis, ' + failed + ' échoués.');
process.exit(failed === 0 ? 0 : 1);
