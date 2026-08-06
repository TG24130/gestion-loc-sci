// Tests automatisés de la logique de synchronisation Firestore (js/firestoreSync.js).
//
// Ces tests tournent SANS réseau ni Firebase : le SDK est remplacé par un faux
// serveur en mémoire, ce qui permet de simuler deux appareils partageant le
// même compte et de rejouer les scénarios qui ont réellement causé des pertes
// de données en production.
//
// Lancer :  node tests/syncLogic.test.js
//
// Le module est chargé DEUX FOIS (une instance par appareil simulé) car il
// garde un état interne — c'est justement cet état (le "shadow", dernier état
// serveur connu) qui détermine ce qu'un appareil s'autorise à supprimer.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- Faux serveur Firestore partagé ----------

function createFakeServer() {
  return {
    store: new Map(),   // docId -> { c, i, j }
    listeners: [],      // fonctions de rappel des instantanés
    writeCount: 0,
    deleteCount: 0,
  };
}

function snapshotOf(server, fromCache) {
  const entries = Array.from(server.store.entries());
  return {
    metadata: { fromCache: !!fromCache, hasPendingWrites: false },
    forEach(fn) {
      entries.forEach(([id, value]) => fn({ id, data: () => value }));
    },
  };
}

// Délivre l'état courant du serveur à un appareil précis (ou à tous).
function deliver(server, only) {
  server.listeners.forEach((l) => {
    if (only && l.owner !== only) return;
    l.cb(snapshotOf(server, false));
  });
}

// ---------- Chargement du module avec le SDK Firebase simulé ----------

function loadSyncModule(server, owner) {
  const file = path.join(__dirname, '..', 'js', 'firestoreSync.js');
  let src = fs.readFileSync(file, 'utf8');
  // Retire les imports ES (CDN Firebase) : ils sont remplacés par des stubs.
  src = src.replace(/^import[\s\S]*?firebase-firestore\.js';\n/m, '');

  const sandbox = {
    console,
    window: {},
    firebaseApp: {},
    initializeFirestore: () => ({}),
    persistentLocalCache: () => ({}),
    persistentSingleTabManager: () => ({}),
    collection: () => ({ kind: 'col' }),
    doc: (col, id) => ({ id }),
    writeBatch: () => {
      const ops = [];
      return {
        set: (ref, value) => ops.push({ type: 'set', id: ref.id, value }),
        delete: (ref) => ops.push({ type: 'delete', id: ref.id }),
        commit: async () => {
          ops.forEach((op) => {
            if (op.type === 'set') { server.store.set(op.id, op.value); server.writeCount++; }
            else { server.store.delete(op.id); server.deleteCount++; }
          });
        },
      };
    },
    onSnapshot: (col, cb) => {
      const entry = { cb, owner };
      server.listeners.push(entry);
      // Firestore délivre d'abord un instantané depuis le cache local : le
      // module doit l'ignorer (c'est ce qui garantit qu'on ne prend jamais un
      // état périmé comme base de comparaison).
      cb(snapshotOf(server, true));
      return () => {
        const i = server.listeners.indexOf(entry);
        if (i >= 0) server.listeners.splice(i, 1);
      };
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'firestoreSync.js' });
  return sandbox.window.QfSync;
}

// ---------- Micro-harnais de test ----------

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

// ---------- Jeux de données ----------

function baseData() {
  return {
    schemaVersion: 1,
    sci: { nom: 'SCI GP2IE', adresse: '1 rue Test', ville: 'Bordeaux', gerant: 'Thierry', signature: '' },
    bailModele: '<p>Modèle de bail</p>',
    syncMeta: { updatedAt: '2026-08-06T10:00:00.000Z', updatedBy: 'devA' },
    biens: [
      { id: 'b1', nom: 'Maison 1', adresse: '1 rue A' },
      { id: 'b2', nom: 'Maison 2', adresse: '2 rue B' },
    ],
    locataires: [{ id: 'l1', nom: 'Dupont', bienId: 'b1', actif: true }],
    documents: [
      { id: 'd1', createdAt: 1000, type: 'quittance', locataireNom: 'Dupont', montant: 500, ctx: { loyer: 450, charges: 50 } },
      { id: 'd2', createdAt: 2000, type: 'quittance', locataireNom: 'Dupont', montant: 500, ctx: { loyer: 450, charges: 50 } },
    ],
    charges: [], baux: [], etatsDesLieux: [], documentsAdmin: [],
    documentsLocataires: [], credits: [], bailRedactions: [],
    facturesTravaux: [], bienGabarits: [],
    // Cas volontairement tordu : tableaux imbriqués dans des objets imbriqués,
    // exactement la forme des états des lieux rédigés.
    edlRedactions: [{
      id: 'e1', bienId: 'b1', sens: 'entrant', date: '2026-01-01',
      pieces: [{ nom: 'Cuisine', elements: [{ nom: 'Sol', etat: 'bon', files: [{ fileId: 'f1', fileName: 'a.jpg' }] }] }],
      compteurs: [{ nom: 'Eau', index: '123', files: [] }],
      cles: [{ nom: 'Entrée', nombre: 2, files: [] }],
    }],
    edlModeles: [],
  };
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// ---------- Tests ----------

async function run() {
  console.log('\n== 1. Aller-retour : ce qui est écrit est relu à l\'identique ==');
  {
    const server = createFakeServer();
    const A = loadSyncModule(server, 'A');
    A.start('uid1', () => {});
    deliver(server, 'A');                 // état serveur (vide) confirmé
    const data = baseData();
    await A.save('uid1', data);

    const docs = new Map(server.store);
    const rebuilt = A._internals.rebuild(docs);
    eq('sci préservé', rebuilt.sci, data.sci);
    eq('biens préservés', rebuilt.biens, data.biens);
    eq('documents préservés', rebuilt.documents, data.documents);
    eq('états des lieux (tableaux imbriqués) préservés', rebuilt.edlRedactions, data.edlRedactions);
    check('une fiche = un document Firestore',
      server.store.size === 1 + 2 + 1 + 2 + 1,
      'docs = ' + server.store.size + ' (attendu 7 : meta + 2 biens + 1 locataire + 2 documents + 1 EDL)');
    A.stop();
  }

  console.log('\n== 2. LE BUG D\'HIER : un appareil ne doit plus effacer ce qu\'il n\'a pas touché ==');
  {
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    const TEL = loadSyncModule(server, 'TEL');

    let pcData = baseData();
    let telData = baseData();

    PC.start('uid1', (remote) => { if (remote) pcData = remote; });
    TEL.start('uid1', (remote) => { if (remote) telData = remote; });
    deliver(server);                       // les deux voient le serveur vide

    await PC.save('uid1', pcData);         // état de départ commun poussé par le PC
    deliver(server);                       // les deux appareils sont à jour

    // Le téléphone crée un courrier libre et l'enregistre.
    telData.documents.push({ id: 'd3', createdAt: 3000, type: 'libre', locataireNom: 'Dupont', ctx: { objet: 'Test', message: 'Bonjour' } });
    await TEL.save('uid1', telData);

    check('le courrier du téléphone est bien dans le cloud',
      server.store.has('rec-documents-d3'));

    // Le PC, qui n'a PAS encore reçu ce courrier, enregistre une modification
    // sans rapport (le nom du gérant). C'est exactement ce qui a effacé la
    // fiche hier soir.
    pcData.sci.gerant = 'Thierry Grenier';
    await PC.save('uid1', pcData);

    check('le courrier du téléphone a SURVÉCU à l\'enregistrement du PC',
      server.store.has('rec-documents-d3'),
      'la fiche créée sur le téléphone a été effacée par le PC');
    check('la modification du PC est bien partie',
      JSON.parse(server.store.get('meta').j).sci.gerant === 'Thierry Grenier');

    // Et après réception, le PC voit le courrier du téléphone.
    deliver(server);
    check('le PC voit maintenant le courrier du téléphone',
      pcData.documents.some((d) => d.id === 'd3'),
      'documents PC = ' + JSON.stringify(pcData.documents.map((d) => d.id)));
    PC.stop(); TEL.stop();
  }

  console.log('\n== 3. Une vraie suppression reste une vraie suppression ==');
  {
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    let pcData = baseData();
    PC.start('uid1', (r) => { if (r) pcData = r; });
    deliver(server);
    await PC.save('uid1', pcData);
    deliver(server);

    pcData.biens = pcData.biens.filter((b) => b.id !== 'b2');
    await PC.save('uid1', pcData);

    check('le bien supprimé disparaît du cloud', !server.store.has('rec-biens-b2'));
    check('l\'autre bien est intact', server.store.has('rec-biens-b1'));
    PC.stop();
  }

  console.log('\n== 4. Tant que le serveur n\'a pas répondu, aucune suppression ==');
  {
    const server = createFakeServer();
    // Le serveur contient déjà une fiche créée ailleurs.
    server.store.set('rec-documents-dX', { c: 'documents', i: 0, j: JSON.stringify({ id: 'dX' }) });

    const PC = loadSyncModule(server, 'PC');
    // start() n'est PAS appelé : l'appareil n'a jamais vu l'état du serveur.
    await PC.save('uid1', baseData());
    check('la fiche distante inconnue n\'est pas supprimée', server.store.has('rec-documents-dX'));
    check('les fiches locales sont quand même envoyées', server.store.has('rec-biens-b1'));
  }

  console.log('\n== 5. Nettoyage des résidus des anciens schémas ==');
  {
    const server = createFakeServer();
    server.store.set('main', { c: 'legacy', i: 0, j: '{}' });
    server.store.set('documents_0', { c: 'legacy', i: 0, j: '{}' });

    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => {});
    deliver(server);
    await PC.save('uid1', baseData());

    check('ancien document "main" supprimé', !server.store.has('main'));
    check('ancien document "documents_0" supprimé', !server.store.has('documents_0'));
    check('les nouvelles fiches sont là', server.store.has('rec-biens-b1'));
    PC.stop();
  }

  console.log('\n== 6. Volume réaliste : aucune fiche n\'approche la limite de 1 Mo ==');
  {
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => {});
    deliver(server);

    const big = baseData();
    // ~2,5 Mo au total, l'ordre de grandeur des vraies données de l'utilisateur.
    big.documents = [];
    for (let i = 0; i < 900; i++) {
      big.documents.push({
        id: 'doc' + i, createdAt: 1000 + i, type: 'quittance', dateLabel: '01/01/2026',
        locataireNom: 'Locataire ' + i, montant: 500, periodeLabel: 'Janvier 2026',
        ctx: { loyer: 450, charges: 50, bailleurBlock: 'X'.repeat(1200), locataireBlock: 'Y'.repeat(1200) },
      });
    }
    const totalBytes = JSON.stringify(big).length;
    await PC.save('uid1', big);

    let maxDoc = 0;
    server.store.forEach((v) => { maxDoc = Math.max(maxDoc, JSON.stringify(v).length); });
    check('volume total réaliste (> 2 Mo)', totalBytes > 2000000, totalBytes + ' octets');
    check('plus grosse fiche très en dessous de 1 048 576 octets',
      maxDoc < 100000, 'plus gros document = ' + maxDoc + ' octets');
    check('les 900 quittances sont dans le cloud',
      server.store.size >= 900, 'docs = ' + server.store.size);

    const rebuilt = PC._internals.rebuild(new Map(server.store));
    check('les 900 quittances sont relues dans le bon ordre',
      rebuilt.documents.length === 900 && rebuilt.documents[0].id === 'doc0' && rebuilt.documents[899].id === 'doc899',
      'relu ' + rebuilt.documents.length);
    PC.stop();
  }

  console.log('\n== 7. Une fiche isolée trop grosse échoue avec un message explicite ==');
  {
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => {});
    deliver(server);

    const d = baseData();
    d.bailRedactions.push({ id: 'r1', contenu: 'Z'.repeat(950000) });
    let message = null;
    try { await PC.save('uid1', d); } catch (e) { message = e.message; }
    check('erreur levée et nommée', !!message && /trop volumineuse/.test(message) && /bailRedactions/.test(message),
      'message = ' + message);
    PC.stop();
  }

  console.log('\n== 8. Enregistrer sans rien changer n\'écrit rien (pas de trafic inutile) ==');
  {
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => {});
    deliver(server);
    const d = baseData();
    await PC.save('uid1', d);
    const after = server.writeCount;
    await PC.save('uid1', clone(d));
    check('aucune écriture supplémentaire', server.writeCount === after,
      after + ' -> ' + server.writeCount);
    PC.stop();
  }

  console.log('\n== 9. Compte neuf : rien dans le cloud => l\'app est prévenue (null) ==');
  {
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    let received = 'jamais appelé';
    PC.start('uid1', (r) => { received = r; });
    deliver(server);
    check('null transmis quand le compte est vide', received === null, 'reçu ' + JSON.stringify(received));
    PC.stop();
  }

  console.log('\n== 10. Pas de re-rendu inutile après son propre enregistrement ==');
  {
    // Symptôme constaté : après "Enregistrer", l'écran se vidait ~1 s avant de
    // se recomposer, parce que l'écho de notre propre écriture était réappliqué.
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    let emissions = 0;
    PC.start('uid1', () => { emissions++; });
    deliver(server);                       // 1re émission : compte vide (null)
    const first = emissions;

    await PC.save('uid1', baseData());
    deliver(server);                       // écho de notre propre écriture
    check('l\'écho de sa propre écriture ne redéclenche pas de rendu',
      emissions === first, 'émissions ' + first + ' -> ' + emissions);

    // Mais un vrai changement distant, lui, doit bien être transmis.
    server.store.set('rec-documents-dZ', { c: 'documents', i: 9, j: JSON.stringify({ id: 'dZ' }) });
    deliver(server);
    check('un vrai changement distant est bien transmis', emissions === first + 1,
      'émissions = ' + emissions);
    PC.stop();
  }

  console.log('\n== 11. Bascule depuis l\'ANCIEN format déjà présent en production ==');
  {
    // Le cloud de production contient encore l'ancien schéma : "meta" et les
    // catégories entières, avec de vrais champs Firestore (pas le nouveau
    // format { c, i, j }). L'app doit le considérer comme "pas de données
    // exploitables", republier depuis la copie locale, et nettoyer.
    const server = createFakeServer();
    server.store.set('main', { schemaVersion: 1, sci: { nom: 'ancien' }, biens: [{ id: 'vieux' }] });
    server.store.set('meta', { schemaVersion: 1, sci: { nom: 'ancien' }, bailModele: '', syncMeta: {} });
    server.store.set('biens', { biens: [{ id: 'vieux' }] });
    server.store.set('documents_0', { documents: [{ id: 'vieuxdoc' }] });

    const PC = loadSyncModule(server, 'PC');
    const local = baseData();
    let received = 'jamais appelé';
    PC.start('uid1', (r) => { received = r; });
    deliver(server);

    check('l\'ancien format n\'est pas pris pour des données valides', received === null,
      'reçu ' + JSON.stringify(received && Object.keys(received)));

    // C'est ce que fait app.js quand il reçoit null : republier le local.
    await PC.save('uid1', local);
    deliver(server);

    check('anciens documents nettoyés',
      !server.store.has('main') && !server.store.has('biens') && !server.store.has('documents_0'));
    check('meta est passé au nouveau format', !!(server.store.get('meta') || {}).j);
    const rebuilt = PC._internals.rebuild(new Map(server.store));
    eq('les vraies données locales ont bien remplacé l\'ancien contenu', rebuilt.biens, local.biens);
    eq('sci correct après bascule', rebuilt.sci, local.sci);
    PC.stop();
  }

  console.log('\n---------------------------------------------');
  console.log(passed + ' test(s) OK, ' + failed + ' échec(s)');
  console.log('---------------------------------------------\n');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
