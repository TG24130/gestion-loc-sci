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

// Délivre l'état courant du serveur (des DOCUMENTS ont changé) à un appareil
// précis, ou à tous.
function deliver(server, only) {
  server.listeners.forEach((l) => {
    if (only && l.owner !== only) return;
    l.cb(snapshotOf(server, false));
  });
}

// Confirmation du serveur SANS aucun changement de document : le cache local
// contenait déjà exactement le même contenu, seule la métadonnée fromCache
// passe de true à false. Firestore ne délivre CE cas qu'aux écoutes ayant
// demandé { includeMetadataChanges: true }.
// C'est précisément ce cas qui bloquait toute la synchronisation en production.
function deliverServerConfirmation(server, only) {
  server.listeners.forEach((l) => {
    if (only && l.owner !== only) return;
    if (!l.includeMetadata) return;
    l.cb(snapshotOf(server, false));
  });
}

// ---------- Chargement du module avec le SDK Firebase simulé ----------

function loadSyncModule(server, owner) {
  const file = path.join(__dirname, '..', 'js', 'firestoreSync.js');
  let src = fs.readFileSync(file, 'utf8');
  // Retire les imports ES (CDN Firebase) : ils sont remplacés par des stubs.
  // (\r? : le dépôt est en CRLF sous Windows.)
  src = src.replace(/^import[\s\S]*?firebase-firestore\.js';\r?\n/m, '');
  if (/^import/m.test(src)) {
    throw new Error('Les imports ES n\'ont pas pu être retirés — le harnais de test est désynchronisé du module.');
  }

  const sandbox = {
    console,
    TextEncoder,
    window: {},
    firebaseApp: {},
    initializeFirestore: () => ({}),
    persistentLocalCache: () => ({}),
    persistentMultipleTabManager: () => ({}),
    collection: () => ({ kind: 'col' }),
    doc: (col, id) => ({ id }),
    writeBatch: () => {
      const ops = [];
      return {
        set: (ref, value) => ops.push({ type: 'set', id: ref.id, value }),
        delete: (ref) => ops.push({ type: 'delete', id: ref.id }),
        commit: async () => {
          // server.failNextCommits : simule un échec réseau/permission sur le
          // prochain commit (tests 16-17) — décrémenté à chaque appel.
          if (server.failNextCommits > 0) {
            server.failNextCommits--;
            throw new Error('commit simulé en échec (test)');
          }
          ops.forEach((op) => {
            if (op.type === 'set') { server.store.set(op.id, op.value); server.writeCount++; }
            else { server.store.delete(op.id); server.deleteCount++; }
          });
        },
      };
    },
    onSnapshot: (col, a, b) => {
      // Firestore accepte onSnapshot(ref, cb) ou onSnapshot(ref, options, cb).
      const options = typeof a === 'function' ? {} : (a || {});
      const cb = typeof a === 'function' ? a : b;
      const entry = { cb, owner, includeMetadata: !!options.includeMetadataChanges };
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
    // Les réglages d'annonce et les rédactions doivent traverser la
    // synchronisation comme le reste : firestoreSync liste explicitement les
    // clés qu'il transporte, une clé oubliée disparaîtrait silencieusement
    // d'un appareil à l'autre.
    reglagesAnnonce: { critereContrat: 'CDI', ratioRevenus: 3, modalitesVisite: '', canalContact: '' },
    annonceRedactions: [{
      id: 'an1', bienId: 'b1', titre: 'Maison F4', texteLibre: 'Descriptif',
      loyer: 755, charges: 35, chargesDetail: ['tonte'], depotGarantie: 755,
      disponibleLe: '2026-10-01', photos: [{ fileId: 'f9', ordre: 0 }], statut: 'brouillon',
    }],
    candidatures: [{
      id: 'ca1', bienId: 'b1', nom: 'Marie Dupont', telephone: '0600000000',
      email: 'marie@example.fr', dateReception: '2026-08-13', statut: 'dossier-recu',
      ressources: 2400, chargesDeclarees: 600, notes: '',
      pieces: [{ fileId: 'f10', type: 'identite', nom: 'cni.pdf' }],
    }],
    visites: [{
      id: 'vi1', bienId: 'b1', date: '2026-09-05', heureDebut: '09:00',
      dureeCreneau: 30, creneaux: [{ candidatureId: 'ca1', heure: '09:00' }],
    }],
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
    eq('réglages d\'annonce préservés', rebuilt.reglagesAnnonce, data.reglagesAnnonce);
    eq('rédactions d\'annonce préservées', rebuilt.annonceRedactions, data.annonceRedactions);
    eq('candidatures préservées', rebuilt.candidatures, data.candidatures);
    eq('visites préservées', rebuilt.visites, data.visites);
    check('une fiche = un document Firestore',
      server.store.size === 1 + 2 + 1 + 2 + 1 + 1 + 1 + 1,
      'docs = ' + server.store.size + ' (attendu 10 : meta + 2 biens + 1 locataire + 2 documents + 1 EDL + 1 annonce + 1 candidature + 1 visite)');
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

  console.log('\n== 4. Tant que le serveur n\'a pas répondu, rien n\'est ni supprimé ni écrit ==');
  {
    // Avant confirmation, shadow est encore vide : une écriture immédiate ne
    // se compare à rien et écraserait sans le savoir une fiche distante dont
    // l'id coïnciderait avec une fiche locale périmée (voir tests 14-15).
    // QfSync.save() met donc en attente SANS RIEN écrire tant que le serveur
    // n'a pas répondu ; le rejeu (additif) n'a lieu qu'à la confirmation.
    const server = createFakeServer();
    // Le serveur contient déjà une fiche créée ailleurs.
    server.store.set('rec-documents-dX', { c: 'documents', i: 0, j: JSON.stringify({ id: 'dX' }) });

    const PC = loadSyncModule(server, 'PC');
    // start() n'est PAS appelé : l'appareil n'a jamais vu l'état du serveur.
    // Pas de await ici : la promesse ne se règle qu'au rejeu (flushPending),
    // qui n'aura jamais lieu puisque start() n'est pas appelé — l'attendre
    // bloquerait le test indéfiniment. C'est exactement le point testé :
    // rien n'est écrit tant que personne n'écoute le serveur.
    PC.save('uid1', baseData()).catch(() => {});
    check('la fiche distante inconnue n\'est pas supprimée', server.store.has('rec-documents-dX'));
    check('rien n\'est écrit tant qu\'aucune confirmation n\'est arrivée',
      !server.store.has('rec-biens-b1'), 'writeCount = ' + server.writeCount);
    check('la sauvegarde est mise en attente', PC._state().sauvegardeEnAttente === true);
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

  console.log('\n== 12. NON-REGRESSION : cache deja identique au serveur ==');
  {
    // Bug reel du 06/08/2026 : en production, le cache local contenait deja
    // exactement les memes documents que le serveur. La seule difference entre
    // l'instantane du cache et celui du serveur etait donc la metadonnee
    // fromCache. Sans { includeMetadataChanges: true }, Firestore ne delivre
    // AUCUN instantane dans ce cas : l'ecoute restait active, aucune erreur
    // n'etait levee, et la synchronisation attendait indefiniment une
    // confirmation qui n'arrivait jamais.
    const server = createFakeServer();
    server.store.set('meta', {
      c: '_meta', i: 0,
      j: JSON.stringify({ schemaVersion: 1, sci: { nom: 'X' }, bailModele: '', syncMeta: {} }),
    });

    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => {});
    check('tant que le serveur n\'a pas confirme, rien n\'est tenu pour sur',
      PC._state().serveurRepondu === false);

    deliverServerConfirmation(server, 'PC');
    check('la confirmation serveur (metadonnee seule) est bien recue',
      PC._state().serveurRepondu === true,
      'etat = ' + JSON.stringify(PC._state()) + ' — il manque { includeMetadataChanges: true } sur onSnapshot');
    PC.stop();
  }

  console.log('\n== 13. Pas d\'écrasement (ni suppression) avant confirmation serveur ==');
  {
    // Scenario reel : icone PWA supprimee puis reinstallee sur le telephone
    // (IndexedDB local vide), reseau 4G faible -> save() peut etre appele
    // AVANT que le serveur ait confirme son etat. Le vrai "meta" (nom de SCI,
    // modele de bail...) et les fiches deja en production ne doivent etre ni
    // ecrases ni supprimes par la version locale vide, y compris APRES la
    // confirmation serveur (la sauvegarde en attente est rejouee a ce moment
    // -- elle doit fusionner l'instantane distant, pas le remplacer).
    const server = createFakeServer();
    server.store.set('meta', {
      c: '_meta', i: 0,
      j: JSON.stringify({ schemaVersion: 1, sci: { nom: 'SCI GP2IE' }, bailModele: '<p>Vrai modele</p>', syncMeta: {} }),
    });
    server.store.set('rec-biens-b1', { c: 'biens', i: 0, j: JSON.stringify({ id: 'b1', nom: 'Maison 1' }) });
    server.store.set('rec-locataires-l1', { c: 'locataires', i: 0, j: JSON.stringify({ id: 'l1', nom: 'Dupont' }) });

    const PC = loadSyncModule(server, 'PC');
    // Callback realiste, comme onRemoteData dans app.js : fusionne
    // l'instantane distant dans le MEME objet que celui passe a save().
    const local = { schemaVersion: 1, sci: {}, bailModele: '', reglagesAnnonce: {}, syncMeta: {} };
    PC.start('uid1', (remote) => { if (remote) Object.assign(local, remote); });
    check('avant confirmation, le garde-fou est bien actif', PC._state().serveurRepondu === false);

    // Pas de await : la promesse ne se règle qu'au rejeu (après confirmation,
    // quelques lignes plus bas) — l'attendre ici bloquerait le test.
    PC.save('uid1', local).catch(() => {});

    const metaAfter = JSON.parse(server.store.get('meta').j);
    eq('le vrai "meta" du cloud n\'a pas été écrasé avant confirmation', metaAfter.sci.nom, 'SCI GP2IE');
    check('la sauvegarde locale (vide) est mise en attente', PC._state().sauvegardeEnAttente === true);

    deliverServerConfirmation(server, 'PC');
    check('la sauvegarde en attente est rejouée après confirmation', PC._state().sauvegardeEnAttente === false);

    const metaFinal = JSON.parse(server.store.get('meta').j);
    eq('"meta" toujours correct après le rejeu de la sauvegarde en attente', metaFinal.sci.nom, 'SCI GP2IE');
    check('aucune fiche supprimée pendant tout le scénario',
      server.deleteCount === 0, 'deleteCount = ' + server.deleteCount);
    check('les fiches existantes sont toujours là',
      server.store.has('rec-biens-b1') && server.store.has('rec-locataires-l1'));
    eq('la donnée locale a bien été fusionnée avec le distant (bailModele)',
      local.bailModele, '<p>Vrai modele</p>');
    PC.stop();
  }

  console.log('\n== 14. Un callback qui NE fusionne PAS ne doit ni supprimer NI écraser (filet de sécurité) ==');
  {
    // Cas degrade : si l'appelant ne fusionne pas l'instantane distant dans
    // `data` (bug futur, callback partiel, saisie en cours qui fait sortir
    // onRemoteData tot chez app.js...), le rejeu de la sauvegarde en attente
    // ne doit NI supprimer NI ECRASER un document deja connu du serveur --
    // seul un save() normal, avec des donnees a jour, y est autorise. Piege
    // deja rencontre une fois : allowDeletes:false protegeait les
    // suppressions mais pas les ECRITURES (meta, ou ici le loyer d'un bien).
    const server = createFakeServer();
    server.store.set('meta', {
      c: '_meta', i: 0, j: JSON.stringify({ sci: { nom: 'SCI GP2IE' }, bailModele: '<p>Vrai modele</p>' }),
    });
    server.store.set('rec-biens-b1', { c: 'biens', i: 0, j: JSON.stringify({ id: 'b1', loyer: 900 }) });

    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => {}); // callback qui ne fait rien : pas de fusion
    // Donnee locale PERIMEE (avant reinstallation/reconnexion), pas fusionnee
    // avec le distant : meme id "b1" que le serveur, mais loyer different.
    const local = { sci: {}, bailModele: '', biens: [{ id: 'b1', loyer: 500 }] };

    PC.save('uid1', local).catch(() => {}); // pas de await, voir test 13
    deliverServerConfirmation(server, 'PC');

    check('aucune suppression malgré un callback qui ne fusionne rien',
      server.deleteCount === 0, 'deleteCount = ' + server.deleteCount);
    const metaFinal = JSON.parse(server.store.get('meta').j);
    eq('"meta" du cloud non écrasé malgré l\'absence de fusion', metaFinal.sci.nom, 'SCI GP2IE');
    const bienFinal = JSON.parse(server.store.get('rec-biens-b1').j);
    eq('la fiche distante (loyer réel) n\'a pas été écrasée par la version locale périmée',
      bienFinal.loyer, 900);
    PC.stop();
  }

  console.log('\n== 15. Une exception dans le callback distant n\'empêche pas le rejeu de la sauvegarde en attente ==');
  {
    // Une erreur de rendu cote app.js (onRemoteData) ne doit pas laisser
    // pendingSave bloque indefiniment, ni empecher la confirmation serveur
    // d'etre correctement prise en compte pour les appels suivants.
    const server = createFakeServer();
    server.store.set('meta', { c: '_meta', i: 0, j: JSON.stringify({ sci: { nom: 'SCI GP2IE' } }) });

    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => { throw new Error('boum (bug de rendu simulé)'); });
    const local = { sci: {} };

    PC.save('uid1', local).catch(() => {}); // pas de await, voir test 13
    deliverServerConfirmation(server, 'PC');

    check('la sauvegarde en attente est bien rejouée malgré l\'exception',
      PC._state().sauvegardeEnAttente === false);
    const metaFinal = JSON.parse(server.store.get('meta').j);
    eq('"meta" toujours correct malgré l\'exception dans le callback', metaFinal.sci.nom, 'SCI GP2IE');
    PC.stop();
  }

  console.log('\n== 16. Une fiche créée hors ligne (avant toute confirmation) n\'est pas perdue à la fusion ==');
  {
    // Bug reel trouve en revue : mergeWithDefaults REMPLACE chaque tableau en
    // bloc par sa version distante. Sans repechage (infos.jamaisPublie), une
    // fiche creee hors ligne (etat des lieux redige sans reseau, cas d'usage
    // revendique du projet) disparaissait a la toute premiere fusion, avant
    // meme que la sauvegarde en attente n'ait pu la publier.
    const server = createFakeServer();
    server.store.set('meta', { c: '_meta', i: 0, j: JSON.stringify({ sci: { nom: 'SCI GP2IE' } }) });
    server.store.set('rec-biens-b1', { c: 'biens', i: 0, j: JSON.stringify({ id: 'b1', nom: 'Maison 1' }) });

    const PC = loadSyncModule(server, 'PC');
    const local = { sci: {}, biens: [], documents: [] };
    // Mini onRemoteData realiste (meme logique que js/app.js:onRemoteData) :
    // fusionne, mais repeche les fiches locales "jamais publiees".
    PC.start('uid1', (remote, infos) => {
      if (!remote) return true;
      const fusionne = Object.assign({}, remote);
      ['biens', 'documents'].forEach((k) => {
        const distants = Array.isArray(fusionne[k]) ? fusionne[k] : [];
        const idsDistants = new Set(distants.map((r) => r.id));
        const inedites = (local[k] || [])
          .filter((r) => r && r.id && !idsDistants.has(r.id) && infos.jamaisPublie(k, r));
        fusionne[k] = distants.concat(inedites);
      });
      Object.assign(local, fusionne);
      return true;
    });

    // Création locale AVANT toute confirmation serveur.
    local.documents.push({ id: 'q42', type: 'quittance', montant: 500 });
    PC.save('uid1', local).catch(() => {}); // pas de await, voir test 13
    check('la création est mise en attente', PC._state().sauvegardeEnAttente === true);

    deliverServerConfirmation(server, 'PC');
    // Le rejeu passe désormais par la file de sérialisation (queued()), un
    // .then() de plus qu'un appel direct : laisser cette micro-tâche filer.
    await new Promise((r) => setTimeout(r, 0));

    check('q42 a bien été publiée dans le cloud', server.store.has('rec-documents-q42'));
    check('q42 est toujours dans les données locales après fusion',
      local.documents.some((d) => d.id === 'q42'));
    check('rec-biens-b1 (distant) est bien arrivé dans les données locales',
      local.biens.some((b) => b.id === 'b1'));
    PC.stop();
  }

  console.log('\n== 17. Un instantané écarté (saisie en cours) empêche toute suppression au save() suivant ==');
  {
    // Bug reel trouve en revue : shadow/shadowFromServer sont mis a jour
    // MEME quand onRemoteChange n'applique pas l'instantane (saisie en
    // cours). Le save() normal qui suit comparait alors un `data` local pas
    // fusionne a ce nouveau shadow, et prenait des fiches distantes connues
    // pour des suppressions.
    const server = createFakeServer();
    server.store.set('meta', { c: '_meta', i: 0, j: JSON.stringify({ sci: { nom: 'SCI GP2IE' } }) });
    server.store.set('rec-documents-dB', { c: 'documents', i: 0, j: JSON.stringify({ id: 'dB' }) });

    const PC = loadSyncModule(server, 'PC');
    let premierAppel = true;
    const local = { sci: { nom: 'SCI GP2IE' }, documents: [] }; // ne connaît pas dB
    PC.start('uid1', (remote) => {
      if (premierAppel) { premierAppel = false; return false; } // "saisie en cours" : écarté
      if (remote) Object.assign(local, remote);
      return true;
    });
    deliverServerConfirmation(server, 'PC'); // écarté par le callback

    check('le serveur a bien répondu (shadow à jour, mais dB pas encore fusionné)',
      PC._state().serveurRepondu === true && PC._state().documentsConnusDeLApp === 0);

    // La "saisie" se termine : un save() normal part, avec des données
    // locales qui ne connaissent toujours pas dB.
    await PC.save('uid1', local);

    check('dB n\'a PAS été supprimé malgré l\'instantané écarté',
      server.store.has('rec-documents-dB'), 'deleteCount = ' + server.deleteCount);
    PC.stop();
  }

  console.log('\n== 18. Un échec de commitOps lors du rejeu est retenté (pas de perte silencieuse) ==');
  {
    const server = createFakeServer();
    server.store.set('meta', { c: '_meta', i: 0, j: JSON.stringify({ sci: { nom: 'SCI GP2IE' } }) });

    const PC = loadSyncModule(server, 'PC');
    let erreurRecue = null;
    PC.start('uid1', () => true);
    PC.setErrorHandler((e) => { erreurRecue = e; });

    const local = { sci: {}, documents: [{ id: 'q99', montant: 100 }] };
    PC.save('uid1', local).catch(() => {});

    server.failNextCommits = 1; // le rejeu (flushPending) va échouer une fois
    deliverServerConfirmation(server, 'PC');
    // Laisse toutes les micro-tâches du rejeu (échoué) se dérouler — un
    // macro-tâche (setTimeout) garantit qu'elles sont TOUTES vidées, quelle
    // que soit la profondeur de la chaîne save -> commitOps -> batch.commit.
    await new Promise((r) => setTimeout(r, 0));

    check('q99 n\'est pas encore publiée (le premier essai a échoué)',
      !server.store.has('rec-documents-q99'));
    check('l\'échec a été signalé via setErrorHandler', !!erreurRecue);
    check('la sauvegarde est remise en file (pas perdue)', PC._state().sauvegardeEnAttente === true);

    // Le prochain instantané confirmé redéclenche le rejeu, cette fois sans échec simulé.
    deliverServerConfirmation(server, 'PC');
    await new Promise((r) => setTimeout(r, 0));

    check('q99 finit par être publiée au rejeu suivant', server.store.has('rec-documents-q99'));
    PC.stop();
  }

  console.log('\n== 19. Une fiche trop volumineuse n\'empêche pas la synchronisation des autres ==');
  {
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => true);
    deliverServerConfirmation(server, 'PC');

    const grosTexte = 'x'.repeat(1000000); // ~1 Mo, dépasse MAX_RECORD_BYTES
    const data = baseData();
    data.bailRedactions = [{ id: 'br1', contenu: grosTexte }];
    data.documents.push({ id: 'q1', type: 'quittance', montant: 500 });

    let message = null;
    try { await PC.save('uid1', data); } catch (e) { message = e.message; }

    check('une erreur nommée est bien levée', !!message && /volumineuse/.test(message));
    check('la fiche saine (q1) a quand même été publiée', server.store.has('rec-documents-q1'));
    check('la fiche trop grosse n\'a PAS été publiée', !server.store.has('rec-bailRedactions-br1'));
    PC.stop();
  }

  console.log('\n== 20. Deux évènements start() pour le même compte ne perdent pas une sauvegarde en attente ==');
  {
    const server = createFakeServer();
    server.store.set('meta', { c: '_meta', i: 0, j: JSON.stringify({ sci: { nom: 'SCI GP2IE' } }) });

    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => true);
    const local = { sci: {}, documents: [{ id: 'q7', montant: 100 }] };
    PC.save('uid1', local).catch(() => {});
    check('sauvegarde mise en attente avant le second start()', PC._state().sauvegardeEnAttente === true);

    PC.start('uid1', () => true); // second évènement d'authentification, même compte
    check('la sauvegarde en attente survit au second start() (même uid)',
      PC._state().sauvegardeEnAttente === true);

    deliverServerConfirmation(server, 'PC');
    await new Promise((r) => setTimeout(r, 0)); // voir test 16 : rejeu via queued()
    check('q7 finit par être publiée', server.store.has('rec-documents-q7'));
    PC.stop();
  }

  console.log('\n== 21. Une fiche déjà publiée qui grossit au-delà de la limite n\'est PAS supprimée du cloud ==');
  {
    // Bug reel trouve en revue : desired.delete(id) retirait la fiche
    // fautive de `desired`, et la boucle de suppressions prenait alors tout
    // ce qui est dans shadow et pas dans desired -- y compris cette fiche,
    // qui etait donc EFFACEE du cloud au lieu d'etre simplement pas mise a
    // jour. Sur un autre appareil, la fiche disparaissait alors reellement.
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    PC.start('uid1', () => true);
    deliverServerConfirmation(server, 'PC');

    const data = baseData();
    data.bailRedactions = [{ id: 'br1', contenu: 'texte court' }];
    await PC.save('uid1', data);
    check('la fiche est bien publiée en petite taille', server.store.has('rec-bailRedactions-br1'));

    // Elle grossit au-delà de la limite (état des lieux avec beaucoup de photos).
    data.bailRedactions[0].contenu = 'x'.repeat(1000000);
    let message = null;
    try { await PC.save('uid1', data); } catch (e) { message = e.message; }

    check('une erreur est levée', !!message);
    check('la fiche N\'A PAS été supprimée du cloud (juste pas mise à jour)',
      server.store.has('rec-bailRedactions-br1'));
    PC.stop();
  }

  console.log('\n== 22. Un instantané écarté ne bloque QUE ses propres fiches, pas celles déjà connues ==');
  {
    // Bug reel trouve en revue : un drapeau GLOBAL (dernierEtatFusionne)
    // bloquait TOUTES les suppressions des qu'un seul instantane etait
    // ecarte, meme pour des fiches parfaitement connues par ailleurs -- une
    // vraie suppression locale (l'utilisateur supprime une quittance) restait
    // sans effet, et la fiche "ressuscitait" au prochain instantane applique.
    const server = createFakeServer();
    const PC = loadSyncModule(server, 'PC');
    const local = { sci: {}, documents: [] };
    let ecarterProchain = false;
    PC.start('uid1', (remote) => {
      if (ecarterProchain) { ecarterProchain = false; return false; }
      if (remote) Object.assign(local, remote);
      return true;
    });
    deliverServerConfirmation(server, 'PC'); // compte vide, appliqué normalement

    // q1 publiée normalement : connue avec certitude par l'app.
    local.documents.push({ id: 'q1', montant: 500 });
    await PC.save('uid1', local);
    check('q1 bien publiée et connue', server.store.has('rec-documents-q1'));

    // Un autre appareil publie q2 PENDANT une saisie en cours ici : cet
    // instantané est écarté, q2 n'est jamais fusionnée dans `local`.
    server.store.set('rec-documents-q2', { c: 'documents', i: 1, j: JSON.stringify({ id: 'q2' }) });
    ecarterProchain = true;
    deliverServerConfirmation(server, 'PC');

    // Sans avoir jamais fusionné q2, l'utilisateur supprime q1 localement
    // (une fiche qu'il connaît bien, lui) : ça DOIT partir.
    local.documents = local.documents.filter((d) => d.id !== 'q1');
    await PC.save('uid1', local);

    check('q1 (connue) a bien été supprimée malgré l\'instantané écarté entre-temps',
      !server.store.has('rec-documents-q1'));
    check('q2 (jamais fusionnée) est toujours protégée, pas supprimée',
      server.store.has('rec-documents-q2'));
    PC.stop();
  }

  console.log('\n---------------------------------------------');
  console.log(passed + ' test(s) OK, ' + failed + ' échec(s)');
  console.log('---------------------------------------------\n');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
