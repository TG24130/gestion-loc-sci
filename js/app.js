(async function () {
  // Chargement asynchrone : les données vivent désormais dans IndexedDB
  // (localStorage était plafonné à ~5 Mo). Tout le reste du fichier s'exécute
  // après cette ligne, y compris l'abonnement aux évènements — d'où le rejeu
  // de l'état d'authentification plus bas.
  const data = await Storage.load();

  // D'anciennes versions recopiaient la signature de la SCI (image base64 de
  // plusieurs centaines de Ko) dans CHAQUE état des lieux et dans CHAQUE
  // document généré. Cumulé sur des années, cela saturait le stockage local du
  // navigateur — plafonné à ~5 Mo sur iOS, d'où l'échec d'enregistrement sur le
  // téléphone. La signature de référence vit dans "Ma SCI" et est réinjectée au
  // moment de générer le PDF : ces copies ne servent donc à rien.
  // Renvoie true si quelque chose a été allégé.
  function purgeSignaturesDupliquees(d) {
    let changed = false;
    (d.edlRedactions || []).forEach((r) => {
      if (r && 'signatureBailleur' in r) { delete r.signatureBailleur; changed = true; }
    });
    (d.documents || []).forEach((doc) => {
      if (doc && doc.ctx && 'signatureDataUrl' in doc.ctx) { delete doc.ctx.signatureDataUrl; changed = true; }
    });
    return changed;
  }
  if (purgeSignaturesDupliquees(data)) Storage.save(data);

  // ---------- Utilities ----------
  function deviceId() {
    let id = localStorage.getItem('qf_device_id');
    if (!id) { id = Storage.uid(); localStorage.setItem('qf_device_id', id); }
    return id;
  }

  function save() {
    data.syncMeta = { updatedAt: new Date().toISOString(), updatedBy: deviceId() };
    const ok = Storage.save(data);
    if (!ok) {
      alert("⚠️ La sauvegarde a échoué (stockage plein ou indisponible). Vos dernières modifications n'ont probablement PAS été enregistrées.\n\nExportez vos données immédiatement (bouton \"Exporter mes données (.zip)\" dans le menu de gauche) avant de continuer, puis libérez de la place si besoin.");
    }
    if (window.QfSync && window.QfAuth && window.QfAuth.currentUser) {
      window.QfSync.save(window.QfAuth.currentUser.uid, data).catch((e) => {
        console.error('Échec de la synchronisation cloud (les données restent enregistrées localement)', e);
      });
    }
    return ok;
  }
  function euros(n) { return Documents.fmtEUR(n) + ' €'; }
  function byId(id) { return document.getElementById(id); }
  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function bienById(id) { return data.biens.find((b) => b.id === id); }
  function locataireById(id) { return data.locataires.find((l) => l.id === id); }

  function findLatestEntrantRedaction(bienId, locataireId) {
    return data.edlRedactions
      .filter((r) => r.bienId === bienId && r.locataireId === locataireId && r.sens === 'entrant')
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] || null;
  }

  const MAX_DOC_PAGES = 10;
  // Un document (bail / état des lieux) peut regrouper plusieurs pages scannées.
  // Compatible avec l'ancien format à fichier unique (fileId/fileName).
  function filesOf(record) {
    if (Array.isArray(record.files)) return record.files;
    if (record.fileId) return [{ fileId: record.fileId, fileName: record.fileName || '' }];
    return [];
  }

  function fileLinksHTML(record) {
    const files = filesOf(record);
    if (files.length === 0) return '<span class="file-empty">—</span>';
    return files.map((f, i) => `<button type="button" class="file-link" data-view-file="${f.fileId}" title="${escapeHTML(f.fileName || '')}">Page ${i + 1}</button>`).join(' ');
  }

  async function deleteRecordFiles(record) {
    const files = filesOf(record);
    for (const f of files) {
      try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
    }
  }

  function nl2brLocal(str) {
    return escapeHTML(str).replace(/\n/g, '<br>');
  }

  function isHtmlEmpty(html) {
    return !html || !html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  }

  const DOC_LABELS = {
    quittance: 'Quittance de loyer',
    'recu-partiel': 'Reçu partiel',
    relance: 'Relance',
    avenant: 'Avenant au bail',
    libre: 'Courrier libre',
  };

  const AVENANT_DEFAULT_LINES = [
    { libelle: 'Prestation tonte', montant: '', note: '/mois (contractuel)' },
    { libelle: 'Entretien obligatoire chaudière', montant: '', note: '/mois (contractuel)' },
    { libelle: 'Electricité et eau des communs (barrière, éclairage, nettoyage)', montant: '', note: '(prévisionnel)' },
    { libelle: 'Ordures Ménagères', montant: '', note: 'de provisions pour charges (prévisionnel)' },
  ];

  const CHARGE_CATEGORIES = {
    tontes: 'Tontes jardinet',
    chaudiere: 'Entretien chaudière',
    clim: 'Entretien clim',
    ordures: 'Ordures ménagères',
    edf: 'EDF communs',
  };
  const MONTHS_SHORT = ['Janv', 'Févr', 'Mars', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sept', 'Oct', 'Nov', 'Déc'];
  let currentChargeCategory = null;

  const ADMIN_DOC_CATEGORIES = {
    ag: 'AG',
    dpe: 'DPE',
    conformites: 'Conformités électrique, gaz et eau',
    daact: 'DAACT',
    kbis: 'Kbis',
    bilans: 'Bilans',
    clims: 'Contrats Clims Bellevue et rue Alfred',
    prm: 'Nums PRM eau et gaz',
    notices: 'Notices',
    rib: 'RIB',
    assurances: 'Assurances',
    cartepro: 'Num carte Impar',
  };
  let currentDocsAdminCategory = null;

  const CREDIT_CATEGORIES = {
    bpaca: 'BPACA',
    caissedepargne: "Caisse d'Épargne",
    autre: 'Autre',
  };
  let currentCreditCategory = null;

  const FACTURES_TRAVAUX_CATEGORIES = {
    factures: 'Factures SCI',
    travaux: 'Travaux SCI',
  };
  let currentFacturesTravauxCategory = null;

  // Rédaction d'état des lieux — Phase 1 : gabarits de pièces par bien.
  const EDL_ROOM_TYPES = {
    chambre: { label: 'Chambre', elements: ['Sol', 'Murs', 'Plafond', 'Fenêtre(s)', 'Volets', 'Porte', 'Prises et interrupteurs', 'Chauffage', 'Placard'] },
    sdb: { label: 'Salle de bain', elements: ['Sol', 'Murs', 'Plafond', 'Douche ou baignoire', 'Robinetterie', 'Lavabo', 'Miroir', 'VMC', 'Faïence', 'Chauffage'] },
    cuisine: { label: 'Cuisine', elements: ['Sol', 'Murs', 'Plafond', 'Évier et robinetterie', 'Plaques de cuisson', 'Four', 'Hotte', 'Meubles hauts', 'Meubles bas', 'Plan de travail', 'Prises et interrupteurs'] },
    salon: { label: 'Salon / Séjour', elements: ['Sol', 'Murs', 'Plafond', 'Fenêtre(s)', 'Volets', 'Porte', 'Prises et interrupteurs', 'Chauffage'] },
    wc: { label: 'WC', elements: ['Sol', 'Murs', 'Plafond', "Cuvette et chasse d'eau", 'Ventilation'] },
    entree: { label: 'Entrée / Couloir', elements: ['Sol', 'Murs', 'Plafond', "Porte d'entrée", 'Interphone / Digicode', 'Prises et interrupteurs'] },
    exterieur: { label: 'Extérieur', elements: ['Revêtement de sol', 'Clôture', 'Portail', 'Éclairage extérieur', 'Entretien végétation'] },
    cave: { label: 'Cave / Cellier', elements: ['Sol', 'Murs', 'Plafond', 'Porte', 'Éclairage'] },
    garage: { label: 'Garage / Parking', elements: ['Sol', 'Murs', 'Porte de garage', 'Éclairage'] },
    autre: { label: 'Autre', elements: [] },
  };

  const EDL_VETUSTE_OPTIONS = [
    { value: '', label: '— Vétusté —' },
    { value: 'neuf', label: 'Neuf' },
    { value: 'bon', label: 'Bon état' },
    { value: 'usage', label: "État d'usage" },
    { value: 'mauvais', label: 'Mauvais état' },
    { value: 'hors-service', label: 'Hors service' },
    { value: 'ns', label: 'NS (non significatif)' },
  ];
  let currentEdlRedaction = null;
  let currentEdlRedacSens = 'entrant';
  const EDL_METER_DEFAULTS = ['Électricité Heures Creuses', 'Électricité Heures Pleines', 'Eau', 'Gaz'];
  const EDL_CLES_DEFAULTS = ["Clés de la porte d'entrée", 'Clés du portillon jardin', 'Clé du box extérieur', 'Clé de la boîte aux lettres', 'Manette bip'];

  // ---------- Navigation ----------
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView(btn.dataset.view);
      closeSidebar();
    });
  });

  // Menu lateral escamotable (mobile) : le bouton hamburger et le fond assombri
  // n'ont d'effet visuel qu'en dessous de 880px (voir style.css), donc rien a
  // faire de special ici pour le bureau.
  function openSidebar() { document.querySelector('.app').classList.add('sidebar-open'); }
  function closeSidebar() { document.querySelector('.app').classList.remove('sidebar-open'); }
  byId('sidebar-toggle').addEventListener('click', () => {
    document.querySelector('.app').classList.toggle('sidebar-open');
  });
  byId('sidebar-overlay').addEventListener('click', closeSidebar);

  document.querySelectorAll('.nav-group-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const subgroup = document.getElementById(`nav-subgroup-${btn.dataset.toggleGroup}`);
      if (!subgroup) return;
      const collapsed = subgroup.classList.toggle('collapsed');
      btn.classList.toggle('collapsed', collapsed);
    });
  });

  let currentView = 'dashboard';
  function refreshCurrentView() { showView(currentView); }

  // A quel groupe du menu appartient une vue ? (les groupes sont replies par
  // defaut : on ouvre celui de la vue affichee pour que l'entree active reste
  // visible.)
  function groupeDeLaVue(view) {
    if (view.indexOf('charges-') === 0) return 'charges';
    if (view.indexOf('docsadmin-') === 0) return 'docsadmin';
    if (view.indexOf('credits-') === 0) return 'credits';
    if (view.indexOf('facturestravaux-') === 0) return 'facturestravaux';
    if (view.indexOf('annonces-') === 0) return 'annonces';
    if (view === 'bail' || view === 'etatslieux') return 'doclocataires';
    return null;
  }

  function ouvrirGroupeDeLaVue(view) {
    const groupe = groupeDeLaVue(view);
    if (!groupe) return;
    const sousMenu = byId('nav-subgroup-' + groupe);
    const bouton = document.querySelector('[data-toggle-group="' + groupe + '"]');
    if (sousMenu) sousMenu.classList.remove('collapsed');
    if (bouton) bouton.classList.remove('collapsed');
  }

  function showView(view) {
    currentView = view;
    ouvrirGroupeDeLaVue(view);
    const isCharges = view.indexOf('charges-') === 0;
    const isDocsAdmin = view.indexOf('docsadmin-') === 0;
    const isCredits = view.indexOf('credits-') === 0;
    const isFacturesTravaux = view.indexOf('facturestravaux-') === 0;
    // Le groupe « annonces » n'a pas de cas particulier ici : chacune de ses
    // entrées a sa propre section, comme bail et etatslieux. Seuls les groupes
    // dont les entrées partagent un même écran en ont besoin.
    const sectionId = isCharges ? 'view-charges' : isDocsAdmin ? 'view-docsadmin' : isCredits ? 'view-credits' : isFacturesTravaux ? 'view-facturestravaux' : 'view-' + view;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === sectionId));
    if (view === 'dashboard') renderDashboard();
    if (view === 'locataires') renderLocataires();
    if (view === 'anciens-locataires') renderAnciensLocatairesView();
    if (view === 'biens') renderBiens();
    if (view === 'historique') renderHistorique();
    if (view === 'generer') renderGenererOptions();
    if (view === 'redaction-bail') renderRedactionBailView();
    if (view === 'edl-redaction') renderEdlRedactionView();
    if (view === 'parametres') fillSciForm();
    if (isCharges) renderChargesView(view.slice('charges-'.length));
    if (view === 'bail') renderBailView();
    if (view === 'etatslieux') renderEtatsLieuxView();
    if (isDocsAdmin) renderDocsAdminView(view.slice('docsadmin-'.length));
    if (isCredits) renderCreditsView(view.slice('credits-'.length));
    if (isFacturesTravaux) renderFacturesTravauxView(view.slice('facturestravaux-'.length));
    if (view === 'annonces-publication') renderAnnonces();
    if (view === 'annonces-candidatures') renderCandidatures();
    if (view === 'annonces-visites') renderVisites();
  }

  document.querySelectorAll('[data-action="quick-quittance"]').forEach((b) => b.addEventListener('click', () => showView('generer')));
  document.querySelectorAll('[data-action="quick-edl"]').forEach((b) => b.addEventListener('click', () => showView('edl-redaction')));
  document.querySelectorAll('[data-action="quick-redaction-bail"]').forEach((b) => b.addEventListener('click', () => showView('redaction-bail')));
  document.querySelectorAll('[data-action="quick-locataire"], [data-action="new-locataire"]').forEach((b) => b.addEventListener('click', () => openLocataireModal()));
  document.querySelectorAll('[data-action="quick-bien"], [data-action="new-bien"]').forEach((b) => b.addEventListener('click', () => openBienModal()));

  // ---------- Dashboard ----------
  function renderDashboard() {
    // Les elements du mode d'essai ("Tester avec un exemple") ne doivent jamais
    // fausser les chiffres reels ni le suivi des paiements.
    byId('stat-biens').textContent = data.biens.filter((b) => !b.isTest).length;
    byId('stat-locataires').textContent =
      data.locataires.filter((l) => l.actif !== false && !l.isTest).length;

    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const moisTotal = data.documents
      .filter((d) => d.periode === ym && (d.type === 'quittance' || d.type === 'recu-partiel'))
      .reduce((sum, d) => sum + (Number(d.montant) || 0), 0);
    byId('stat-mois').textContent = euros(moisTotal);
    byId('stat-docs').textContent = data.documents.length;
    // 5e carte : la date du jour, au format « Lundi 10 août ».
    const aujourdHui = new Date().toLocaleDateString('fr-FR',
      { weekday: 'long', day: 'numeric', month: 'long' });
    byId('stat-date').textContent = aujourdHui.charAt(0).toUpperCase() + aujourdHui.slice(1);

    renderSuiviPaiements();
  }

  // ---------- Suivi mensuel des paiements ----------
  // Remplace l'ancienne liste "Derniers documents" : ce qui compte au
  // quotidien, c'est de voir d'un coup d'oeil qui a paye et qui n'a pas paye
  // pour le mois en cours. Un locataire est considere comme ayant paye si une
  // quittance a ete emise pour ce mois ; un recu partiel est signale a part.
  function moisSuivi() {
    const champ = byId('suivi-mois');
    if (!champ.value) {
      const now = new Date();
      champ.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }
    return champ.value;
  }

  // "2026-08" -> "aout 2026" (le libelle complet de Documents.periodLabel,
  // pense pour les quittances, est trop long pour un titre).
  function moisLisible(ym) {
    const d = new Date(ym + '-01T00:00:00');
    if (isNaN(d)) return ym;
    return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  }

  // Le loyer est-il du ce mois-ci pour ce locataire ? Un loyer trimestriel
  // n'est attendu qu'un mois sur trois, a partir de son mois d'echeance
  // (ex : janvier, avril, juillet, octobre).
  function loyerDu(loc, ym) {
    if ((loc.periodicite || 'mensuelle') !== 'trimestrielle') return true;
    const mois = parseInt(ym.slice(5, 7), 10);
    const depart = parseInt(loc.moisDepart, 10) || 1;
    return ((mois - depart) % 3 + 3) % 3 === 0;
  }

  // Premier mois reellement couvert par l'application : avant lui, aucune
  // quittance n'a ete emise ici, donc afficher un impaye n'aurait aucun sens.
  function premierMoisSuivi() {
    const periodes = data.documents.map((d) => d.periode).filter(Boolean).sort();
    return periodes.length ? periodes[0] : null;
  }

  // Mois anterieur a l'entree du locataire, ou anterieur au premier document
  // enregistre dans l'application : rien a signaler.
  function horsSuivi(loc, ym) {
    if (loc.dateEntree && ym < loc.dateEntree.slice(0, 7)) return true;
    const debut = premierMoisSuivi();
    return !!debut && ym < debut;
  }

  function etatPaiement(loc, ym) {
    // Les quittances emises par d'anciennes versions n'ont pas toujours de
    // locataireId : on retombe alors sur le nom, sinon des paiements bien
    // reels apparaissaient comme impayes sur les mois passes.
    // Rapprochement volontairement tolerant : par identifiant OU par nom.
    // Les quittances anciennes n'ont pas toujours de locataireId, et lorsque
    // les locataires ont ete recrees (import d'archive, migration), l'ancien
    // identifiant enregistre dans la quittance ne correspond plus a la fiche
    // actuelle. Sans cela, des loyers bien regles s'affichaient en impaye.
    const memeNom = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    // Une quittance trimestrielle emise en juillet couvre juillet, aout et
    // septembre : le mois consulte doit tomber dans cette plage.
    const couvre = (d) => {
      if (!d.periode) return false;
      const duree = Number(d.nbMois) > 0 ? Number(d.nbMois)
        : (d.periodicite === 'trimestrielle' ? 3 : 1);
      if (duree === 1) return d.periode === ym;
      const [dy, dm] = d.periode.split('-').map(Number);
      const [cy, cm] = ym.split('-').map(Number);
      const ecart = (cy - dy) * 12 + (cm - dm);
      return ecart >= 0 && ecart < duree;
    };
    const docs = data.documents.filter((d) => couvre(d)
      && (d.locataireId === loc.id || memeNom(d.locataireNom, loc.nom)));
    if (docs.some((d) => d.type === 'quittance')) return 'paye';
    if (docs.some((d) => d.type === 'recu-partiel')) return 'partiel';
    if (horsSuivi(loc, ym)) return 'horssuivi';
    return loyerDu(loc, ym) ? 'impaye' : 'nondu';
  }

  function renderSuiviPaiements() {
    const ym = moisSuivi();
    byId('suivi-mois-label').textContent = moisLisible(ym);
    const tbody = document.querySelector('#table-suivi-paiements tbody');
    tbody.innerHTML = '';

    const actifs = data.locataires.filter((l) => l.actif !== false && !l.isTest);
    if (actifs.length === 0) {
      byId('suivi-resume').textContent = '';
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Aucun locataire actif.</td></tr>';
      return;
    }

    const libelles = { paye: 'Payé', partiel: 'Partiel', impaye: 'Non payé', nondu: 'Non dû ce mois', horssuivi: 'Hors suivi' };
    const classes = { paye: 'paie-ok', partiel: 'paie-partiel', impaye: 'paie-non', nondu: 'badge-inactive', horssuivi: 'badge-inactive' };
    const puces = { paye: '✓', partiel: '–', impaye: '✗', nondu: '—', horssuivi: '—' };
    let nbPayes = 0;
    let nbAttendus = 0;
    const impayes = [];

    actifs.forEach((l) => {
      const etat = etatPaiement(l, ym);
      if (etat !== 'nondu' && etat !== 'horssuivi') nbAttendus++;
      if (etat === 'paye') nbPayes++;
      else if (etat === 'impaye') impayes.push(l.nom);
      const bien = bienById(l.bienId);
      const mensuel = (Number(l.loyer) || 0) + (Number(l.charges) || 0);
      // Un loyer trimestriel appelle trois mois de loyer a l'echeance.
      const attendu = (etat === 'nondu' || etat === 'horssuivi') ? 0
        : mensuel * ((l.periodicite || 'mensuelle') === 'trimestrielle' ? 3 : 1);
      tbody.innerHTML += '<tr class="' + (etat === 'impaye' ? 'ligne-impaye' : '') + '">'
        + '<td data-label="Locataire">' + escapeHTML(l.nom) + '</td>'
        + '<td data-label="Bien">' + escapeHTML(bien ? bien.nom : '—') + '</td>'
        + '<td data-label="Montant attendu">' + (attendu ? euros(attendu) : '—') + '</td>'
        + '<td data-label="Statut"><span class="badge ' + classes[etat] + '">' + puces[etat] + ' ' + libelles[etat] + '</span></td>'
        + '<td class="actions-cell">'
        + ((etat === 'paye' || etat === 'nondu' || etat === 'horssuivi') ? ''
            : '<button class="btn btn-sm" data-quittance-loc="' + l.id + '">Établir la quittance</button>')
        + '</td></tr>';
    });

    byId('suivi-resume').textContent = nbAttendus === 0
      ? 'Aucun loyer attendu ce mois-ci (mois antérieur au suivi, ou aucune échéance).'
      : nbPayes + ' payé(s) sur ' + nbAttendus + ' attendu(s)'
      + (impayes.length ? ' \u2014 en attente : ' + impayes.join(', ') : ' \u2014 tout est à jour.');

    tbody.querySelectorAll('[data-quittance-loc]').forEach((btn) => btn.addEventListener('click', () => {
      showView('generer');
      byId('doc-type').value = 'quittance';
      byId('doc-type').dispatchEvent(new Event('change'));
      byId('doc-locataire').value = btn.dataset.quittanceLoc;
      byId('doc-locataire').dispatchEvent(new Event('change'));
      byId('doc-periode').value = ym;
    }));

    alerterImpayes(ym, impayes);
  }

  // Alerte à partir du 10 du mois si des loyers du mois en cours restent sans
  // quittance. Affichée une seule fois par jour et par appareil, pour prévenir
  // sans harceler à chaque ouverture.
  const ALERTE_KEY = 'qf_alerte_impayes';
  function alerterImpayes(ym, impayes) {
    const now = new Date();
    const moisCourant = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    if (ym !== moisCourant || now.getDate() < 10 || impayes.length === 0) return;
    const aujourdHui = todayISO();
    if (localStorage.getItem(ALERTE_KEY) === aujourdHui) return;
    localStorage.setItem(ALERTE_KEY, aujourdHui);
    setTimeout(() => {
      alert('Loyers sans quittance pour ' + (Documents.periodLabel(ym) || ym) + ' :\n\n'
        + impayes.map((n) => '\u2022 ' + n).join('\n')
        + '\n\nRetrouvez le détail dans le tableau de bord.');
    }, 600);
  }

  byId('suivi-mois').addEventListener('change', renderSuiviPaiements);


  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- Biens ----------
  function renderBiens() {
    const tbody = document.querySelector('#table-biens tbody');
    tbody.innerHTML = '';
    if (data.biens.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Aucun bien enregistré. Ajoutez votre premier bien.</td></tr>';
      return;
    }
    data.biens.forEach((b) => {
      tbody.innerHTML += `<tr>
        <td>${escapeHTML(b.nom)}</td>
        <td>${escapeHTML(b.adresse).replace(/\n/g, ', ')}</td>
        <td>${euros(b.loyer)}</td>
        <td>${euros(b.charges)}</td>
        <td class="actions-cell">
          <button class="btn btn-sm" data-edit-bien="${b.id}">Modifier</button>
          <button class="btn btn-sm" data-dup-bien="${b.id}">Dupliquer</button>
          <button class="btn btn-sm btn-danger" data-del-bien="${b.id}">Supprimer</button>
        </td>
      </tr>`;
    });
    tbody.querySelectorAll('[data-edit-bien]').forEach((btn) => btn.addEventListener('click', () => openBienModal(bienById(btn.dataset.editBien))));
    tbody.querySelectorAll('[data-dup-bien]').forEach((btn) => btn.addEventListener('click', () => duplicateBien(btn.dataset.dupBien)));
    tbody.querySelectorAll('[data-del-bien]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.delBien;
      const used = data.locataires.some((l) => l.bienId === id);
      if (used) { alert("Impossible de supprimer ce bien : un ou plusieurs locataires y sont rattachés."); return; }
      if (confirm('Supprimer ce bien ?')) {
        data.biens = data.biens.filter((b) => b.id !== id);
        save(); renderBiens();
      }
    }));
  }

  function duplicateBien(bienId, options) {
    const silent = !!(options && options.silent);
    const original = bienById(bienId);
    if (!original) return null;
    const newBien = Object.assign({}, original, { id: Storage.uid(), nom: `${original.nom} (copie)` });
    data.biens.push(newBien);
    const gabarit = data.bienGabarits.find((g) => g.bienId === bienId);
    if (gabarit) {
      data.bienGabarits.push({
        id: Storage.uid(),
        bienId: newBien.id,
        pieces: gabarit.pieces.map((room) => ({
          id: Storage.uid(),
          nom: room.nom,
          type: room.type,
          elements: room.elements.map((el) => ({ id: Storage.uid(), nom: el.nom })),
        })),
        compteurs: (gabarit.compteurs || []).map((m) => ({ id: Storage.uid(), nom: m.nom, numero: '' })),
        cles: (gabarit.cles || []).map((c) => ({ id: Storage.uid(), nom: c.nom })),
      });
    }
    save();
    renderBiens();
    if (!silent) {
      alert(`Bien dupliqué : « ${newBien.nom} ».${gabarit ? ' Les pièces, éléments, compteurs et clés ont été copiés (numéros de compteurs à ressaisir).' : ''} Pensez à corriger l'adresse et le loyer si besoin.`);
    }
    return newBien;
  }

  function openBienModal(existing) {
    const isEdit = !!existing;
    openModal(isEdit ? 'Modifier le bien' : 'Nouveau bien', `
      <div class="field"><label>Désignation</label><input type="text" id="m-bien-nom" placeholder="Appartement T2 - Rue de la Paix"></div>
      <div class="field"><label>Adresse</label><textarea id="m-bien-adresse" rows="3" placeholder="12 rue de la Paix&#10;75002 Paris"></textarea></div>
      <div class="field"><label>Loyer mensuel (€)</label><input type="number" step="0.01" id="m-bien-loyer"></div>
      <div class="field"><label>Charges mensuelles (€)</label><input type="number" step="0.01" id="m-bien-charges"></div>
      <div class="field"><label>Périodicité du loyer</label>
        <select id="m-bien-periodicite">
          <option value="mensuelle">Mensuelle</option>
          <option value="trimestrielle">Trimestrielle</option>
        </select></div>
      <div class="field" id="m-bien-mois-bloc" hidden><label>Premier mois d'échéance (puis tous les 3 mois)</label>
        <select id="m-bien-mois-depart"><option value="1">Janvier</option><option value="2">Février</option><option value="3">Mars</option><option value="4">Avril</option><option value="5">Mai</option><option value="6">Juin</option><option value="7">Juillet</option><option value="8">Août</option><option value="9">Septembre</option><option value="10">Octobre</option><option value="11">Novembre</option><option value="12">Décembre</option></select></div>
      <button class="btn btn-primary" id="m-bien-save">${isEdit ? 'Enregistrer' : 'Ajouter'}</button>
    `);
    if (isEdit) {
      byId('m-bien-nom').value = existing.nom || '';
      byId('m-bien-adresse').value = existing.adresse || '';
      byId('m-bien-loyer').value = existing.loyer || 0;
      byId('m-bien-charges').value = existing.charges || 0;
      byId('m-bien-periodicite').value = existing.periodicite || 'mensuelle';
      byId('m-bien-mois-depart').value = existing.moisDepart || 1;
    }
    const majPeriodiciteBien = () => {
      byId('m-bien-mois-bloc').hidden = byId('m-bien-periodicite').value !== 'trimestrielle';
    };
    byId('m-bien-periodicite').addEventListener('change', majPeriodiciteBien);
    majPeriodiciteBien();
    byId('m-bien-save').addEventListener('click', () => {
      const nom = byId('m-bien-nom').value.trim();
      const adresse = byId('m-bien-adresse').value.trim();
      if (!nom || !adresse) { alert('Merci de renseigner au moins la désignation et l\'adresse.'); return; }
      const record = {
        id: isEdit ? existing.id : Storage.uid(),
        nom,
        adresse,
        loyer: parseFloat(byId('m-bien-loyer').value) || 0,
        charges: parseFloat(byId('m-bien-charges').value) || 0,
        // Periodicite portee par le bien : elle sert de valeur par defaut aux
        // locataires de ce bien (cas d'un local commercial paye au trimestre).
        periodicite: byId('m-bien-periodicite').value,
        moisDepart: parseInt(byId('m-bien-mois-depart').value, 10) || 1,
      };
      if (isEdit) {
        Object.assign(existing, record);
      } else {
        data.biens.push(record);
      }
      save(); closeModal(); renderBiens(); renderGenererOptions();
    });
  }

  // ---------- Locataires ----------
  function renderLocataires() {
    const tbody = document.querySelector('#table-locataires tbody');
    tbody.innerHTML = '';
    if (data.locataires.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Aucun locataire enregistré.</td></tr>';
      return;
    }
    data.locataires.forEach((l) => {
      const bien = bienById(l.bienId);
      tbody.innerHTML += `<tr>
        <td>${escapeHTML(l.nom)}${l.designation ? ` <span class="badge badge-inactive">${escapeHTML(l.designation)}</span>` : ''}</td>
        <td>${bien ? escapeHTML(bien.nom) : '<em>Bien supprimé</em>'}</td>
        <td>${euros(l.loyer)}</td>
        <td>${euros(l.charges)}</td>
        <td><span class="badge ${l.actif === false ? 'badge-inactive' : 'badge-active'}">${l.actif === false ? 'Inactif' : 'Actif'}</span></td>
        <td class="actions-cell">
          <button class="btn btn-sm" data-edit-loc="${l.id}">Modifier</button>
          <button class="btn btn-sm btn-danger" data-del-loc="${l.id}">Supprimer</button>
        </td>
      </tr>`;
    });
    tbody.querySelectorAll('[data-edit-loc]').forEach((btn) => btn.addEventListener('click', () => openLocataireModal(locataireById(btn.dataset.editLoc))));
    tbody.querySelectorAll('[data-del-loc]').forEach((btn) => btn.addEventListener('click', () => deleteLocataireCascade(btn.dataset.delLoc)));
  }

  // Un locataire avec de l'historique (documents, bail, EDL...) ne doit pas etre
  // supprime "en un clic" : les SCI ont une obligation de conservation de ces
  // pieces pendant plusieurs annees. Le chemin par defaut est donc de le classer
  // en Ancien locataire (rien n'est supprime, tout reste consultable dans la
  // rubrique "Anciens locataires") ; la suppression definitive reste possible
  // mais demande une confirmation separee et explicite.
  async function deleteLocataireCascade(id) {
    const loc = locataireById(id);
    if (!loc) return;
    const relatedDocuments = data.documents.filter((d) => d.locataireId === id);
    const relatedBaux = data.baux.filter((b) => b.locataireId === id);
    const relatedEtatsDesLieux = data.etatsDesLieux.filter((e) => e.locataireId === id);
    const relatedDocsLoc = data.documentsLocataires.filter((d) => d.locataireId === id);
    const relatedBailRedactions = data.bailRedactions.filter((r) => r.locataireId === id);
    const relatedEdlRedactions = data.edlRedactions.filter((r) => r.locataireId === id);
    const totalRelated = relatedDocuments.length + relatedBaux.length + relatedEtatsDesLieux.length
      + relatedDocsLoc.length + relatedBailRedactions.length + relatedEdlRedactions.length;

    if (totalRelated === 0) {
      if (!confirm('Supprimer ce locataire ?')) return;
      data.locataires = data.locataires.filter((l) => l.id !== id);
      save();
      renderLocataires();
      renderDashboard();
      return;
    }

    const archiveInstead = confirm(
      `« ${loc.nom} » a ${totalRelated} élément(s) associé(s) (documents, bail, état des lieux...).\n\n`
      + "Pour conserver cet historique (obligation de conservation des pièces d'une SCI), cliquez sur OK pour le classer en « Ancien locataire » : rien n'est supprimé, tout reste consultable dans la rubrique \"Anciens locataires\".\n\n"
      + 'Cliquez sur Annuler pour voir plutôt les options de suppression définitive.'
    );
    if (archiveInstead) {
      loc.actif = false;
      save();
      renderLocataires();
      renderDashboard();
      alert(`« ${loc.nom} » a été classé en Ancien locataire. Retrouvez-le dans la rubrique "Anciens locataires" — tous ses documents restent accessibles.`);
      return;
    }

    const hardDelete = confirm(
      `Supprimer DÉFINITIVEMENT « ${loc.nom} » et ses ${totalRelated} élément(s) associé(s) (documents, baux, états des lieux, photos...) ?\n\n`
      + 'Cette action est IRRÉVERSIBLE et peut ne pas respecter vos obligations légales de conservation des documents. À réserver aux cas où ces données ne doivent vraiment plus exister (ex : doublon, erreur de saisie).'
    );
    if (!hardDelete) return;

    for (const b of relatedBaux) await deleteRecordFiles(b);
    for (const e of relatedEtatsDesLieux) await deleteRecordFiles(e);
    for (const d of relatedDocsLoc) await deleteRecordFiles(d);
    for (const r of relatedEdlRedactions) await purgeEdlRedactionFiles(r);

    data.documents = data.documents.filter((d) => d.locataireId !== id);
    data.baux = data.baux.filter((b) => b.locataireId !== id);
    data.etatsDesLieux = data.etatsDesLieux.filter((e) => e.locataireId !== id);
    data.documentsLocataires = data.documentsLocataires.filter((d) => d.locataireId !== id);
    data.bailRedactions = data.bailRedactions.filter((r) => r.locataireId !== id);
    data.edlRedactions = data.edlRedactions.filter((r) => r.locataireId !== id);
    data.locataires = data.locataires.filter((l) => l.id !== id);

    save();
    renderLocataires();
    renderDashboard();
  }

  function openLocataireModal(existing) {
    const isEdit = !!existing;
    if (data.biens.length === 0) {
      alert("Ajoutez d'abord un bien avant de créer un locataire.");
      return;
    }
    const bienOptions = data.biens.map((b) => `<option value="${b.id}">${escapeHTML(b.nom)}</option>`).join('');
    openModal(isEdit ? 'Modifier le locataire' : 'Nouveau locataire', `
      <div class="field"><label>Nom du locataire</label><input type="text" id="m-loc-nom" placeholder="Mme et Mr Nouqueret"></div>
      <div class="field"><label>Bien loué</label><select id="m-loc-bien">${bienOptions}</select></div>
      <div class="field"><label>Désignation (optionnel)</label><input type="text" id="m-loc-designation" placeholder="MAISON 2"></div>
      <div class="field"><label>Adresse de correspondance (si différente de l'adresse du bien)</label><textarea id="m-loc-adresse" rows="2" placeholder="Laisser vide pour utiliser l'adresse du bien"></textarea></div>
      <div class="field"><label>Loyer mensuel (€)</label><input type="number" step="0.01" id="m-loc-loyer"></div>
      <div class="field"><label>Charges mensuelles (€)</label><input type="number" step="0.01" id="m-loc-charges"></div>
      <div class="field"><label>Date d'entrée</label><input type="date" id="m-loc-date"></div>
      <div class="field"><label>Périodicité du loyer</label>
        <select id="m-loc-periodicite">
          <option value="mensuelle">Mensuelle</option>
          <option value="trimestrielle">Trimestrielle</option>
        </select></div>
      <div class="field" id="m-loc-mois-bloc" hidden><label>Premier mois d'échéance (puis tous les 3 mois)</label>
        <select id="m-loc-mois-depart"><option value="1">Janvier</option><option value="2">Février</option><option value="3">Mars</option><option value="4">Avril</option><option value="5">Mai</option><option value="6">Juin</option><option value="7">Juillet</option><option value="8">Août</option><option value="9">Septembre</option><option value="10">Octobre</option><option value="11">Novembre</option><option value="12">Décembre</option></select></div>
      <div class="field"><label>Lieu de naissance (pour avenants/baux)</label><input type="text" id="m-loc-lieu-naissance" placeholder="Bordeaux"></div>
      <div class="field"><label>Date de naissance (pour avenants/baux)</label><input type="date" id="m-loc-date-naissance"></div>
      <div class="field"><label>E-mail 1</label><input type="email" id="m-loc-email1" placeholder="locataire@exemple.fr"></div>
      <div class="field"><label>E-mail 2 (optionnel, si couple)</label><input type="email" id="m-loc-email2" placeholder="conjoint@exemple.fr"></div>
      <div class="field"><label>Téléphone portable 1</label><input type="tel" id="m-loc-tel1" placeholder="06 12 34 56 78"></div>
      <div class="field"><label>Téléphone portable 2 (optionnel, si couple)</label><input type="tel" id="m-loc-tel2" placeholder="06 98 76 54 32"></div>
      <div class="field"><label><input type="checkbox" id="m-loc-actif" style="width:auto;margin-right:6px;">Locataire actif</label></div>
      <button class="btn btn-primary" id="m-loc-save">${isEdit ? 'Enregistrer' : 'Ajouter'}</button>
    `);
    byId('m-loc-actif').checked = isEdit ? existing.actif !== false : true;
    if (isEdit) {
      byId('m-loc-nom').value = existing.nom || '';
      byId('m-loc-bien').value = existing.bienId || '';
      byId('m-loc-designation').value = existing.designation || '';
      byId('m-loc-adresse').value = existing.adresseDestinataire || '';
      byId('m-loc-loyer').value = existing.loyer || 0;
      byId('m-loc-charges').value = existing.charges || 0;
      byId('m-loc-date').value = existing.dateEntree || '';
      byId('m-loc-lieu-naissance').value = existing.lieuNaissance || '';
      byId('m-loc-date-naissance').value = existing.dateNaissance || '';
      byId('m-loc-email1').value = existing.email1 || existing.email || '';
      byId('m-loc-email2').value = existing.email2 || '';
      byId('m-loc-tel1').value = existing.tel1 || existing.tel || '';
      byId('m-loc-tel2').value = existing.tel2 || '';
      byId('m-loc-periodicite').value = existing.periodicite || 'mensuelle';
      byId('m-loc-mois-depart').value = existing.moisDepart || 1;
    } else {
      const b = data.biens[0];
      byId('m-loc-loyer').value = b.loyer || 0;
      byId('m-loc-charges').value = b.charges || 0;
      byId('m-loc-periodicite').value = b.periodicite || 'mensuelle';
      byId('m-loc-mois-depart').value = b.moisDepart || 1;
    }
    const majPeriodicite = () => {
      byId('m-loc-mois-bloc').hidden = byId('m-loc-periodicite').value !== 'trimestrielle';
    };
    byId('m-loc-periodicite').addEventListener('change', majPeriodicite);
    majPeriodicite();
    byId('m-loc-bien').addEventListener('change', () => {
      const b = bienById(byId('m-loc-bien').value);
      if (b && !isEdit) {
        byId('m-loc-loyer').value = b.loyer || 0;
        byId('m-loc-charges').value = b.charges || 0;
        byId('m-loc-periodicite').value = b.periodicite || 'mensuelle';
        byId('m-loc-mois-depart').value = b.moisDepart || 1;
        majPeriodicite();
      }
    });
    byId('m-loc-save').addEventListener('click', () => {
      const nom = byId('m-loc-nom').value.trim();
      if (!nom) { alert('Merci de renseigner le nom du locataire.'); return; }
      const record = {
        id: isEdit ? existing.id : Storage.uid(),
        nom,
        bienId: byId('m-loc-bien').value,
        designation: byId('m-loc-designation').value.trim(),
        adresseDestinataire: byId('m-loc-adresse').value.trim(),
        loyer: parseFloat(byId('m-loc-loyer').value) || 0,
        charges: parseFloat(byId('m-loc-charges').value) || 0,
        dateEntree: byId('m-loc-date').value,
        // Périodicité du loyer : un loyer trimestriel n'est dû que tous les
        // trois mois, à partir du mois d'échéance choisi (ex : janvier, avril,
        // juillet, octobre). Sans cela, le suivi des paiements signalait à tort
        // un impayé les deux mois sur trois où rien n'est attendu.
        periodicite: byId('m-loc-periodicite').value,
        moisDepart: parseInt(byId('m-loc-mois-depart').value, 10) || 1,
        lieuNaissance: byId('m-loc-lieu-naissance').value.trim(),
        dateNaissance: byId('m-loc-date-naissance').value,
        email1: byId('m-loc-email1').value.trim(),
        email2: byId('m-loc-email2').value.trim(),
        tel1: byId('m-loc-tel1').value.trim(),
        tel2: byId('m-loc-tel2').value.trim(),
        actif: byId('m-loc-actif').checked,
      };
      if (isEdit) {
        Object.assign(existing, record);
      } else {
        data.locataires.push(record);
      }
      save(); closeModal(); renderLocataires(); renderGenererOptions();
    });
  }

  // ---------- Historique ----------
  // L'historique regroupe les documents générés (quittances, courriers...) ET
  // les états des lieux finalisés — ces derniers sont archivés dans
  // data.etatsDesLieux au moment de la génération du PDF (voir archiveEdlPdf),
  // les brouillons en cours de rédaction n'y figurent donc pas.
  function lignesHistorique() {
    const docs = data.documents.map((d) => ({
      tri: d.createdAt || 0,
      dateLabel: d.dateLabel || '—',
      type: DOC_LABELS[d.type] || d.type,
      locataireNom: d.locataireNom || '—',
      periodeLabel: d.periodeLabel || '—',
      montant: d.montant != null ? euros(d.montant) : '—',
      montantValeur: d.montant != null ? Number(d.montant) : null,
      actions: `<button class="btn btn-sm" data-view-doc="${d.id}">Télécharger le PDF</button>
          <button class="btn btn-sm btn-danger" data-del-doc="${d.id}">Supprimer</button>`,
    }));
    const edl = data.etatsDesLieux.map((e) => {
      const loc = locataireById(e.locataireId);
      return {
        tri: e.createdAt || (e.date ? Date.parse(`${e.date}T00:00:00`) : 0),
        dateLabel: e.date ? new Date(`${e.date}T00:00:00`).toLocaleDateString('fr-FR') : '—',
        type: e.sens === 'sortant' ? 'État des lieux sortant' : 'État des lieux entrant',
        locataireNom: loc ? loc.nom : '—',
        periodeLabel: e.libelle || '—',
        montant: '—',
        montantValeur: null,
        actions: `${fileLinksHTML(e)}
          <button class="btn btn-sm btn-danger" data-del-edl="${e.id}">Supprimer</button>`,
      };
    });
    return docs.concat(edl).sort((a, b) => b.tri - a.tri);
  }

  // Tri et filtres de la vue Historique (demande utilisateur : trier par date,
  // par type de document et par locataire).
  let histTri = { colonne: 'date', sens: 'desc' };

  function peuplerFiltresHistorique(lignes) {
    const remplir = (selectId, valeurs) => {
      const sel = byId(selectId);
      const choix = sel.value;
      const premier = sel.options[0].outerHTML;
      sel.innerHTML = premier + [...new Set(valeurs)].sort((a, b) => a.localeCompare(b, 'fr'))
        .map((v) => '<option value="' + escapeHTML(v) + '">' + escapeHTML(v) + '</option>').join('');
      sel.value = choix;              // conserve la sélection si elle existe encore
      if (sel.value !== choix) sel.value = '';
    };
    remplir('hist-filtre-type', lignes.map((l) => l.type));
    remplir('hist-filtre-locataire', lignes.map((l) => l.locataireNom));
  }

  function trierHistorique(lignes) {
    const sens = histTri.sens === 'asc' ? 1 : -1;
    const cle = {
      date: (l) => l.tri,
      type: (l) => l.type,
      locataire: (l) => l.locataireNom,
      // Les lignes sans montant (états des lieux) restent groupées à une extrémité.
      montant: (l) => (l.montantValeur == null ? -Infinity : l.montantValeur),
    }[histTri.colonne];
    return [...lignes].sort((a, b) => {
      const va = cle(a); const vb = cle(b);
      if (typeof va === 'string') return va.localeCompare(vb, 'fr') * sens;
      return (va - vb) * sens;
    });
  }

  function majEntetesHistorique() {
    document.querySelectorAll('#table-historique .th-triable').forEach((th) => {
      const actif = th.dataset.tri === histTri.colonne;
      th.classList.toggle('tri-actif', actif);
      const libelle = th.dataset.libelle || th.textContent.trim();
      th.dataset.libelle = libelle;
      const fleche = actif ? (histTri.sens === 'asc' ? '\u25B2' : '\u25BC') : '';
      th.innerHTML = libelle + (fleche ? ' <span class="tri-fleche">' + fleche + '</span>' : '');
    });
  }

  document.querySelectorAll('#table-historique .th-triable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.tri;
      if (histTri.colonne === col) histTri.sens = histTri.sens === 'asc' ? 'desc' : 'asc';
      else histTri = { colonne: col, sens: (col === 'date' || col === 'montant') ? 'desc' : 'asc' };
      renderHistorique();
    });
  });
  byId('hist-filtre-type').addEventListener('change', renderHistorique);
  byId('hist-filtre-locataire').addEventListener('change', renderHistorique);

  function renderHistorique() {
    const tbody = document.querySelector('#table-historique tbody');
    tbody.innerHTML = '';
    const toutes = lignesHistorique();
    peuplerFiltresHistorique(toutes);
    majEntetesHistorique();

    const fType = byId('hist-filtre-type').value;
    const fLoc = byId('hist-filtre-locataire').value;
    const filtrees = toutes.filter((l) =>
      (!fType || l.type === fType) && (!fLoc || l.locataireNom === fLoc));

    byId('hist-compte').textContent = filtrees.length === toutes.length
      ? toutes.length + ' document(s).'
      : filtrees.length + ' document(s) affiché(s) sur ' + toutes.length + '.';

    if (filtrees.length === 0) {
      tbody.innerHTML = toutes.length === 0
        ? '<tr class="empty-row"><td colspan="6">Aucun document dans l\'historique.</td></tr>'
        : '<tr class="empty-row"><td colspan="6">Aucun document ne correspond à ces filtres.</td></tr>';
      return;
    }
    const sorted = trierHistorique(filtrees);
    sorted.forEach((l) => {
      tbody.innerHTML += `<tr>
        <td data-label="Date">${l.dateLabel}</td>
        <td data-label="Type">${escapeHTML(l.type)}</td>
        <td data-label="Locataire">${escapeHTML(l.locataireNom)}</td>
        <td data-label="Période">${escapeHTML(l.periodeLabel)}</td>
        <td data-label="Montant">${l.montant}</td>
        <td class="actions-cell">${l.actions}</td>
      </tr>`;
    });
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-edl]').forEach((btn) => btn.addEventListener('click', () => deleteEdl(btn.dataset.delEdl)));
    tbody.querySelectorAll('[data-view-doc]').forEach((btn) => btn.addEventListener('click', () => {
      const doc = data.documents.find((d) => d.id === btn.dataset.viewDoc);
      if (doc && doc.ctx) downloadPdf(doc.type, doc.ctx);
    }));
    tbody.querySelectorAll('[data-del-doc]').forEach((btn) => btn.addEventListener('click', () => {
      if (confirm('Supprimer ce document de l\'historique ?')) {
        data.documents = data.documents.filter((d) => d.id !== btn.dataset.delDoc);
        save(); renderHistorique(); renderDashboard();
      }
    }));
  }

  function downloadPdf(type, ctx) {
    // La signature est toujours reprise depuis "Ma SCI" au moment du telechargement
    // (jamais stockee dans l'historique) pour ne pas dupliquer une image en base64
    // dans chaque document sauvegarde.
    const { doc, nomFichier } = buildPdf(type, ctx);
    doc.save(nomFichier);
  }

  // Prépare le PDF sans déclencher le téléchargement, pour pouvoir enregistrer
  // le document AVANT de lancer doc.save() (qui, sur iOS, fait quitter la page).
  function buildPdf(type, ctx) {
    const fullCtx = Object.assign({}, ctx, { signatureDataUrl: data.sci.signature || '' });
    return { doc: PdfBuilder.generate(type, fullCtx), nomFichier: PdfBuilder.filename(type, fullCtx) };
  }

  // ---------- Parametres (Mon SCI) ----------
  function fillSciForm() {
    byId('sci-nom').value = data.sci.nom || '';
    byId('sci-adresse').value = data.sci.adresse || '';
    byId('sci-ville').value = data.sci.ville || '';
    byId('sci-siret').value = data.sci.siret || '';
    byId('sci-capital').value = data.sci.capitalSocial || '';
    byId('sci-gerant').value = data.sci.gerant || '';
    byId('sci-email').value = data.sci.email || '';
    byId('sci-tel').value = data.sci.tel || '';
    renderSignaturePreview();
    updateSyncMetaStatus();
    renderPinStatus();
  }

  function updateSyncMetaStatus() {
    const el = byId('sync-meta-status');
    if (!el) return;
    if (!data.syncMeta || !data.syncMeta.updatedAt) { el.textContent = ''; return; }
    const d = new Date(data.syncMeta.updatedAt);
    const when = isNaN(d) ? '' : d.toLocaleString('fr-FR');
    const fromHere = data.syncMeta.updatedBy === deviceId();
    el.textContent = when ? `Dernière modification : ${when}${fromHere ? '' : ' (depuis un autre appareil)'}.` : '';
  }
  byId('btn-save-sci').addEventListener('click', () => {
    data.sci.nom = byId('sci-nom').value.trim();
    data.sci.adresse = byId('sci-adresse').value.trim();
    data.sci.ville = byId('sci-ville').value.trim();
    data.sci.siret = byId('sci-siret').value.trim();
    data.sci.capitalSocial = byId('sci-capital').value.trim();
    data.sci.gerant = byId('sci-gerant').value.trim();
    data.sci.email = byId('sci-email').value.trim();
    data.sci.tel = byId('sci-tel').value.trim();
    save();
    alert('Informations enregistrées.');
  });

  // ---------- Code d'accès local (en plus de la connexion Firebase) ----------
  // Demandé à chaque ouverture. Le code n'est jamais stocké en clair : on
  // conserve une empreinte PBKDF2 (200 000 itérations, sel aléatoire).
  // Portée honnête de cette protection : elle empêche un accès de passage sur
  // un appareil déverrouillé. Elle ne chiffre PAS les données — quelqu'un de
  // technique pourrait la contourner localement. La protection des données
  // reste l'authentification Firebase et les règles de sécurité.
  const PIN_KEY = 'qf_pin_v1';

  function pinConfig() {
    try { return JSON.parse(localStorage.getItem(PIN_KEY) || 'null'); } catch (e) { return null; }
  }

  function hexOf(buffer) {
    return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function derivePin(code, saltHex, iterations) {
    const enc = new TextEncoder();
    const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
    return hexOf(bits);
  }

  function renderPinStatus() {
    const el = byId('pin-status');
    if (el) el.textContent = pinConfig() ? 'Code activé' : 'Aucun code défini';
  }

  // Verrouille si un code est configuré. Appelé après résolution de la session.
  function applyPinLock() {
    document.documentElement.classList.toggle('qf-pin-locked', !!pinConfig());
    if (pinConfig()) setTimeout(() => byId('pin-input').focus(), 50);
  }

  byId('pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfg = pinConfig();
    if (!cfg) { document.documentElement.classList.remove('qf-pin-locked'); return; }
    const saisi = await derivePin(byId('pin-input').value, cfg.salt, cfg.iterations);
    if (saisi === cfg.hash) {
      document.documentElement.classList.remove('qf-pin-locked');
      byId('pin-error').hidden = true;
      byId('pin-input').value = '';
    } else {
      byId('pin-error').hidden = false;
      byId('pin-input').value = '';
      byId('pin-input').focus();
    }
  });

  byId('btn-pin-save').addEventListener('click', async () => {
    const code = byId('pin-new').value;
    const confirmation = byId('pin-confirm').value;
    if (code.length < 4) { alert('Le code doit contenir au moins 4 caractères.'); return; }
    if (code !== confirmation) { alert('Les deux codes saisis ne correspondent pas.'); return; }
    const salt = hexOf(crypto.getRandomValues(new Uint8Array(16)));
    const iterations = 200000;
    const hash = await derivePin(code, salt, iterations);
    localStorage.setItem(PIN_KEY, JSON.stringify({ salt, iterations, hash }));
    byId('pin-new').value = '';
    byId('pin-confirm').value = '';
    renderPinStatus();
    alert("Code enregistré. Il sera demandé à la prochaine ouverture de l'application.");
  });

  byId('btn-pin-remove').addEventListener('click', () => {
    if (!pinConfig()) { alert("Aucun code n'est défini."); return; }
    if (!confirm("Supprimer le code d'accès ? L'application s'ouvrira alors directement après connexion.")) return;
    localStorage.removeItem(PIN_KEY);
    renderPinStatus();
    alert('Code supprimé.');
  });

  // ---------- Authentification (Firebase, voir js/firebaseAuth.js) ----------
  // Changement distant reçu depuis Firestore (autre appareil, ou premier
  // démarrage sur ce compte). remoteData === null signifie qu'aucun document
  // n'existe encore pour ce compte : on y pousse alors les données locales
  // actuelles comme point de départ.
  // L'appareil contient-il de vraies données métier ? Sert de garde-fou avant
  // de publier quoi que ce soit vers le cloud.
  function hasLocalContent() {
    const lists = ['biens', 'locataires', 'documents', 'charges', 'baux', 'etatsDesLieux',
      'documentsAdmin', 'documentsLocataires', 'credits', 'bailRedactions',
      'facturesTravaux', 'bienGabarits', 'edlRedactions', 'edlModeles'];
    if (lists.some((k) => Array.isArray(data[k]) && data[k].length > 0)) return true;
    return !!(data.sci && (data.sci.nom || data.sci.siret));
  }

  function onRemoteData(remoteData) {
    if (remoteData === null) {
      // Le cloud n'a pas (encore) de données exploitables. On n'y publie la
      // copie locale QUE si elle contient réellement quelque chose : un
      // appareil vide (navigation privée, nouveau profil, cache navigateur
      // effacé, nouvelle installation) ne doit JAMAIS pouvoir remplacer les
      // données du cloud par du vide — ce vide redescendrait ensuite sur les
      // autres appareils.
      if (hasLocalContent()) save();
      else console.warn('Aucune donnée locale : rien n\'est publié vers le cloud (protection).');
      return;
    }
    Object.assign(data, Storage.mergeWithDefaults(remoteData));
    // Les données venues du cloud peuvent encore contenir les anciennes copies
    // de signature : on les allège ici aussi, sinon un appareil déjà nettoyé
    // les récupérerait à chaque synchronisation. Si on a allégé quelque chose,
    // save() renvoie la version épurée vers le cloud pour les autres appareils.
    if (purgeSignaturesDupliquees(data)) { save(); refreshCurrentView(); return; }
    // Un changement venu du cloud doit AUSSI être écrit dans le stockage local :
    // sinon un simple rechargement de page relit l'ancienne copie locale et la
    // modification faite depuis l'autre appareil disparaît de l'écran.
    // (On écrit directement via Storage, pas via save(), qui renverrait ces
    // mêmes données vers le cloud en boucle.)
    Storage.save(data);
    refreshCurrentView();
  }

  function appliquerEtatAuth(user) {
    // Firebase a répondu : on sait maintenant si la session est déjà ouverte.
    // Avant ça, le formulaire de connexion reste caché (voir .qf-auth-pending)
    // pour ne pas l'afficher une fraction de seconde inutilement.
    document.documentElement.classList.remove('qf-auth-pending');
    if (user) {
      document.documentElement.classList.remove('qf-locked');
      byId('login-error').hidden = true;
      byId('login-form').reset();
      byId('account-email').textContent = user.email || '—';
      if (window.QfSync) window.QfSync.start(user.uid, onRemoteData);
      FilesDb.retryPendingUploads().catch((e) => console.error(e));
      applyPinLock();
    } else {
      document.documentElement.classList.add('qf-locked');
      byId('account-email').textContent = '—';
      if (window.QfSync) window.QfSync.stop();
      document.documentElement.classList.remove('qf-pin-locked');
    }
  }

  window.addEventListener('qf-auth-change', (e) => appliquerEtatAuth(e.detail.user));

  // Le chargement des données étant asynchrone (IndexedDB), Firebase a pu
  // répondre AVANT que l'abonnement ci-dessus n'existe : dans ce cas
  // l'évènement est déjà passé et l'application resterait bloquée sur l'écran
  // de connexion. On rejoue donc l'état déjà connu.
  if (window.QfAuth && window.QfAuth.resolved) appliquerEtatAuth(window.QfAuth.currentUser);

  // Retente les fichiers dont l'envoi cloud avait échoué (hors-ligne ou
  // erreur réseau) dès que le navigateur retrouve une connexion.
  window.addEventListener('online', () => {
    FilesDb.retryPendingUploads().catch((e) => console.error(e));
  });

  byId('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = byId('login-email').value.trim();
    const password = byId('login-password').value;
    const btn = byId('login-submit-btn');
    byId('login-error').hidden = true;
    btn.disabled = true;
    window.QfAuth.signIn(email, password)
      .catch(() => {
        byId('login-error').hidden = false;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });

  byId('btn-logout').addEventListener('click', () => {
    window.QfAuth.signOut();
  });

  function renderSignaturePreview() {
    const hasSignature = !!data.sci.signature;
    byId('sci-signature-preview').hidden = !hasSignature;
    if (hasSignature) byId('sci-signature-preview').src = data.sci.signature;
    byId('sci-signature-empty').hidden = hasSignature;
    byId('btn-signature-remove').hidden = !hasSignature;
  }

  byId('btn-signature-upload').addEventListener('click', () => byId('sci-signature-file').click());
  byId('sci-signature-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      data.sci.signature = reader.result;
      save();
      renderSignaturePreview();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });
  byId('btn-signature-remove').addEventListener('click', () => {
    if (!confirm('Supprimer la signature enregistrée ?')) return;
    data.sci.signature = '';
    save();
    renderSignaturePreview();
  });

  // ---------- Generer un document ----------
  const typeSelect = byId('doc-type');
  const locSelect = byId('doc-locataire');

  typeSelect.addEventListener('change', updateDocFieldsVisibility);
  locSelect.addEventListener('change', prefillFromLocataire);

  // Rappelle la periode reellement couverte et le montant total, pour eviter
  // toute ambiguite au moment d'emettre une quittance trimestrielle.
  function majNotePeriodicite() {
    const note = byId('doc-periodicite-note');
    if (!note) return;
    const nbMois = byId('doc-periodicite').value === 'trimestrielle' ? 3 : 1;
    const periode = byId('doc-periode').value;
    if (!periode || typeSelect.value !== 'quittance') { note.textContent = ''; return; }
    const loyer = parseFloat(byId('doc-loyer').value) || 0;
    const charges = parseFloat(byId('doc-charges').value) || 0;
    const total = (loyer + charges) * nbMois;
    note.textContent = 'Période couverte : ' + Documents.periodLabel(periode, nbMois)
      + (total ? ' — total quittancé : ' + euros(total) : '');
  }

  // La periodicite proposee suit celle du locataire (heritee du bien).
  function appliquerPeriodiciteLocataire() {
    const l = locataireById(locSelect.value);
    if (!l) return;
    byId('doc-periodicite').value = l.periodicite === 'trimestrielle' ? 'trimestrielle' : 'mensuelle';
    majNotePeriodicite();
  }

  byId('doc-periodicite').addEventListener('change', majNotePeriodicite);
  byId('doc-periode').addEventListener('change', majNotePeriodicite);
  ['doc-loyer', 'doc-charges'].forEach((id) => byId(id).addEventListener('input', majNotePeriodicite));

  function updateDocFieldsVisibility() {
    const type = typeSelect.value;
    byId('fields-quittance').hidden = type !== 'quittance';
    byId('fields-recu-partiel').hidden = type !== 'recu-partiel';
    byId('fields-relance').hidden = type !== 'relance';
    byId('fields-avenant').hidden = type !== 'avenant';
    byId('fields-libre').hidden = type !== 'libre';
    byId('field-periode').hidden = type === 'libre' || type === 'avenant';
    // La periodicite ne concerne que la quittance de loyer.
    byId('field-periodicite').hidden = type !== 'quittance';
    majNotePeriodicite();
    if (type === 'avenant') {
      byId('avenant-date-effet').value = byId('avenant-date-effet').value || todayISO();
      renderAvenantChargesEditor(AVENANT_DEFAULT_LINES);
    }
    resetPreview();
  }

  function renderGenererOptions() {
    const current = locSelect.value;
    locSelect.innerHTML = data.locataires.map((l) => `<option value="${l.id}">${escapeHTML(l.nom)}</option>`).join('');
    if (data.locataires.length === 0) {
      locSelect.innerHTML = '<option value="">Aucun locataire — ajoutez-en un</option>';
    } else if (current && locataireById(current)) {
      locSelect.value = current;
    }
    byId('doc-ville').value = byId('doc-ville').value || data.sci.ville || '';
    const now = new Date();
    byId('doc-periode').value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    updateDocFieldsVisibility();
    prefillFromLocataire();
  }

  function prefillFromLocataire() {
    const l = locataireById(locSelect.value);
    if (!l) return;
    byId('doc-loyer').value = l.loyer;
    byId('doc-charges').value = l.charges;
    byId('doc-total-du').value = (Number(l.loyer) || 0) + (Number(l.charges) || 0);
    byId('doc-montant-paye').value = '';
    byId('doc-montant-impaye').value = '';
    if (!byId('doc-ville').value) byId('doc-ville').value = data.sci.ville || '';
    appliquerPeriodiciteLocataire();
  }

  function createChargeRowElement(line) {
    const div = document.createElement('div');
    div.className = 'avenant-charge-row';
    div.innerHTML = `
      <input type="text" class="avenant-charge-libelle" placeholder="Libellé">
      <input type="number" step="0.01" class="avenant-charge-montant" placeholder="€/mois">
      <input type="text" class="avenant-charge-note" placeholder="Note (contractuel, prévisionnel...)">
      <button type="button" class="btn btn-sm btn-danger avenant-charge-remove">Supprimer</button>
    `;
    div.querySelector('.avenant-charge-libelle').value = line.libelle || '';
    div.querySelector('.avenant-charge-montant').value = line.montant === '' || line.montant == null ? '' : line.montant;
    div.querySelector('.avenant-charge-note').value = line.note || '';
    div.querySelectorAll('input').forEach((input) => input.addEventListener('input', updateAvenantTotal));
    div.querySelector('.avenant-charge-remove').addEventListener('click', () => {
      div.remove();
      updateAvenantTotal();
    });
    return div;
  }

  function renderAvenantChargesEditor(lines) {
    const container = byId('avenant-charges-list');
    container.innerHTML = '';
    lines.forEach((line) => container.appendChild(createChargeRowElement(line)));
    updateAvenantTotal();
  }

  function updateAvenantTotal() {
    let total = 0;
    document.querySelectorAll('#avenant-charges-list .avenant-charge-montant').forEach((input) => {
      total += parseFloat(input.value) || 0;
    });
    byId('avenant-charges-total').textContent = euros(total);
  }

  function collectAvenantChargeLines() {
    const rows = document.querySelectorAll('#avenant-charges-list .avenant-charge-row');
    return [...rows].map((row) => ({
      libelle: row.querySelector('.avenant-charge-libelle').value.trim(),
      montant: parseFloat(row.querySelector('.avenant-charge-montant').value) || 0,
      note: row.querySelector('.avenant-charge-note').value.trim(),
    })).filter((line) => line.libelle || line.montant);
  }

  byId('btn-avenant-add-line').addEventListener('click', () => {
    byId('avenant-charges-list').appendChild(createChargeRowElement({ libelle: '', montant: '', note: '' }));
    updateAvenantTotal();
  });

  function resetPreview() {
    byId('doc-preview').className = 'doc-empty';
    byId('doc-preview').innerHTML = "L'aperçu du document apparaîtra ici.";
    byId('btn-download-pdf').disabled = true;
    lastGenerated = null;
  }

  let lastGenerated = null;

  byId('btn-generate').addEventListener('click', () => {
    const l = locataireById(locSelect.value);
    if (!l) { alert('Sélectionnez un locataire.'); return; }
    const bien = bienById(l.bienId);
    if (!bien) { alert('Le bien associé à ce locataire est introuvable.'); return; }

    const type = typeSelect.value;
    const periode = byId('doc-periode').value;
    // Une quittance trimestrielle couvre trois mois a partir du mois choisi.
    const periodicite = byId('doc-periodicite').value;
    const nbMois = periodicite === 'trimestrielle' ? 3 : 1;
    const periodeLabel = type === 'libre' ? '' : Documents.periodLabel(periode, nbMois);

    const bailleurBlock = [data.sci.nom, data.sci.adresse, data.sci.siret ? `SIRET : ${data.sci.siret}` : '']
      .filter(Boolean).join('\n');
    const locataireBlock = [l.nom, l.designation, l.adresseDestinataire || bien.adresse].filter(Boolean).join('\n');

    const ctx = {
      bailleurNom: data.sci.nom || '(Nom du bailleur non renseigné)',
      bailleurBlock,
      locataireNom: l.nom,
      locataireBlock,
      locationAdresse: bien.adresse,
      periode,
      periodeLabel,
      ville: byId('doc-ville').value.trim() || data.sci.ville || '',
      dateDuJour: Documents.todayFR(),
    };

    let montant = null;

    if (type === 'quittance') {
      // Les champs saisis sont mensuels : sur un trimestre, on quittance trois
      // fois le loyer et les charges.
      ctx.loyer = (parseFloat(byId('doc-loyer').value) || 0) * nbMois;
      ctx.charges = (parseFloat(byId('doc-charges').value) || 0) * nbMois;
      montant = ctx.loyer + ctx.charges;
    } else if (type === 'recu-partiel') {
      ctx.totalDu = parseFloat(byId('doc-total-du').value) || 0;
      ctx.montantPaye = parseFloat(byId('doc-montant-paye').value) || 0;
      montant = ctx.montantPaye;
    } else if (type === 'relance') {
      ctx.montantImpaye = parseFloat(byId('doc-montant-impaye').value) || 0;
      montant = ctx.montantImpaye;
    } else if (type === 'avenant') {
      ctx.sciNom = data.sci.nom || '';
      ctx.sciCapital = data.sci.capitalSocial || '';
      ctx.sciRcsVille = data.sci.ville || '';
      ctx.sciSiret = data.sci.siret || '';
      ctx.sciAdresse = data.sci.adresse || '';
      ctx.gerant = data.sci.gerant || '';
      ctx.locataireNaissanceLieu = l.lieuNaissance || '';
      ctx.locataireNaissanceDate = l.dateNaissance ? new Date(`${l.dateNaissance}T00:00:00`).toLocaleDateString('fr-FR') : '';
      ctx.locataireAdresse = l.adresseDestinataire || bien.adresse;
      ctx.dateContratInitial = l.dateEntree ? new Date(`${l.dateEntree}T00:00:00`).toLocaleDateString('fr-FR') : '';
      ctx.dateEffet = byId('avenant-date-effet').value ? new Date(`${byId('avenant-date-effet').value}T00:00:00`).toLocaleDateString('fr-FR') : '';
      ctx.chargeLines = collectAvenantChargeLines();
      ctx.totalCharges = ctx.chargeLines.reduce((sum, line) => sum + (Number(line.montant) || 0), 0);
      montant = ctx.totalCharges;
    } else if (type === 'libre') {
      ctx.objet = byId('doc-objet').value.trim();
      ctx.message = byId('doc-message').value;
    }

    if (!ctx.bailleurNom || data.sci.nom === '') {
      if (!confirm("Les informations de votre SCI (nom du bailleur) ne sont pas renseignées dans 'Ma SCI'. Continuer quand même ?")) return;
    }

    const html = Documents.build(type, ctx);
    const preview = byId('doc-preview');
    preview.className = '';
    preview.innerHTML = html;
    byId('btn-download-pdf').disabled = false;

    lastGenerated = { type, locataireId: l.id, locataireNom: l.nom, periode, periodeLabel, montant, ctx,
      // Conservee pour le suivi des paiements : une quittance trimestrielle
      // couvre aussi les deux mois suivants.
      periodicite, nbMois };
  });

  byId('btn-download-pdf').addEventListener('click', () => {
    if (!lastGenerated) return;
    // Le PDF est préparé, puis le document est enregistré dans l'historique,
    // et SEULEMENT ensuite le téléchargement est déclenché : sur iOS,
    // doc.save() ouvre le PDF et fait quitter la page, ce qui interrompait le
    // script — la quittance était téléchargée mais jamais inscrite à
    // l'historique (même cause que pour les états des lieux).
    const { doc, nomFichier } = buildPdf(lastGenerated.type, lastGenerated.ctx);

    const now = new Date();
    data.documents.push({
      id: Storage.uid(),
      createdAt: now.getTime(),
      dateLabel: now.toLocaleDateString('fr-FR'),
      ...lastGenerated,
    });
    save();
    renderDashboard();
    doc.save(nomFichier);
    // Un nouveau clic sans re-generer l'apercu creerait un doublon dans
    // l'historique et fausserait les totaux du tableau de bord.
    byId('btn-download-pdf').disabled = true;
    lastGenerated = null;
  });

  // ---------- Charges locatives ----------
  function renderChargesView(cat, preferredYear) {
    currentChargeCategory = cat;
    byId('charges-title').textContent = CHARGE_CATEGORIES[cat] || 'Charges locatives';
    byId('charges-subtitle').textContent = 'Suivi annuel et justificatifs par logement';

    populateChargeBienSelect();
    byId('charge-date').value = todayISO();
    byId('charge-montant').value = '';
    byId('charge-libelle').value = '';
    byId('charge-fichier').value = '';

    populateChargesYearSelect(cat, preferredYear);
    renderChargesTables(cat);
  }

  function populateChargeBienSelect() {
    const sel = byId('charge-bien');
    const prev = sel.value;
    if (data.biens.length === 0) {
      sel.innerHTML = '<option value="">Aucun bien enregistré</option>';
      return;
    }
    sel.innerHTML = data.biens.map((b) => `<option value="${b.id}">${escapeHTML(b.nom)}</option>`).join('');
    if (prev && bienById(prev)) sel.value = prev;
  }

  function populateChargesYearSelect(cat, preferredYear) {
    const currentYear = String(new Date().getFullYear());
    const years = new Set(
      data.charges.filter((c) => c.categorie === cat && c.date).map((c) => c.date.slice(0, 4))
    );
    years.add(currentYear);
    const sorted = [...years].sort((a, b) => b - a);
    const sel = byId('charges-year');
    const prev = sel.value;
    sel.innerHTML = sorted.map((y) => `<option value="${y}">${y}</option>`).join('');
    if (preferredYear && sorted.includes(String(preferredYear))) {
      sel.value = String(preferredYear);
    } else if (prev && sorted.includes(prev)) {
      sel.value = prev;
    } else {
      sel.value = currentYear;
    }
  }

  byId('charges-year').addEventListener('change', () => renderChargesTables(currentChargeCategory));

  function renderChargesTables(cat) {
    const year = byId('charges-year').value;
    renderChargesAnnualTable(cat, year);
    renderChargesDetailTable(cat, year);
  }

  function renderChargesAnnualTable(cat, year) {
    const entries = data.charges.filter((c) => c.categorie === cat && c.type === 'facture' && c.date && c.date.slice(0, 4) === String(year));

    const matrix = {};
    data.biens.forEach((b) => { matrix[b.id] = new Array(12).fill(0); });
    entries.forEach((c) => {
      const monthIndex = parseInt(c.date.slice(5, 7), 10) - 1;
      if (!matrix[c.bienId]) matrix[c.bienId] = new Array(12).fill(0);
      if (monthIndex >= 0 && monthIndex < 12) matrix[c.bienId][monthIndex] += Number(c.montant) || 0;
    });

    const orphanIds = Object.keys(matrix).filter((id) => !bienById(id));
    const rows = [
      ...data.biens.map((b) => ({ id: b.id, nom: b.nom })),
      ...orphanIds.map((id) => ({ id, nom: '(bien supprimé)' })),
    ];

    const thead = document.querySelector('#charges-annual-table thead');
    const tbody = document.querySelector('#charges-annual-table tbody');
    const tfoot = document.querySelector('#charges-annual-table tfoot');

    thead.innerHTML = `<tr><th>Logement</th>${MONTHS_SHORT.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr>`;

    if (rows.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="14">Ajoutez un bien pour afficher le suivi.</td></tr>';
      tfoot.innerHTML = '';
      return;
    }

    const monthTotals = new Array(12).fill(0);
    const rowTotals = {};
    rows.forEach((r) => {
      const arr = matrix[r.id] || new Array(12).fill(0);
      let rowTotal = 0;
      arr.forEach((v, i) => { monthTotals[i] += v; rowTotal += v; });
      rowTotals[r.id] = rowTotal;
    });
    const grandTotal = monthTotals.reduce((a, b) => a + b, 0);
    const maxCell = Math.max(1, ...rows.flatMap((r) => matrix[r.id] || []));
    const maxRowTotal = Math.max(1, ...Object.values(rowTotals));

    tbody.innerHTML = rows.map((r) => {
      const arr = matrix[r.id] || new Array(12).fill(0);
      const cells = arr.map((v) => {
        if (v <= 0) return '<td class="month-cell">—</td>';
        const opacity = Math.min(1, 0.15 + 0.7 * (v / maxCell)).toFixed(2);
        return `<td class="month-cell" style="background:rgba(47,111,237,${opacity})">${euros(v)}</td>`;
      }).join('');
      const rowTotal = rowTotals[r.id];
      const barPct = Math.round((rowTotal / maxRowTotal) * 100);
      return `<tr>
        <td>${escapeHTML(r.nom)}</td>
        ${cells}
        <td class="month-cell">
          <div class="charge-total-cell">
            <span>${euros(rowTotal)}</span>
            <div class="mini-bar"><div class="mini-bar-fill" style="width:${barPct}%"></div></div>
          </div>
        </td>
      </tr>`;
    }).join('');

    tfoot.innerHTML = `<tr class="charges-total-row">
      <td>Total</td>
      ${monthTotals.map((v) => `<td class="month-cell">${v > 0 ? euros(v) : '—'}</td>`).join('')}
      <td class="month-cell">${euros(grandTotal)}</td>
    </tr>`;
  }

  function renderChargesDetailTable(cat, year) {
    const tbody = document.querySelector('#charges-detail-table tbody');
    const entries = data.charges
      .filter((c) => c.categorie === cat && c.date && c.date.slice(0, 4) === String(year))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    if (entries.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Aucune dépense enregistrée pour cette année.</td></tr>';
      return;
    }

    tbody.innerHTML = entries.map((c) => {
      const bien = bienById(c.bienId);
      const dateLabel = c.date ? new Date(`${c.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      const isDevis = c.type === 'devis';
      const fileCell = c.fileId
        ? `<button type="button" class="file-link" data-view-file="${c.fileId}">${escapeHTML(c.fileName || 'Voir')}</button>`
        : '<span class="file-empty">—</span>';
      return `<tr>
        <td>${dateLabel}</td>
        <td>${bien ? escapeHTML(bien.nom) : '<em>Bien supprimé</em>'}</td>
        <td>${escapeHTML(c.libelle || '—')}</td>
        <td><span class="badge ${isDevis ? 'badge-devis' : 'badge-facture'}">${isDevis ? 'Devis' : 'Facture'}</span></td>
        <td>${euros(c.montant)}</td>
        <td>${fileCell}</td>
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-charge="${c.id}">Supprimer</button></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-charge]').forEach((btn) => btn.addEventListener('click', () => deleteCharge(btn.dataset.delCharge)));
  }

  // Aperçu intégré à l'appli (pas de nouvel onglet) : sur mobile, en particulier en
  // PWA installée, ouvrir une URL "blob" dans un nouvel onglet ne fonctionne pas de
  // façon fiable (pas d'onglets en mode standalone, contexte blob non partagé).
  let currentPreviewUrl = null;

  async function openStoredFile(fileId, fileName) {
    try {
      const blob = await FilesDb.getFile(fileId);
      if (!blob) {
        alert('Fichier introuvable (il a peut-être été supprimé).');
        return;
      }
      const url = URL.createObjectURL(blob);
      currentPreviewUrl = url;

      byId('file-preview-title').textContent = fileName || 'Document';
      const downloadLink = byId('file-preview-download');
      downloadLink.href = url;
      downloadLink.download = fileName || 'document';

      const body = byId('file-preview-body');
      body.innerHTML = '';
      if (blob.type === 'application/pdf') {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        body.appendChild(iframe);
      } else if (blob.type.indexOf('image/') === 0) {
        const img = document.createElement('img');
        img.src = url;
        body.appendChild(img);
      } else {
        body.innerHTML = '<p class="file-preview-fallback">Aperçu non disponible pour ce type de fichier. Utilisez le bouton "Télécharger".</p>';
      }
      byId('file-preview-overlay').hidden = false;
    } catch (e) {
      console.error(e);
      alert("Impossible d'ouvrir le fichier.");
    }
  }

  function closeFilePreview() {
    byId('file-preview-overlay').hidden = true;
    byId('file-preview-body').innerHTML = '';
    if (currentPreviewUrl) {
      URL.revokeObjectURL(currentPreviewUrl);
      currentPreviewUrl = null;
    }
  }

  byId('file-preview-close').addEventListener('click', closeFilePreview);
  byId('file-preview-overlay').addEventListener('click', (e) => {
    if (e.target === byId('file-preview-overlay')) closeFilePreview();
  });

  async function deleteCharge(id) {
    const entry = data.charges.find((c) => c.id === id);
    if (!entry) return;
    if (!confirm('Supprimer cette dépense ?')) return;
    data.charges = data.charges.filter((c) => c.id !== id);
    save();
    if (entry.fileId) {
      try { await FilesDb.deleteFile(entry.fileId); } catch (e) { console.error(e); }
    }
    renderChargesTables(currentChargeCategory);
  }

  byId('btn-charge-add').addEventListener('click', async () => {
    const bienId = byId('charge-bien').value;
    if (!bienId) { alert('Ajoutez d\'abord un bien, puis sélectionnez-le.'); return; }
    const date = byId('charge-date').value;
    if (!date) { alert('Renseignez une date.'); return; }
    const montant = parseFloat(byId('charge-montant').value) || 0;
    const type = byId('charge-type').value;
    const libelle = byId('charge-libelle').value.trim();
    const file = byId('charge-fichier').files[0];

    const record = {
      id: Storage.uid(),
      categorie: currentChargeCategory,
      bienId,
      date,
      montant,
      type,
      libelle,
      fileId: null,
      fileName: '',
    };

    if (file) {
      const fileId = Storage.uid();
      try {
        await FilesDb.saveFile(fileId, file);
        record.fileId = fileId;
        record.fileName = file.name;
      } catch (e) {
        console.error(e);
        alert("Le fichier n'a pas pu être enregistré, mais la dépense a été ajoutée sans justificatif.");
      }
    }

    data.charges.push(record);
    save();
    renderChargesView(currentChargeCategory, date.slice(0, 4));
  });

  // ---------- Anciens locataires ----------
  let currentAncEdlType = 'entrant';

  function populateAncLocataireSelect() {
    const sel = byId('anc-locataire');
    const prev = sel.value;
    const anciens = data.locataires.filter((l) => l.actif === false);
    if (anciens.length === 0) {
      sel.innerHTML = '<option value="">Aucun ancien locataire</option>';
      return;
    }
    sel.innerHTML = anciens.map((l) => `<option value="${l.id}">${escapeHTML(l.nom)}</option>`).join('');
    if (prev && anciens.some((l) => l.id === prev)) sel.value = prev;
  }

  byId('anc-locataire').addEventListener('change', renderAncPanels);

  function renderAncPanels() {
    renderAncDocumentsTable();
    renderAncBailTable();
    renderAncEdlTable();
    renderAncDocTable();
  }

  function renderAnciensLocatairesView() {
    populateAncLocataireSelect();
    byId('anc-bail-date').value = todayISO();
    byId('anc-bail-libelle').value = '';
    byId('anc-bail-fichier').value = '';
    byId('anc-edl-date').value = todayISO();
    byId('anc-edl-libelle').value = '';
    byId('anc-edl-fichier').value = '';
    byId('anc-doc-date').value = todayISO();
    byId('anc-doc-libelle').value = '';
    byId('anc-doc-fichier').value = '';
    renderAncPanels();
  }

  function renderAncDocumentsTable() {
    const tbody = document.querySelector('#anc-documents-table tbody');
    const locId = byId('anc-locataire').value;
    const docs = data.documents.filter((d) => d.locataireId === locId).sort((a, b) => b.createdAt - a.createdAt);
    if (!locId || docs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Aucun document généré pour ce locataire.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((d) => `<tr>
      <td>${d.dateLabel}</td>
      <td>${DOC_LABELS[d.type] || d.type}</td>
      <td>${escapeHTML(d.periodeLabel || '—')}</td>
      <td>${d.montant != null ? euros(d.montant) : '—'}</td>
      <td class="actions-cell"><button type="button" class="btn btn-sm" data-anc-doc-pdf="${d.id}">Télécharger le PDF</button></td>
    </tr>`).join('');
    tbody.querySelectorAll('[data-anc-doc-pdf]').forEach((btn) => btn.addEventListener('click', () => {
      const doc = data.documents.find((d) => d.id === btn.dataset.ancDocPdf);
      if (doc && doc.ctx) downloadPdf(doc.type, doc.ctx);
    }));
  }

  function renderAncBailTable() {
    const locId = byId('anc-locataire').value;
    const tbody = document.querySelector('#anc-bail-table tbody');
    const docs = data.baux.filter((b) => b.locataireId === locId).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!locId || docs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun document.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((d) => {
      const dateLabel = d.date ? new Date(`${d.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      return `<tr>
        <td>${dateLabel}</td>
        <td>${escapeHTML(d.libelle || '—')}</td>
        <td>${fileLinksHTML(d)}</td>
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-anc-bail="${d.id}">Supprimer</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-anc-bail]').forEach((btn) => btn.addEventListener('click', () => deleteAncBail(btn.dataset.delAncBail)));
  }

  async function deleteAncBail(id) {
    const entry = data.baux.find((b) => b.id === id);
    if (!entry) return;
    if (!confirm('Supprimer ce document ?')) return;
    data.baux = data.baux.filter((b) => b.id !== id);
    save();
    await deleteRecordFiles(entry);
    renderAncBailTable();
  }

  byId('anc-bail-fichier').addEventListener('change', function () {
    if (this.files.length > MAX_DOC_PAGES) {
      alert(`${MAX_DOC_PAGES} pages maximum par document.`);
      this.value = '';
    }
  });

  byId('btn-anc-bail-add').addEventListener('click', async () => {
    const locataireId = byId('anc-locataire').value;
    if (!locataireId) { alert('Sélectionnez un ancien locataire.'); return; }
    const date = byId('anc-bail-date').value;
    if (!date) { alert('Renseignez une date.'); return; }
    const files = [...byId('anc-bail-fichier').files];
    if (files.length === 0) { alert('Sélectionnez au moins un fichier (PDF, PNG ou JPG).'); return; }
    if (files.length > MAX_DOC_PAGES) { alert(`${MAX_DOC_PAGES} pages maximum par document.`); return; }

    const record = { id: Storage.uid(), locataireId, date, libelle: byId('anc-bail-libelle').value.trim(), files: [] };
    try {
      for (const file of files) {
        const fileId = Storage.uid();
        await FilesDb.saveFile(fileId, file);
        record.files.push({ fileId, fileName: file.name });
      }
    } catch (e) {
      console.error(e);
      alert("Certaines pages n'ont pas pu être enregistrées.");
      return;
    }
    data.baux.push(record);
    save();
    byId('anc-bail-date').value = todayISO();
    byId('anc-bail-libelle').value = '';
    byId('anc-bail-fichier').value = '';
    renderAncBailTable();
  });

  function renderAncEdlTable() {
    const locId = byId('anc-locataire').value;
    const tbody = document.querySelector('#anc-edl-table tbody');
    const docs = data.etatsDesLieux
      .filter((e) => e.locataireId === locId && e.sens === currentAncEdlType)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!locId || docs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun document.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((d) => {
      const dateLabel = d.date ? new Date(`${d.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      return `<tr>
        <td>${dateLabel}</td>
        <td>${escapeHTML(d.libelle || '—')}</td>
        <td>${fileLinksHTML(d)}</td>
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-anc-edl="${d.id}">Supprimer</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-anc-edl]').forEach((btn) => btn.addEventListener('click', () => deleteAncEdl(btn.dataset.delAncEdl)));
  }

  async function deleteAncEdl(id) {
    const entry = data.etatsDesLieux.find((e) => e.id === id);
    if (!entry) return;
    if (!confirm('Supprimer ce document ?')) return;
    data.etatsDesLieux = data.etatsDesLieux.filter((e) => e.id !== id);
    save();
    await deleteRecordFiles(entry);
    renderAncEdlTable();
  }

  document.querySelectorAll('#anc-edl-type-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentAncEdlType = btn.dataset.edlType;
      document.querySelectorAll('#anc-edl-type-toggle .toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderAncEdlTable();
    });
  });

  byId('anc-edl-fichier').addEventListener('change', function () {
    if (this.files.length > MAX_DOC_PAGES) {
      alert(`${MAX_DOC_PAGES} pages maximum par document.`);
      this.value = '';
    }
  });

  byId('btn-anc-edl-add').addEventListener('click', async () => {
    const locataireId = byId('anc-locataire').value;
    if (!locataireId) { alert('Sélectionnez un ancien locataire.'); return; }
    const date = byId('anc-edl-date').value;
    if (!date) { alert('Renseignez une date.'); return; }
    const files = [...byId('anc-edl-fichier').files];
    if (files.length === 0) { alert('Sélectionnez au moins un fichier (PDF, PNG ou JPG).'); return; }
    if (files.length > MAX_DOC_PAGES) { alert(`${MAX_DOC_PAGES} pages maximum par document.`); return; }

    const record = {
      id: Storage.uid(),
      locataireId,
      sens: currentAncEdlType,
      date,
      libelle: byId('anc-edl-libelle').value.trim(),
      files: [],
    };
    try {
      for (const file of files) {
        const fileId = Storage.uid();
        await FilesDb.saveFile(fileId, file);
        record.files.push({ fileId, fileName: file.name });
      }
    } catch (e) {
      console.error(e);
      alert("Certaines pages n'ont pas pu être enregistrées.");
      return;
    }
    data.etatsDesLieux.push(record);
    save();
    byId('anc-edl-date').value = todayISO();
    byId('anc-edl-libelle').value = '';
    byId('anc-edl-fichier').value = '';
    renderAncEdlTable();
  });

  function renderAncDocTable() {
    const locId = byId('anc-locataire').value;
    const tbody = document.querySelector('#anc-doc-table tbody');
    const docs = data.documentsLocataires
      .filter((d) => d.locataireId === locId)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!locId || docs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun document.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((d) => {
      const dateLabel = d.date ? new Date(`${d.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      return `<tr>
        <td>${dateLabel}</td>
        <td>${escapeHTML(d.libelle || '—')}</td>
        <td>${fileLinksHTML(d)}</td>
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-anc-doc="${d.id}">Supprimer</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-anc-doc]').forEach((btn) => btn.addEventListener('click', () => deleteAncDoc(btn.dataset.delAncDoc)));
  }

  async function deleteAncDoc(id) {
    const entry = data.documentsLocataires.find((d) => d.id === id);
    if (!entry) return;
    if (!confirm('Supprimer ce document ?')) return;
    data.documentsLocataires = data.documentsLocataires.filter((d) => d.id !== id);
    save();
    await deleteRecordFiles(entry);
    renderAncDocTable();
  }

  byId('anc-doc-fichier').addEventListener('change', function () {
    if (this.files.length > MAX_DOC_PAGES) {
      alert(`${MAX_DOC_PAGES} pages maximum par document.`);
      this.value = '';
    }
  });

  byId('btn-anc-doc-add').addEventListener('click', async () => {
    const locataireId = byId('anc-locataire').value;
    if (!locataireId) { alert('Sélectionnez un ancien locataire.'); return; }
    const date = byId('anc-doc-date').value;
    if (!date) { alert('Renseignez une date.'); return; }
    const files = [...byId('anc-doc-fichier').files];
    if (files.length === 0) { alert('Sélectionnez au moins un fichier (PDF, PNG ou JPG).'); return; }
    if (files.length > MAX_DOC_PAGES) { alert(`${MAX_DOC_PAGES} pages maximum par document.`); return; }

    const record = { id: Storage.uid(), locataireId, date, libelle: byId('anc-doc-libelle').value.trim(), files: [] };
    try {
      for (const file of files) {
        const fileId = Storage.uid();
        await FilesDb.saveFile(fileId, file);
        record.files.push({ fileId, fileName: file.name });
      }
    } catch (e) {
      console.error(e);
      alert("Certaines pages n'ont pas pu être enregistrées.");
      return;
    }
    data.documentsLocataires.push(record);
    save();
    byId('anc-doc-date').value = todayISO();
    byId('anc-doc-libelle').value = '';
    byId('anc-doc-fichier').value = '';
    renderAncDocTable();
  });

  // ---------- Bail ----------
  function renderBailView() {
    populateBailLocataireSelect();
    byId('bail-date').value = todayISO();
    byId('bail-libelle').value = '';
    byId('bail-fichier').value = '';
    renderBailStatusGrid();
    renderBailHistoryTable();
  }

  function populateBailLocataireSelect() {
    const sel = byId('bail-locataire');
    const prev = sel.value;
    if (data.locataires.length === 0) {
      sel.innerHTML = '<option value="">Aucun locataire enregistré</option>';
      return;
    }
    sel.innerHTML = data.locataires.map((l) => `<option value="${l.id}">${escapeHTML(l.nom)}</option>`).join('');
    if (prev && locataireById(prev)) sel.value = prev;
  }

  byId('bail-locataire').addEventListener('change', renderBailHistoryTable);

  function renderBailStatusGrid() {
    const grid = byId('bail-status-grid');
    if (data.locataires.length === 0) {
      grid.innerHTML = '<p class="charges-note">Aucun locataire enregistré.</p>';
      return;
    }
    grid.innerHTML = data.locataires.map((l) => {
      const docs = data.baux.filter((b) => b.locataireId === l.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const last = docs[0];
      const status = last
        ? `<span>Dernier document</span><span class="doc-status-ok">${new Date(`${last.date}T00:00:00`).toLocaleDateString('fr-FR')}</span>`
        : `<span>Bail</span><span class="doc-status-missing">Manquant</span>`;
      return `<div class="doc-status-card">
        <span class="doc-status-name">${escapeHTML(l.nom)}</span>
        <div class="doc-status-row">${status}</div>
      </div>`;
    }).join('');
  }

  function renderBailHistoryTable() {
    const locId = byId('bail-locataire').value;
    const loc = locataireById(locId);
    byId('bail-locataire-label').textContent = loc ? loc.nom : '—';
    const tbody = document.querySelector('#bail-table tbody');
    const docs = data.baux.filter((b) => b.locataireId === locId).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (docs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun document pour ce locataire.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((d) => {
      const dateLabel = d.date ? new Date(`${d.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      return `<tr>
        <td>${dateLabel}</td>
        <td>${escapeHTML(d.libelle || '—')}</td>
        <td>${fileLinksHTML(d)}</td>
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-bail="${d.id}">Supprimer</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-bail]').forEach((btn) => btn.addEventListener('click', () => deleteBail(btn.dataset.delBail)));
  }

  async function deleteBail(id) {
    const entry = data.baux.find((b) => b.id === id);
    if (!entry) return;
    if (!confirm('Supprimer ce document ?')) return;
    data.baux = data.baux.filter((b) => b.id !== id);
    save();
    await deleteRecordFiles(entry);
    renderBailStatusGrid();
    renderBailHistoryTable();
  }

  byId('bail-fichier').addEventListener('change', function () {
    if (this.files.length > MAX_DOC_PAGES) {
      alert(`${MAX_DOC_PAGES} pages maximum par document.`);
      this.value = '';
    }
  });

  byId('btn-bail-add').addEventListener('click', async () => {
    const locataireId = byId('bail-locataire').value;
    if (!locataireId) { alert("Ajoutez d'abord un locataire, puis sélectionnez-le."); return; }
    const date = byId('bail-date').value;
    if (!date) { alert('Renseignez une date.'); return; }
    const files = [...byId('bail-fichier').files];
    if (files.length === 0) { alert('Sélectionnez au moins un fichier (PDF, PNG ou JPG).'); return; }
    if (files.length > MAX_DOC_PAGES) { alert(`${MAX_DOC_PAGES} pages maximum par document.`); return; }

    const record = { id: Storage.uid(), locataireId, date, libelle: byId('bail-libelle').value.trim(), files: [] };
    try {
      for (const file of files) {
        const fileId = Storage.uid();
        await FilesDb.saveFile(fileId, file);
        record.files.push({ fileId, fileName: file.name });
      }
    } catch (e) {
      console.error(e);
      alert("Certaines pages n'ont pas pu être enregistrées.");
      return;
    }
    data.baux.push(record);
    save();
    byId('bail-date').value = todayISO();
    byId('bail-libelle').value = '';
    byId('bail-fichier').value = '';
    renderBailStatusGrid();
    renderBailHistoryTable();
  });

  // ---------- États des lieux ----------
  let currentEdlType = 'entrant';

  function renderEtatsLieuxView() {
    populateEdlLocataireSelect();
    byId('edl-date').value = todayISO();
    byId('edl-libelle').value = '';
    byId('edl-fichier').value = '';
    renderEdlStatusGrid();
    renderEdlHistoryTable();
  }

  function populateEdlLocataireSelect() {
    const sel = byId('edl-locataire');
    const prev = sel.value;
    if (data.locataires.length === 0) {
      sel.innerHTML = '<option value="">Aucun locataire enregistré</option>';
      return;
    }
    sel.innerHTML = data.locataires.map((l) => `<option value="${l.id}">${escapeHTML(l.nom)}</option>`).join('');
    if (prev && locataireById(prev)) sel.value = prev;
  }

  byId('edl-locataire').addEventListener('change', renderEdlHistoryTable);

  document.querySelectorAll('#edl-type-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentEdlType = btn.dataset.edlType;
      document.querySelectorAll('#edl-type-toggle .toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
      byId('edl-type-label').textContent = currentEdlType === 'sortant' ? 'Sortant' : 'Entrant';
      renderEdlHistoryTable();
    });
  });

  function renderEdlStatusGrid() {
    const grid = byId('edl-status-grid');
    if (data.locataires.length === 0) {
      grid.innerHTML = '<p class="charges-note">Aucun locataire enregistré.</p>';
      return;
    }
    const lastOf = (locId, sens) => data.etatsDesLieux
      .filter((e) => e.locataireId === locId && e.sens === sens)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    const statusLine = (label, doc) => doc
      ? `<span>${label}</span><span class="doc-status-ok">${new Date(`${doc.date}T00:00:00`).toLocaleDateString('fr-FR')}</span>`
      : `<span>${label}</span><span class="doc-status-missing">Manquant</span>`;
    grid.innerHTML = data.locataires.map((l) => {
      const entrant = lastOf(l.id, 'entrant');
      const sortant = lastOf(l.id, 'sortant');
      return `<div class="doc-status-card">
        <span class="doc-status-name">${escapeHTML(l.nom)}</span>
        <div class="doc-status-row">${statusLine('Entrant', entrant)}</div>
        <div class="doc-status-row">${statusLine('Sortant', sortant)}</div>
      </div>`;
    }).join('');
  }

  function renderEdlHistoryTable() {
    const locId = byId('edl-locataire').value;
    const loc = locataireById(locId);
    byId('edl-locataire-label').textContent = loc ? loc.nom : '—';
    const tbody = document.querySelector('#edl-table tbody');
    const docs = data.etatsDesLieux
      .filter((e) => e.locataireId === locId && e.sens === currentEdlType)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (docs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun document pour ce locataire.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((d) => {
      const dateLabel = d.date ? new Date(`${d.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      return `<tr>
        <td>${dateLabel}</td>
        <td>${escapeHTML(d.libelle || '—')}</td>
        <td>${fileLinksHTML(d)}</td>
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-edl="${d.id}">Supprimer</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-edl]').forEach((btn) => btn.addEventListener('click', () => deleteEdl(btn.dataset.delEdl)));
  }

  async function deleteEdl(id) {
    const entry = data.etatsDesLieux.find((e) => e.id === id);
    if (!entry) return;
    if (!confirm('Supprimer ce document ?')) return;
    data.etatsDesLieux = data.etatsDesLieux.filter((e) => e.id !== id);
    save();
    await deleteRecordFiles(entry);
    renderEdlStatusGrid();
    renderEdlHistoryTable();
    renderHistorique(); // les états des lieux figurent aussi dans l'historique général
  }

  byId('edl-fichier').addEventListener('change', function () {
    if (this.files.length > MAX_DOC_PAGES) {
      alert(`${MAX_DOC_PAGES} pages maximum par document.`);
      this.value = '';
    }
  });

  byId('btn-edl-add').addEventListener('click', async () => {
    const locataireId = byId('edl-locataire').value;
    if (!locataireId) { alert("Ajoutez d'abord un locataire, puis sélectionnez-le."); return; }
    const date = byId('edl-date').value;
    if (!date) { alert('Renseignez une date.'); return; }
    const files = [...byId('edl-fichier').files];
    if (files.length === 0) { alert('Sélectionnez au moins un fichier (PDF, PNG ou JPG).'); return; }
    if (files.length > MAX_DOC_PAGES) { alert(`${MAX_DOC_PAGES} pages maximum par document.`); return; }

    const record = {
      id: Storage.uid(),
      locataireId,
      sens: currentEdlType,
      date,
      libelle: byId('edl-libelle').value.trim(),
      files: [],
    };
    try {
      for (const file of files) {
        const fileId = Storage.uid();
        await FilesDb.saveFile(fileId, file);
        record.files.push({ fileId, fileName: file.name });
      }
    } catch (e) {
      console.error(e);
      alert("Certaines pages n'ont pas pu être enregistrées.");
      return;
    }
    data.etatsDesLieux.push(record);
    save();
    byId('edl-date').value = todayISO();
    byId('edl-libelle').value = '';
    byId('edl-fichier').value = '';
    renderEdlStatusGrid();
    renderEdlHistoryTable();
  });

  // ---------- Documents administratifs ----------
  const MAX_ADMIN_DOC_PAGES = 20;

  function renderDocsAdminView(cat) {
    currentDocsAdminCategory = cat;
    byId('docsadmin-title').textContent = ADMIN_DOC_CATEGORIES[cat] || 'Documents administratifs';
    byId('docsadmin-date').value = todayISO();
    byId('docsadmin-libelle').value = '';
    byId('docsadmin-fichier').value = '';
    renderDocsAdminTable();
  }

  function renderDocsAdminTable() {
    const tbody = document.querySelector('#docsadmin-table tbody');
    const docs = data.documentsAdmin
      .filter((d) => d.categorie === currentDocsAdminCategory)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (docs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun document dans cette catégorie.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((d) => {
      const dateLabel = d.date ? new Date(`${d.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      return `<tr>
        <td>${dateLabel}</td>
        <td>${escapeHTML(d.libelle || '—')}</td>
        <td>${fileLinksHTML(d)}</td>
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-docsadmin="${d.id}">Supprimer</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-docsadmin]').forEach((btn) => btn.addEventListener('click', () => deleteDocsAdmin(btn.dataset.delDocsadmin)));
  }

  async function deleteDocsAdmin(id) {
    const entry = data.documentsAdmin.find((d) => d.id === id);
    if (!entry) return;
    if (!confirm('Supprimer ce document ?')) return;
    data.documentsAdmin = data.documentsAdmin.filter((d) => d.id !== id);
    save();
    await deleteRecordFiles(entry);
    renderDocsAdminTable();
  }

  byId('docsadmin-fichier').addEventListener('change', function () {
    if (this.files.length > MAX_ADMIN_DOC_PAGES) {
      alert(`${MAX_ADMIN_DOC_PAGES} pages maximum par document.`);
      this.value = '';
    }
  });

  byId('btn-docsadmin-add').addEventListener('click', async () => {
    const date = byId('docsadmin-date').value;
    if (!date) { alert('Renseignez une date.'); return; }
    const files = [...byId('docsadmin-fichier').files];
    if (files.length === 0) { alert('Sélectionnez au moins un fichier (PDF, PNG ou JPG).'); return; }
    if (files.length > MAX_ADMIN_DOC_PAGES) { alert(`${MAX_ADMIN_DOC_PAGES} pages maximum par document.`); return; }

    const record = {
      id: Storage.uid(),
      categorie: currentDocsAdminCategory,
      date,
      libelle: byId('docsadmin-libelle').value.trim(),
      files: [],
    };
    try {
      for (const file of files) {
        const fileId = Storage.uid();
        await FilesDb.saveFile(fileId, file);
        record.files.push({ fileId, fileName: file.name });
      }
    } catch (e) {
      console.error(e);
      alert("Certaines pages n'ont pas pu être enregistrées.");
      return;
    }
    data.documentsAdmin.push(record);
    save();
    byId('docsadmin-date').value = todayISO();
    byId('docsadmin-libelle').value = '';
    byId('docsadmin-fichier').value = '';
    renderDocsAdminTable();
  });

  // ---------- Crédits ----------
  function renderCreditsView(cat) {
    currentCreditCategory = cat;
    byId('credits-title').textContent = CREDIT_CATEGORIES[cat] || 'Crédits';
    byId('credits-date').value = todayISO();
    byId('credits-libelle').value = '';
    byId('credits-fichier').value = '';
    renderCreditsTable();
  }

  function renderCreditsTable() {
    const tbody = document.querySelector('#credits-table tbody');
    const docs = data.credits
      .filter((d) => d.categorie === currentCreditCategory)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (docs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun document dans cette catégorie.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((d) => {
      const dateLabel = d.date ? new Date(`${d.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      return `<tr>
        <td>${dateLabel}</td>
        <td>${escapeHTML(d.libelle || '—')}</td>
        <td>${fileLinksHTML(d)}</td>
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-credits="${d.id}">Supprimer</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-credits]').forEach((btn) => btn.addEventListener('click', () => deleteCredit(btn.dataset.delCredits)));
  }

  async function deleteCredit(id) {
    const entry = data.credits.find((d) => d.id === id);
    if (!entry) return;
    if (!confirm('Supprimer ce document ?')) return;
    data.credits = data.credits.filter((d) => d.id !== id);
    save();
    await deleteRecordFiles(entry);
    renderCreditsTable();
  }

  byId('credits-fichier').addEventListener('change', function () {
    if (this.files.length > MAX_DOC_PAGES) {
      alert(`${MAX_DOC_PAGES} pages maximum par document.`);
      this.value = '';
    }
  });

  byId('btn-credits-add').addEventListener('click', async () => {
    const date = byId('credits-date').value;
    if (!date) { alert('Renseignez une date.'); return; }
    const files = [...byId('credits-fichier').files];
    if (files.length === 0) { alert('Sélectionnez au moins un fichier (PDF, PNG ou JPG).'); return; }
    if (files.length > MAX_DOC_PAGES) { alert(`${MAX_DOC_PAGES} pages maximum par document.`); return; }

    const record = {
      id: Storage.uid(),
      categorie: currentCreditCategory,
      date,
      libelle: byId('credits-libelle').value.trim(),
      files: [],
    };
    try {
      for (const file of files) {
        const fileId = Storage.uid();
        await FilesDb.saveFile(fileId, file);
        record.files.push({ fileId, fileName: file.name });
      }
    } catch (e) {
      console.error(e);
      alert("Certaines pages n'ont pas pu être enregistrées.");
      return;
    }
    data.credits.push(record);
    save();
    byId('credits-date').value = todayISO();
    byId('credits-libelle').value = '';
    byId('credits-fichier').value = '';
    renderCreditsTable();
  });

  // ---------- Factures et travaux ----------
  function renderFacturesTravauxView(cat) {
    currentFacturesTravauxCategory = cat;
    byId('facturestravaux-title').textContent = FACTURES_TRAVAUX_CATEGORIES[cat] || 'Factures et travaux';
    byId('facturestravaux-date').value = todayISO();
    byId('facturestravaux-libelle').value = '';
    byId('facturestravaux-fichier').value = '';
    byId('facturestravaux-type').value = '';
    // Un document peut concerner la SCI en general (honoraires, assurance...)
    // et non un bien precis : le rattachement reste donc facultatif.
    byId('facturestravaux-bien').innerHTML = '<option value="">— SCI (aucun bien) —</option>'
      + data.biens.map((b) => '<option value="' + b.id + '">' + escapeHTML(b.nom) + '</option>').join('');
    byId('facturestravaux-locataire').innerHTML = '<option value="">— Aucun —</option>'
      + data.locataires.map((l) => '<option value="' + l.id + '">' + escapeHTML(l.nom) + '</option>').join('');
    renderFacturesTravauxTable();
  }

  // Tri et filtres de la vue Factures / Travaux.
  let ftTri = { colonne: 'date', sens: 'desc' };

  function ftNomBien(d) { const b = bienById(d.bienId); return b ? b.nom : ''; }
  function ftNomLocataire(d) { const l = locataireById(d.locataireId); return l ? l.nom : ''; }

  function peuplerFiltresFT() {
    const tous = data.facturesTravaux;
    const remplir = (id, valeurs, tri) => {
      const sel = byId(id);
      const choix = sel.value;
      const premier = sel.options[0].outerHTML;
      const uniques = [...new Set(valeurs.filter(Boolean))].sort(tri);
      sel.innerHTML = premier + uniques
        .map((v) => '<option value="' + escapeHTML(v) + '">' + escapeHTML(v) + '</option>').join('');
      sel.value = choix;
      if (sel.value !== choix) sel.value = '';
    };
    remplir('ft-filtre-annee', tous.map((d) => (d.date || '').slice(0, 4)), (a, b) => b.localeCompare(a));
    remplir('ft-filtre-type', tous.map((d) => d.typeTravaux), (a, b) => a.localeCompare(b, 'fr'));
    remplir('ft-filtre-locataire', tous.map((d) => ftNomLocataire(d)), (a, b) => a.localeCompare(b, 'fr'));
    // La liste de suggestions de natures se nourrit de ce qui a deja ete saisi.
    const dl = byId('liste-types-travaux');
    dl.innerHTML = [...new Set(tous.map((d) => d.typeTravaux).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'fr'))
      .map((v) => '<option value="' + escapeHTML(v) + '"></option>').join('');
  }

  function majEntetesFT() {
    document.querySelectorAll('#facturestravaux-table .th-triable').forEach((th) => {
      const actif = th.dataset.triFt === ftTri.colonne;
      th.classList.toggle('tri-actif', actif);
      const libelle = th.dataset.libelle || th.textContent.trim();
      th.dataset.libelle = libelle;
      const fleche = actif ? (ftTri.sens === 'asc' ? '\u25B2' : '\u25BC') : '';
      th.innerHTML = libelle + (fleche ? ' <span class="tri-fleche">' + fleche + '</span>' : '');
    });
  }

  function renderFacturesTravauxTable() {
    const tbody = document.querySelector('#facturestravaux-table tbody');
    peuplerFiltresFT();
    majEntetesFT();

    const fCat = byId('ft-filtre-categorie').value;
    const fAnnee = byId('ft-filtre-annee').value;
    const fType = byId('ft-filtre-type').value;
    const fLoc = byId('ft-filtre-locataire').value;

    let docs = data.facturesTravaux.filter((d) => {
      // 'courante' = la rubrique ouverte ; '' = les deux reunies.
      if (fCat === 'courante' && d.categorie !== currentFacturesTravauxCategory) return false;
      if (fCat && fCat !== 'courante' && d.categorie !== fCat) return false;
      if (fAnnee && (d.date || '').slice(0, 4) !== fAnnee) return false;
      if (fType && d.typeTravaux !== fType) return false;
      if (fLoc && ftNomLocataire(d) !== fLoc) return false;
      return true;
    });

    const sens = ftTri.sens === 'asc' ? 1 : -1;
    const cle = {
      date: (d) => d.date || '',
      type: (d) => d.typeTravaux || '',
      bien: (d) => ftNomBien(d),
      locataire: (d) => ftNomLocataire(d),
    }[ftTri.colonne];
    docs = [...docs].sort((a, b) => String(cle(a)).localeCompare(String(cle(b)), 'fr') * sens);

    byId('ft-compte').textContent = docs.length + ' document(s).';

    if (docs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Aucun document ne correspond \u00e0 ces crit\u00e8res.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((d) => {
      const dateLabel = d.date ? new Date(d.date + 'T00:00:00').toLocaleDateString('fr-FR') : '\u2014';
      const cat = FACTURES_TRAVAUX_CATEGORIES[d.categorie] || '';
      return '<tr>'
        + '<td data-label="Date">' + dateLabel + (fCat !== 'courante' && cat ? '<br><span class="badge badge-inactive">' + escapeHTML(cat) + '</span>' : '') + '</td>'
        + '<td data-label="Nature">' + escapeHTML(d.typeTravaux || '\u2014') + '</td>'
        + '<td data-label="Bien">' + escapeHTML(ftNomBien(d) || '\u2014') + '</td>'
        + '<td data-label="Locataire">' + escapeHTML(ftNomLocataire(d) || '\u2014') + '</td>'
        + '<td data-label="Libellé">' + escapeHTML(d.libelle || '\u2014') + '</td>'
        + '<td data-label="Fichier(s)">' + fileLinksHTML(d) + '</td>'
        + '<td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-facturestravaux="' + d.id + '">Supprimer</button></td>'
        + '</tr>';
    }).join('');
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-facturestravaux]').forEach((btn) => btn.addEventListener('click', () => deleteFacturesTravaux(btn.dataset.delFacturestravaux)));
  }

  document.querySelectorAll('#facturestravaux-table .th-triable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.triFt;
      if (ftTri.colonne === col) ftTri.sens = ftTri.sens === 'asc' ? 'desc' : 'asc';
      else ftTri = { colonne: col, sens: col === 'date' ? 'desc' : 'asc' };
      renderFacturesTravauxTable();
    });
  });
  ['ft-filtre-annee', 'ft-filtre-categorie', 'ft-filtre-type', 'ft-filtre-locataire']
    .forEach((id) => byId(id).addEventListener('change', renderFacturesTravauxTable));

  async function deleteFacturesTravaux(id) {
    const entry = data.facturesTravaux.find((d) => d.id === id);
    if (!entry) return;
    if (!confirm('Supprimer ce document ?')) return;
    data.facturesTravaux = data.facturesTravaux.filter((d) => d.id !== id);
    save();
    await deleteRecordFiles(entry);
    renderFacturesTravauxTable();
  }

  byId('facturestravaux-fichier').addEventListener('change', function () {
    if (this.files.length > MAX_ADMIN_DOC_PAGES) {
      alert(`${MAX_ADMIN_DOC_PAGES} pages maximum par document.`);
      this.value = '';
    }
  });

  byId('btn-facturestravaux-add').addEventListener('click', async () => {
    const date = byId('facturestravaux-date').value;
    if (!date) { alert('Renseignez une date.'); return; }
    const files = [...byId('facturestravaux-fichier').files];
    if (files.length === 0) { alert('Sélectionnez au moins un fichier (PDF, PNG ou JPG).'); return; }
    if (files.length > MAX_ADMIN_DOC_PAGES) { alert(`${MAX_ADMIN_DOC_PAGES} pages maximum par document.`); return; }

    const record = {
      id: Storage.uid(),
      categorie: currentFacturesTravauxCategory,
      date,
      typeTravaux: byId('facturestravaux-type').value.trim(),
      bienId: byId('facturestravaux-bien').value,
      locataireId: byId('facturestravaux-locataire').value,
      libelle: byId('facturestravaux-libelle').value.trim(),
      files: [],
    };
    try {
      for (const file of files) {
        const fileId = Storage.uid();
        await FilesDb.saveFile(fileId, file);
        record.files.push({ fileId, fileName: file.name });
      }
    } catch (e) {
      console.error(e);
      alert("Certaines pages n'ont pas pu être enregistrées.");
      return;
    }
    data.facturesTravaux.push(record);
    save();
    byId('facturestravaux-date').value = todayISO();
    byId('facturestravaux-libelle').value = '';
    byId('facturestravaux-fichier').value = '';
    renderFacturesTravauxTable();
  });

  // ---------- Rédaction du bail ----------
  const BAIL_PLACEHOLDERS = [
    { key: 'LOCATAIRE_NOM', label: 'Nom locataire' },
    { key: 'LOCATAIRE_ADRESSE', label: 'Adresse locataire' },
    { key: 'BIEN_NOM', label: 'Désignation bien' },
    { key: 'BIEN_ADRESSE', label: 'Adresse bien' },
    { key: 'LOYER', label: 'Loyer' },
    { key: 'CHARGES', label: 'Charges' },
    { key: 'TOTAL', label: 'Total loyer + charges' },
    { key: 'SCI_NOM', label: 'Nom SCI' },
    { key: 'SCI_ADRESSE', label: 'Adresse SCI' },
    { key: 'SCI_SIRET', label: 'SIRET' },
    { key: 'VILLE', label: 'Ville' },
    { key: 'DATE_DU_JOUR', label: 'Date du jour' },
    { key: 'SIGNATURE_BAILLEUR', label: 'Signature du bailleur' },
  ];
  let currentRedactionDraftId = null;
  // Avertit avant fermeture/rechargement de l'onglet si un brouillon (bail ou EDL)
  // n'a pas ete enregistre depuis sa creation/derniere modification.
  let hasUnsavedWork = false;
  window.addEventListener('beforeunload', (e) => {
    // Les écritures locales étant asynchrones (IndexedDB), on prévient aussi
    // tant qu'une sauvegarde n'est pas confirmée.
    if (!hasUnsavedWork && !Storage.hasPendingWrites()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* ignore */ }

  function updateToolbarState(toolbar, editor) {
    toolbar.querySelectorAll('button[data-cmd]').forEach((btn) => {
      try {
        btn.dataset.active = document.queryCommandState(btn.dataset.cmd) ? 'true' : 'false';
      } catch (e) { /* ignore */ }
    });
  }

  document.querySelectorAll('.rte-toolbar').forEach((toolbar) => {
    const editor = byId(toolbar.dataset.target);
    if (!editor) return;
    toolbar.querySelectorAll('button[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editor.focus();
        document.execCommand(btn.dataset.cmd, false, null);
        updateToolbarState(toolbar, editor);
      });
    });
    editor.addEventListener('keyup', () => updateToolbarState(toolbar, editor));
    editor.addEventListener('mouseup', () => updateToolbarState(toolbar, editor));
  });

  byId('modele-field-chips').innerHTML = BAIL_PLACEHOLDERS
    .map((p) => `<button type="button" class="field-chip" data-insert="${p.key}">${escapeHTML(p.label)}</button>`)
    .join('');
  byId('modele-field-chips').querySelectorAll('[data-insert]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const editor = byId('modele-editor');
      editor.focus();
      document.execCommand('insertText', false, `{{${btn.dataset.insert}}}`);
    });
  });

  function renderModeleEditor() {
    byId('modele-editor').innerHTML = data.bailModele || '';
  }

  byId('btn-modele-save').addEventListener('click', () => {
    data.bailModele = byId('modele-editor').innerHTML;
    save();
    alert('Modèle enregistré.');
  });

  function substitutePlaceholders(html, locataireId) {
    const l = locataireById(locataireId);
    const bien = l ? bienById(l.bienId) : null;
    const total = l ? (Number(l.loyer) || 0) + (Number(l.charges) || 0) : 0;
    const raw = {
      LOCATAIRE_NOM: l ? l.nom : '',
      LOCATAIRE_ADRESSE: l ? (l.adresseDestinataire || (bien ? bien.adresse : '')) : '',
      BIEN_NOM: bien ? bien.nom : '',
      BIEN_ADRESSE: bien ? bien.adresse : '',
      LOYER: l ? euros(l.loyer) : '',
      CHARGES: l ? euros(l.charges) : '',
      TOTAL: l ? euros(total) : '',
      SCI_NOM: data.sci.nom || '',
      SCI_ADRESSE: data.sci.adresse || '',
      SCI_SIRET: data.sci.siret || '',
      VILLE: data.sci.ville || '',
      DATE_DU_JOUR: Documents.todayFR(),
    };
    const multilineKeys = ['LOCATAIRE_ADRESSE', 'BIEN_ADRESSE', 'SCI_ADRESSE'];
    let result = html;
    Object.keys(raw).forEach((key) => {
      const value = multilineKeys.indexOf(key) !== -1 ? nl2brLocal(raw[key]) : escapeHTML(raw[key]);
      result = result.split(`{{${key}}}`).join(value);
    });
    // Contrairement aux autres jetons (texte simple), celui-ci s'insere comme
    // une vraie image (reprise de la signature enregistree dans "Ma SCI").
    const signatureHTML = data.sci.signature
      ? `<img class="rte-editor-sig" src="${escapeHTML(data.sci.signature)}" alt="Signature du bailleur">`
      : '<em>(Signature du bailleur non configurée — rubrique "Ma SCI")</em>';
    result = result.split('{{SIGNATURE_BAILLEUR}}').join(signatureHTML);
    return result;
  }

  function populateRedactionLocataireSelect() {
    const sel = byId('redaction-locataire');
    const prev = sel.value;
    if (data.locataires.length === 0) {
      sel.innerHTML = '<option value="">Aucun locataire enregistré</option>';
      return;
    }
    sel.innerHTML = data.locataires.map((l) => `<option value="${l.id}">${escapeHTML(l.nom)}</option>`).join('');
    if (prev && locataireById(prev)) sel.value = prev;
  }

  function updateRedactionLabels() {
    const loc = locataireById(byId('redaction-locataire').value);
    const name = loc ? loc.nom : '—';
    byId('redaction-locataire-label').textContent = name;
    byId('redaction-history-label').textContent = name;
  }

  byId('redaction-locataire').addEventListener('change', () => {
    currentRedactionDraftId = null;
    byId('redaction-editor').innerHTML = '';
    byId('redaction-libelle').value = '';
    updateRedactionLabels();
    renderRedactionHistory();
    hasUnsavedWork = false;
  });

  byId('btn-redaction-new').addEventListener('click', () => {
    const locataireId = byId('redaction-locataire').value;
    if (!locataireId) { alert("Ajoutez d'abord un locataire, puis sélectionnez-le."); return; }
    if (isHtmlEmpty(data.bailModele)) {
      if (!confirm("Aucun modèle de bail enregistré (ou modèle vide). Créer un bail vierge pour ce locataire ?")) return;
    }
    currentRedactionDraftId = null;
    byId('redaction-libelle').value = 'Bail initial';
    byId('redaction-editor').innerHTML = substitutePlaceholders(data.bailModele || '', locataireId);
    updateRedactionLabels();
    hasUnsavedWork = true;
  });

  byId('redaction-editor').addEventListener('input', () => { hasUnsavedWork = true; });

  function saveRedactionDraft() {
    const locataireId = byId('redaction-locataire').value;
    if (!locataireId) return null;
    let libelle = byId('redaction-libelle').value.trim();
    if (!libelle) libelle = 'Brouillon';
    const html = byId('redaction-editor').innerHTML;
    const now = new Date();

    if (currentRedactionDraftId) {
      const existing = data.bailRedactions.find((r) => r.id === currentRedactionDraftId);
      if (existing) {
        existing.libelle = libelle;
        existing.html = html;
        existing.updatedAt = now.getTime();
        save();
        hasUnsavedWork = false;
        return existing;
      }
    }
    const record = { id: Storage.uid(), locataireId, libelle, html, createdAt: now.getTime(), updatedAt: now.getTime() };
    data.bailRedactions.push(record);
    currentRedactionDraftId = record.id;
    save();
    hasUnsavedWork = false;
    return record;
  }

  byId('btn-redaction-save').addEventListener('click', () => {
    const locataireId = byId('redaction-locataire').value;
    if (!locataireId) { alert("Ajoutez d'abord un locataire, puis sélectionnez-le."); return; }
    if (RichTextPdf.isEmpty(byId('redaction-editor'))) { alert('Le document est vide.'); return; }
    saveRedactionDraft();
    renderRedactionHistory();
    alert('Brouillon enregistré.');
  });

  function downloadRedactionPdf(editorEl, locataireNom) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    doc.setFont('times', 'bold');
    doc.setFontSize(15);
    doc.text('BAIL DE LOCATION', 297.64, 50, { align: 'center' });
    RichTextPdf.render(doc, editorEl, { y0: 80 });
    doc.save(`bail-${slugify(locataireNom)}.pdf`);
  }

  byId('btn-redaction-pdf').addEventListener('click', () => {
    const locataireId = byId('redaction-locataire').value;
    const loc = locataireById(locataireId);
    if (!loc) { alert("Ajoutez d'abord un locataire, puis sélectionnez-le."); return; }
    if (RichTextPdf.isEmpty(byId('redaction-editor'))) { alert('Le document est vide.'); return; }
    saveRedactionDraft();
    renderRedactionHistory();
    downloadRedactionPdf(byId('redaction-editor'), loc.nom);
  });

  function renderRedactionHistory() {
    const locId = byId('redaction-locataire').value;
    const tbody = document.querySelector('#redaction-history-table tbody');
    const drafts = data.bailRedactions
      .filter((r) => r.locataireId === locId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!locId || drafts.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="3">Aucune rédaction pour ce locataire.</td></tr>';
      return;
    }
    tbody.innerHTML = drafts.map((r) => {
      const dateLabel = new Date(r.updatedAt).toLocaleDateString('fr-FR');
      return `<tr>
        <td>${dateLabel}</td>
        <td>${escapeHTML(r.libelle || '—')}</td>
        <td class="actions-cell">
          <button type="button" class="btn btn-sm" data-edit-redaction="${r.id}">Modifier</button>
          <button type="button" class="btn btn-sm" data-pdf-redaction="${r.id}">Télécharger le PDF</button>
          <button type="button" class="btn btn-sm btn-danger" data-del-redaction="${r.id}">Supprimer</button>
        </td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-edit-redaction]').forEach((btn) => btn.addEventListener('click', () => loadRedactionDraft(btn.dataset.editRedaction)));
    tbody.querySelectorAll('[data-pdf-redaction]').forEach((btn) => btn.addEventListener('click', () => {
      const r = data.bailRedactions.find((x) => x.id === btn.dataset.pdfRedaction);
      const loc = r ? locataireById(r.locataireId) : null;
      if (!r || !loc) return;
      const tempEl = document.createElement('div');
      tempEl.innerHTML = r.html;
      downloadRedactionPdf(tempEl, loc.nom);
    }));
    tbody.querySelectorAll('[data-del-redaction]').forEach((btn) => btn.addEventListener('click', () => deleteRedaction(btn.dataset.delRedaction)));
  }

  function loadRedactionDraft(id) {
    const r = data.bailRedactions.find((x) => x.id === id);
    if (!r) return;
    currentRedactionDraftId = r.id;
    byId('redaction-libelle').value = r.libelle || '';
    byId('redaction-editor').innerHTML = r.html || '';
  }

  function deleteRedaction(id) {
    if (!confirm('Supprimer cette rédaction ?')) return;
    data.bailRedactions = data.bailRedactions.filter((r) => r.id !== id);
    if (currentRedactionDraftId === id) {
      currentRedactionDraftId = null;
      byId('redaction-editor').innerHTML = '';
      byId('redaction-libelle').value = '';
    }
    save();
    renderRedactionHistory();
  }

  function renderRedactionBailView() {
    renderModeleEditor();
    populateRedactionLocataireSelect();
    currentRedactionDraftId = null;
    byId('redaction-editor').innerHTML = '';
    byId('redaction-libelle').value = '';
    updateRedactionLabels();
    renderRedactionHistory();
  }

  // ---------- Rédiger un état des lieux (Phase 1 : pièces par bien) ----------
  function createElementRow(name) {
    const div = document.createElement('div');
    div.className = 'edl-element-row';
    div.innerHTML = `
      <input type="text" class="edl-element-name" placeholder="Nom de l'élément">
      <button type="button" class="btn btn-sm btn-danger edl-element-remove">Supprimer</button>
    `;
    div.querySelector('.edl-element-name').value = name || '';
    div.querySelector('.edl-element-remove').addEventListener('click', () => div.remove());
    return div;
  }

  function createRoomCard(room) {
    const card = document.createElement('div');
    card.className = 'edl-room-card';
    card.dataset.type = room.type || 'autre';
    const typeLabel = (EDL_ROOM_TYPES[room.type] || EDL_ROOM_TYPES.autre).label;
    card.innerHTML = `
      <div class="edl-room-header">
        <input type="text" class="edl-room-name" placeholder="Nom de la pièce">
        <span class="edl-room-type-label">${escapeHTML(typeLabel)}</span>
        <button type="button" class="btn btn-sm btn-danger edl-room-remove">Supprimer la pièce</button>
      </div>
      <div class="edl-elements-list"></div>
      <button type="button" class="btn btn-sm edl-element-add">+ Ajouter un élément</button>
    `;
    card.querySelector('.edl-room-name').value = room.nom || '';
    const elementsList = card.querySelector('.edl-elements-list');
    (room.elements || []).forEach((el) => elementsList.appendChild(createElementRow(el.nom || el)));
    card.querySelector('.edl-element-add').addEventListener('click', () => {
      elementsList.appendChild(createElementRow(''));
    });
    card.querySelector('.edl-room-remove').addEventListener('click', () => {
      if (confirm('Supprimer cette pièce et tous ses éléments ?')) card.remove();
    });
    return card;
  }

  function addRoomOfType(typeKey, list) {
    const typeInfo = EDL_ROOM_TYPES[typeKey] || EDL_ROOM_TYPES.autre;
    const existingCount = list.querySelectorAll(`.edl-room-card[data-type="${typeKey}"]`).length;
    const nom = existingCount > 0 ? `${typeInfo.label} ${existingCount + 1}` : typeInfo.label;
    const room = { nom, type: typeKey, elements: typeInfo.elements.map((n) => ({ nom: n })) };
    list.appendChild(createRoomCard(room));
  }

  function wireRoomTypeChips(chipsId, listId) {
    byId(chipsId).innerHTML = Object.keys(EDL_ROOM_TYPES).map((key) =>
      `<button type="button" class="field-chip" data-room-type="${key}">+ ${escapeHTML(EDL_ROOM_TYPES[key].label)}</button>`
    ).join('');
    byId(chipsId).querySelectorAll('[data-room-type]').forEach((btn) => {
      btn.addEventListener('click', () => addRoomOfType(btn.dataset.roomType, byId(listId)));
    });
  }
  wireRoomTypeChips('edl-room-type-chips', 'edl-rooms-list');
  wireRoomTypeChips('edl-modele-room-chips', 'edl-modele-rooms-list');

  function populateEdlGabaritBienSelect() {
    const sel = byId('edl-gabarit-bien');
    const prev = sel.value;
    if (data.biens.length === 0) {
      sel.innerHTML = '<option value="">Aucun bien enregistré</option>';
      return;
    }
    sel.innerHTML = data.biens.map((b) => `<option value="${b.id}">${escapeHTML(b.nom)}</option>`).join('');
    if (prev && bienById(prev)) sel.value = prev;
  }

  byId('btn-edl-duplicate-bien').addEventListener('click', () => {
    const bienId = byId('edl-gabarit-bien').value;
    if (!bienId) { alert("Sélectionnez d'abord un bien à dupliquer."); return; }
    const newBien = duplicateBien(bienId, { silent: true });
    if (!newBien) return;
    populateEdlGabaritBienSelect();
    byId('edl-gabarit-bien').value = newBien.id;
    byId('edl-gabarit-bien').dispatchEvent(new Event('change'));
    alert(`Bien dupliqué : « ${newBien.nom} ». Ses pièces, compteurs et clés ont été copiés — renommez-le, corrigez son adresse (panneau "Biens") puis ajustez si besoin ci-dessous.`);
  });

  function renderEdlGabaritRooms() {
    const bienId = byId('edl-gabarit-bien').value;
    const list = byId('edl-rooms-list');
    list.innerHTML = '';
    if (!bienId) return;
    const gabarit = data.bienGabarits.find((g) => g.bienId === bienId);
    (gabarit ? gabarit.pieces : []).forEach((room) => list.appendChild(createRoomCard(room)));
  }

  byId('edl-gabarit-bien').addEventListener('change', () => {
    renderEdlGabaritRooms();
    renderEdlGabaritMeters();
    renderEdlGabaritCles();
  });

  function collectRoomsFromList(listId) {
    return [...document.querySelectorAll(`#${listId} .edl-room-card`)].map((card) => ({
      id: Storage.uid(),
      nom: card.querySelector('.edl-room-name').value.trim(),
      type: card.dataset.type,
      elements: [...card.querySelectorAll('.edl-elements-list .edl-element-row')]
        .map((row) => ({ id: Storage.uid(), nom: row.querySelector('.edl-element-name').value.trim() }))
        .filter((el) => el.nom),
    })).filter((r) => r.nom);
  }
  function collectEdlGabaritRooms() { return collectRoomsFromList('edl-rooms-list'); }

  function createMeterRow(name, numero) {
    const div = document.createElement('div');
    div.className = 'edl-meter-row';
    div.innerHTML = `
      <input type="text" class="edl-meter-name" placeholder="Nom du compteur">
      <input type="text" class="edl-meter-numero" placeholder="N° de compteur">
      <button type="button" class="btn btn-sm btn-danger edl-meter-remove">Supprimer</button>
    `;
    div.querySelector('.edl-meter-name').value = name || '';
    div.querySelector('.edl-meter-numero').value = numero || '';
    div.querySelector('.edl-meter-remove').addEventListener('click', () => div.remove());
    return div;
  }

  function wireMeterChips(chipsId, listId) {
    byId(chipsId).innerHTML = EDL_METER_DEFAULTS
      .map((name) => `<button type="button" class="field-chip" data-meter-name="${escapeHTML(name)}">+ ${escapeHTML(name)}</button>`)
      .join('') + '<button type="button" class="field-chip" data-meter-name="">+ Autre compteur</button>';
    byId(chipsId).querySelectorAll('[data-meter-name]').forEach((btn) => {
      btn.addEventListener('click', () => {
        byId(listId).appendChild(createMeterRow(btn.dataset.meterName));
      });
    });
  }
  wireMeterChips('edl-meter-chips', 'edl-meters-gabarit-list');
  wireMeterChips('edl-modele-meter-chips', 'edl-modele-meters-list');

  function renderEdlGabaritMeters() {
    const bienId = byId('edl-gabarit-bien').value;
    const list = byId('edl-meters-gabarit-list');
    list.innerHTML = '';
    if (!bienId) return;
    const gabarit = data.bienGabarits.find((g) => g.bienId === bienId);
    (gabarit && gabarit.compteurs ? gabarit.compteurs : []).forEach((m) => list.appendChild(createMeterRow(m.nom, m.numero)));
  }

  function collectMetersFromList(listId) {
    return [...document.querySelectorAll(`#${listId} .edl-meter-row`)]
      .map((row) => ({
        id: Storage.uid(),
        nom: row.querySelector('.edl-meter-name').value.trim(),
        numero: row.querySelector('.edl-meter-numero').value.trim(),
      }))
      .filter((m) => m.nom);
  }
  function collectEdlGabaritMeters() { return collectMetersFromList('edl-meters-gabarit-list'); }

  function createCleRow(name) {
    const div = document.createElement('div');
    div.className = 'edl-meter-row';
    div.innerHTML = `
      <input type="text" class="edl-cle-name" placeholder="Nom de la clé / du badge">
      <button type="button" class="btn btn-sm btn-danger edl-meter-remove">Supprimer</button>
    `;
    div.querySelector('.edl-cle-name').value = name || '';
    div.querySelector('.edl-meter-remove').addEventListener('click', () => div.remove());
    return div;
  }

  function wireCleChips(chipsId, listId) {
    byId(chipsId).innerHTML = EDL_CLES_DEFAULTS
      .map((name) => `<button type="button" class="field-chip" data-cle-name="${escapeHTML(name)}">+ ${escapeHTML(name)}</button>`)
      .join('') + '<button type="button" class="field-chip" data-cle-name="">+ Autre clé / badge</button>';
    byId(chipsId).querySelectorAll('[data-cle-name]').forEach((btn) => {
      btn.addEventListener('click', () => {
        byId(listId).appendChild(createCleRow(btn.dataset.cleName));
      });
    });
  }
  wireCleChips('edl-cle-chips', 'edl-cles-gabarit-list');
  wireCleChips('edl-modele-cle-chips', 'edl-modele-cles-list');

  function renderEdlGabaritCles() {
    const bienId = byId('edl-gabarit-bien').value;
    const list = byId('edl-cles-gabarit-list');
    list.innerHTML = '';
    if (!bienId) return;
    const gabarit = data.bienGabarits.find((g) => g.bienId === bienId);
    (gabarit && gabarit.cles ? gabarit.cles : []).forEach((c) => list.appendChild(createCleRow(c.nom)));
  }

  function collectClesFromList(listId) {
    return [...document.querySelectorAll(`#${listId} .edl-meter-row`)]
      .map((row) => ({ id: Storage.uid(), nom: row.querySelector('.edl-cle-name').value.trim() }))
      .filter((c) => c.nom);
  }
  function collectEdlGabaritCles() { return collectClesFromList('edl-cles-gabarit-list'); }

  // Enregistre la configuration affichée à l'écran (pièces, compteurs, clés)
  // dans le gabarit du bien. Renvoie le gabarit, ou null si aucun bien choisi.
  function persistEdlGabarit() {
    const bienId = byId('edl-gabarit-bien').value;
    if (!bienId) return null;
    const pieces = collectEdlGabaritRooms();
    const compteurs = collectEdlGabaritMeters();
    const cles = collectEdlGabaritCles();
    let gabarit = data.bienGabarits.find((g) => g.bienId === bienId);
    if (gabarit) {
      gabarit.pieces = pieces;
      gabarit.compteurs = compteurs;
      gabarit.cles = cles;
    } else {
      gabarit = { id: Storage.uid(), bienId, pieces, compteurs, cles };
      data.bienGabarits.push(gabarit);
    }
    save();
    return gabarit;
  }

  byId('btn-edl-gabarit-save').addEventListener('click', () => {
    if (!persistEdlGabarit()) { alert("Ajoutez d'abord un bien, puis sélectionnez-le."); return; }
    alert('Pièces, compteurs et clés enregistrés pour ce bien.');
  });

  // ---------- Modèles d'état des lieux réutilisables (non liés à un bien) ----------
  function populateEdlModeleSelect() {
    const sel = byId('edl-modele-select');
    const prev = sel.value;
    sel.innerHTML = '<option value="__new__">+ Nouveau modèle</option>' +
      data.edlModeles.map((m) => `<option value="${m.id}">${escapeHTML(m.nom)}</option>`).join('');
    if (prev && data.edlModeles.some((m) => m.id === prev)) sel.value = prev;
  }

  function populateEdlApplyModeleSelect() {
    const sel = byId('edl-apply-modele-select');
    const prev = sel.value;
    if (data.edlModeles.length === 0) {
      sel.innerHTML = '<option value="">Aucun modèle enregistré</option>';
      return;
    }
    sel.innerHTML = '<option value="">— Choisir un modèle —</option>' +
      data.edlModeles.map((m) => `<option value="${m.id}">${escapeHTML(m.nom)}</option>`).join('');
    if (prev && data.edlModeles.some((m) => m.id === prev)) sel.value = prev;
  }

  function loadEdlModeleIntoEditor(modeleId) {
    byId('edl-modele-rooms-list').innerHTML = '';
    byId('edl-modele-meters-list').innerHTML = '';
    byId('edl-modele-cles-list').innerHTML = '';
    byId('btn-edl-modele-delete').hidden = true;
    if (modeleId === '__new__' || !modeleId) {
      byId('edl-modele-nom').value = '';
      return;
    }
    const modele = data.edlModeles.find((m) => m.id === modeleId);
    if (!modele) return;
    byId('edl-modele-nom').value = modele.nom || '';
    modele.pieces.forEach((room) => byId('edl-modele-rooms-list').appendChild(createRoomCard(room)));
    (modele.compteurs || []).forEach((m) => byId('edl-modele-meters-list').appendChild(createMeterRow(m.nom, m.numero)));
    (modele.cles || []).forEach((c) => byId('edl-modele-cles-list').appendChild(createCleRow(c.nom)));
    byId('btn-edl-modele-delete').hidden = false;
  }

  byId('edl-modele-select').addEventListener('change', (e) => loadEdlModeleIntoEditor(e.target.value));

  byId('btn-edl-modele-save').addEventListener('click', () => {
    const nom = byId('edl-modele-nom').value.trim();
    if (!nom) { alert('Renseignez un nom pour ce modèle.'); return; }
    const pieces = collectRoomsFromList('edl-modele-rooms-list');
    const compteurs = collectMetersFromList('edl-modele-meters-list');
    const cles = collectClesFromList('edl-modele-cles-list');
    const selectedId = byId('edl-modele-select').value;
    let modele = selectedId !== '__new__' ? data.edlModeles.find((m) => m.id === selectedId) : null;
    if (modele) {
      modele.nom = nom;
      modele.pieces = pieces;
      modele.compteurs = compteurs;
      modele.cles = cles;
    } else {
      modele = { id: Storage.uid(), nom, pieces, compteurs, cles };
      data.edlModeles.push(modele);
    }
    save();
    populateEdlModeleSelect();
    populateEdlApplyModeleSelect();
    byId('edl-modele-select').value = modele.id;
    byId('btn-edl-modele-delete').hidden = false;
    alert(`Modèle "${modele.nom}" enregistré. Il ne crée ni bien ni locataire — utilisez "Appliquer ce modèle à ce bien" (panneau 1) pour vous en servir.`);
  });

  byId('btn-edl-modele-delete').addEventListener('click', () => {
    const modeleId = byId('edl-modele-select').value;
    const modele = data.edlModeles.find((m) => m.id === modeleId);
    if (!modele) return;
    if (!confirm(`Supprimer le modèle "${modele.nom}" ? Les biens déjà configurés à partir de ce modèle ne seront pas modifiés.`)) return;
    data.edlModeles = data.edlModeles.filter((m) => m.id !== modeleId);
    save();
    populateEdlModeleSelect();
    populateEdlApplyModeleSelect();
    loadEdlModeleIntoEditor('__new__');
  });

  byId('btn-edl-apply-modele').addEventListener('click', () => {
    const bienId = byId('edl-gabarit-bien').value;
    const modeleId = byId('edl-apply-modele-select').value;
    if (!bienId) { alert("Sélectionnez d'abord un bien (panneau 1)."); return; }
    if (!modeleId) { alert("Sélectionnez un modèle à appliquer."); return; }
    const modele = data.edlModeles.find((m) => m.id === modeleId);
    if (!modele) return;
    if (!confirm(`Remplacer les pièces, compteurs et clés actuels de ce bien par le modèle « ${modele.nom} » ?`)) return;
    const clonedPieces = modele.pieces.map((room) => ({
      id: Storage.uid(),
      nom: room.nom,
      type: room.type,
      elements: room.elements.map((el) => ({ id: Storage.uid(), nom: el.nom })),
    }));
    const clonedCompteurs = (modele.compteurs || []).map((m) => ({ id: Storage.uid(), nom: m.nom, numero: m.numero || '' }));
    const clonedCles = (modele.cles || []).map((c) => ({ id: Storage.uid(), nom: c.nom }));
    let gabarit = data.bienGabarits.find((g) => g.bienId === bienId);
    if (gabarit) {
      gabarit.pieces = clonedPieces;
      gabarit.compteurs = clonedCompteurs;
      gabarit.cles = clonedCles;
    } else {
      gabarit = { id: Storage.uid(), bienId, pieces: clonedPieces, compteurs: clonedCompteurs, cles: clonedCles };
      data.bienGabarits.push(gabarit);
    }
    save();
    renderEdlGabaritRooms();
    renderEdlGabaritMeters();
    renderEdlGabaritCles();
    alert(`Modèle « ${modele.nom} » appliqué à ce bien. Vérifiez/ajustez ci-dessous (panneaux 2 et 3) puis enregistrez si besoin.`);
  });

  byId('btn-edl-save-as-modele').addEventListener('click', () => {
    const bienId = byId('edl-gabarit-bien').value;
    if (!bienId) { alert("Sélectionnez d'abord un bien (panneau 1)."); return; }
    const gabarit = data.bienGabarits.find((g) => g.bienId === bienId);
    const hasContent = gabarit && (gabarit.pieces.length || (gabarit.compteurs || []).length || (gabarit.cles || []).length);
    if (!hasContent) { alert("Ce bien n'a pas encore de pièces/compteurs/clés configurés (panneaux 2 et 3) à enregistrer comme modèle."); return; }
    const bien = bienById(bienId);
    const suggestion = (bien ? bien.nom : '').replace(/\s*\(copie\)/gi, '').replace(/TEST/gi, '').trim();
    const nom = prompt('Nom du modèle à créer à partir de ce bien (ex : "Maison standard 1 à 5") :', suggestion);
    if (!nom || !nom.trim()) return;
    const modele = {
      id: Storage.uid(),
      nom: nom.trim(),
      pieces: gabarit.pieces.map((room) => ({
        id: Storage.uid(),
        nom: room.nom,
        type: room.type,
        elements: room.elements.map((el) => ({ id: Storage.uid(), nom: el.nom })),
      })),
      compteurs: (gabarit.compteurs || []).map((m) => ({ id: Storage.uid(), nom: m.nom, numero: '' })),
      cles: (gabarit.cles || []).map((c) => ({ id: Storage.uid(), nom: c.nom })),
    };
    data.edlModeles.push(modele);
    save();
    populateEdlModeleSelect();
    populateEdlApplyModeleSelect();
    alert(`Modèle "${modele.nom}" créé à partir de ce bien. Vous pouvez maintenant supprimer ce bien s'il ne s'agissait que d'un brouillon (rubrique "Biens").`);
  });

  // ---------- Phase 2 : rédaction concrète (vétusté, photos, notes) ----------
  function populateEdlRedacLocataireSelect() {
    const bienId = byId('edl-gabarit-bien').value;
    const sel = byId('edl-redac-locataire');
    const prev = sel.value;
    const options = data.locataires.filter((l) => l.bienId === bienId);
    if (options.length === 0) {
      sel.innerHTML = '<option value="">Aucun locataire pour ce bien</option>';
      return;
    }
    sel.innerHTML = options.map((l) => `<option value="${l.id}">${escapeHTML(l.nom)}</option>`).join('');
    if (prev && options.some((l) => l.id === prev)) sel.value = prev;
  }

  document.querySelectorAll('#edl-redac-type-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentEdlRedacSens = btn.dataset.edlRedacType;
      document.querySelectorAll('#edl-redac-type-toggle .toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  async function renderEdlPhotoGallery(container, el) {
    container.innerHTML = '';
    for (const f of el.files) {
      const blob = await FilesDb.getFile(f.fileId);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const thumb = document.createElement('div');
      thumb.className = 'edl-photo-thumb';
      thumb.innerHTML = '<img><button type="button" class="edl-photo-remove">&times;</button>';
      const img = thumb.querySelector('img');
      img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      img.src = url;
      img.addEventListener('click', () => openStoredFile(f.fileId, f.fileName));
      thumb.querySelector('.edl-photo-remove').addEventListener('click', async () => {
        el.files = el.files.filter((x) => x.fileId !== f.fileId);
        try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
        renderEdlPhotoGallery(container, el);
      });
      container.appendChild(thumb);
    }
  }

  // Redimensionne une photo cote client avant stockage : une photo de telephone
  // (plusieurs Mo) n'a pas besoin d'etre conservee en pleine resolution pour un
  // etat des lieux, et ca allege fortement le PDF genere et le stockage IndexedDB.
  // En cas d'echec (format non decodable, etc.), le fichier original est conserve.
  function resizeImageFile(file, maxDim, quality) {
    return new Promise((resolve) => {
      if (!file.type || !file.type.startsWith('image/')) { resolve(file); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width <= maxDim && height <= maxDim) { resolve(file); return; }
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) { resolve(file); return; }
          resolve(new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function edlVetusteLabel(v) {
    const opt = EDL_VETUSTE_OPTIONS.find((o) => o.value === v);
    return opt && opt.value ? opt.label : '—';
  }

  function createEdlRedacElement(el) {
    const div = document.createElement('div');
    div.className = 'edl-redac-element';
    const vetusteOptions = EDL_VETUSTE_OPTIONS.map((o) => `<option value="${o.value}">${escapeHTML(o.label)}</option>`).join('');
    const compareHTML = el.vetusteEntree !== undefined
      ? `<div class="edl-compare-line">État à l'entrée : <strong>${escapeHTML(edlVetusteLabel(el.vetusteEntree))}</strong></div>`
      : '';
    div.innerHTML = `
      <div class="edl-redac-element-header">
        <span class="edl-redac-element-name">${escapeHTML(el.nom)}</span>
        <select class="edl-redac-element-vetuste">${vetusteOptions}</select>
      </div>
      ${compareHTML}
      <textarea class="edl-redac-element-note" rows="1" placeholder="Note (optionnel)"></textarea>
      <div class="edl-photo-gallery"></div>
      <label class="edl-photo-add-label">+ Ajouter une photo
        <input type="file" accept="image/*" capture="environment" multiple hidden>
      </label>
    `;
    const vetusteSelect = div.querySelector('.edl-redac-element-vetuste');
    const compareLine = div.querySelector('.edl-compare-line');
    function updateCompareHighlight() {
      if (!compareLine) return;
      const diff = !!el.vetuste && el.vetusteEntree !== undefined && el.vetuste !== el.vetusteEntree;
      compareLine.classList.toggle('edl-compare-diff', diff);
    }
    vetusteSelect.value = el.vetuste || '';
    updateCompareHighlight();
    vetusteSelect.addEventListener('change', (e) => { el.vetuste = e.target.value; updateCompareHighlight(); });

    const noteInput = div.querySelector('.edl-redac-element-note');
    noteInput.value = el.note || '';
    noteInput.addEventListener('input', (e) => { el.note = e.target.value; });

    const gallery = div.querySelector('.edl-photo-gallery');
    renderEdlPhotoGallery(gallery, el);

    const fileInput = div.querySelector('input[type="file"]');
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      for (const file of files) {
        const fileId = Storage.uid();
        try {
          const optimized = await resizeImageFile(file, 1600, 0.82);
          await FilesDb.saveFile(fileId, optimized);
          el.files.push({ fileId, fileName: file.name });
        } catch (e) {
          console.error(e);
          alert("Une photo n'a pas pu être enregistrée.");
        }
      }
      renderEdlPhotoGallery(gallery, el);
    });

    return div;
  }

  // Pendant une rédaction, la page ne montre que la saisie : toute la
  // configuration du bien (modèles, pièces, compteurs, création) est masquée.
  // Sur le terrain, avec un locataire en face, faire défiler ces listes avant
  // d'atteindre les champs à remplir était la principale source d'erreurs.
  function updateEdlSaisieMode() {
    const vue = byId('view-edl-redaction');
    const enCours = !!currentEdlRedaction;
    vue.classList.toggle('edl-saisie-en-cours', enCours);
    if (!enCours) vue.classList.remove('edl-config-visible');
    byId('edl-config-hint').hidden = !enCours;
    byId('edl-correction-hint').hidden = !enCours;
    // Les signatures ne concernent qu'une rédaction en cours : affichées en
    // permanence, elles restaient seules à l'écran une fois la rédaction
    // terminée ou le gabarit enregistré, donnant l'impression d'avoir sauté
    // toutes les étapes de saisie.
    byId('edl-signatures-title').hidden = !enCours;
    if (!enCours) byId('edl-sortant-bloc').hidden = true;
    byId('edl-signatures-row').hidden = !enCours;
  }

  function renderEdlRedacRooms() {
    const container = byId('edl-redac-rooms');
    container.innerHTML = '';
    byId('edl-redac-rooms-title').hidden = !currentEdlRedaction;
    updateEdlSaisieMode();
    if (!currentEdlRedaction) return;
    currentEdlRedaction.pieces.forEach((room) => {
      const roomEl = document.createElement('div');
      roomEl.className = 'edl-redac-room';
      const title = document.createElement('h3');
      title.className = 'edl-redac-room-title';
      title.textContent = room.nom;
      roomEl.appendChild(title);
      room.elements.forEach((el) => roomEl.appendChild(createEdlRedacElement(el)));
      container.appendChild(roomEl);
    });
  }

  function createEdlRedacMeter(m) {
    const div = document.createElement('div');
    div.className = 'edl-redac-meter';
    const compareHTML = m.indexEntree !== undefined
      ? `<div class="edl-compare-line">Index à l'entrée : <strong>${escapeHTML(m.indexEntree === '' ? '—' : String(m.indexEntree))}</strong><span class="edl-compare-conso"></span></div>`
      : '';
    div.innerHTML = `
      <div class="edl-redac-meter-header">
        <span class="edl-redac-meter-name">${escapeHTML(m.nom)}${m.numero ? ` <span class="edl-redac-meter-numero">N° ${escapeHTML(m.numero)}</span>` : ''}</span>
        <input type="number" step="0.01" class="edl-redac-meter-index" placeholder="Index relevé">
      </div>
      <input type="text" class="edl-redac-meter-consommation" placeholder="Consommation notée (ex : 120 kWh)">
      ${compareHTML}
      <div class="edl-photo-gallery"></div>
      <label class="edl-photo-add-label">+ Ajouter une photo
        <input type="file" accept="image/*" capture="environment" multiple hidden>
      </label>
    `;
    const indexInput = div.querySelector('.edl-redac-meter-index');
    const consommationInput = div.querySelector('.edl-redac-meter-consommation');
    const compareConso = div.querySelector('.edl-compare-conso');
    function updateConso() {
      if (!compareConso) return;
      const entree = Number(m.indexEntree);
      const sortie = Number(m.index);
      if (m.indexEntree === '' || m.indexEntree == null || m.index === '' || m.index == null || Number.isNaN(entree) || Number.isNaN(sortie)) {
        compareConso.textContent = '';
        return;
      }
      compareConso.textContent = ` — Consommation : ${sortie - entree}`;
    }
    indexInput.value = m.index === '' || m.index == null ? '' : m.index;
    consommationInput.value = m.consommation || '';
    consommationInput.addEventListener('input', (e) => { m.consommation = e.target.value; });
    updateConso();
    indexInput.addEventListener('input', (e) => { m.index = e.target.value; updateConso(); });

    const gallery = div.querySelector('.edl-photo-gallery');
    renderEdlPhotoGallery(gallery, m);

    const fileInput = div.querySelector('input[type="file"]');
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      for (const file of files) {
        const fileId = Storage.uid();
        try {
          const optimized = await resizeImageFile(file, 1600, 0.82);
          await FilesDb.saveFile(fileId, optimized);
          m.files.push({ fileId, fileName: file.name });
        } catch (e) {
          console.error(e);
          alert("Une photo n'a pas pu être enregistrée.");
        }
      }
      renderEdlPhotoGallery(gallery, m);
    });

    return div;
  }

  function renderEdlRedacMeters() {
    const container = byId('edl-redac-meters');
    container.innerHTML = '';
    // Tant qu'une rédaction est en cours, la section reste TOUJOURS visible :
    // la masquer quand le bien n'a pas de compteur configuré donnait
    // l'impression que la saisie des index n'existait pas dans l'application.
    byId('edl-redac-meters-title').hidden = !currentEdlRedaction;
    if (!currentEdlRedaction) return;
    if (!currentEdlRedaction.compteurs || currentEdlRedaction.compteurs.length === 0) {
      container.innerHTML = '<p class="charges-note">Aucun compteur n\'est configuré pour ce bien. Ajoutez-les au panneau <strong>3. Compteurs du bien</strong> ci-dessus (nom et numéro), enregistrez, puis recréez cet état des lieux : les champs d\'index et de photos apparaîtront ici.</p>';
      return;
    }
    currentEdlRedaction.compteurs.forEach((m) => container.appendChild(createEdlRedacMeter(m)));
  }

  function createEdlRedacCle(c) {
    const div = document.createElement('div');
    div.className = 'edl-redac-meter';
    const vetusteOptions = EDL_VETUSTE_OPTIONS.map((o) => `<option value="${o.value}">${escapeHTML(o.label)}</option>`).join('');
    const compareHTML = c.nombreEntree !== undefined
      ? `<div class="edl-compare-line">À l'entrée : <strong>${escapeHTML(c.nombreEntree === '' ? '—' : String(c.nombreEntree))}</strong> — <strong>${escapeHTML(edlVetusteLabel(c.vetusteEntree))}</strong></div>`
      : '';
    div.innerHTML = `
      <div class="edl-redac-meter-header">
        <span class="edl-redac-meter-name">${escapeHTML(c.nom)}</span>
        <input type="number" step="1" class="edl-redac-cle-nombre" placeholder="Nombre">
        <select class="edl-redac-cle-vetuste">${vetusteOptions}</select>
      </div>
      ${compareHTML}
      <div class="edl-photo-gallery"></div>
      <label class="edl-photo-add-label">+ Ajouter une photo
        <input type="file" accept="image/*" capture="environment" multiple hidden>
      </label>
    `;
    const nombreInput = div.querySelector('.edl-redac-cle-nombre');
    const vetusteSelect = div.querySelector('.edl-redac-cle-vetuste');
    nombreInput.value = c.nombre === '' || c.nombre == null ? '' : c.nombre;
    nombreInput.addEventListener('input', (e) => { c.nombre = e.target.value; });
    vetusteSelect.value = c.vetuste || '';
    vetusteSelect.addEventListener('change', (e) => { c.vetuste = e.target.value; });

    const gallery = div.querySelector('.edl-photo-gallery');
    renderEdlPhotoGallery(gallery, c);

    const fileInput = div.querySelector('input[type="file"]');
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      for (const file of files) {
        const fileId = Storage.uid();
        try {
          const optimized = await resizeImageFile(file, 1600, 0.82);
          await FilesDb.saveFile(fileId, optimized);
          c.files.push({ fileId, fileName: file.name });
        } catch (e) {
          console.error(e);
          alert("Une photo n'a pas pu être enregistrée.");
        }
      }
      renderEdlPhotoGallery(gallery, c);
    });

    return div;
  }

  function renderEdlRedacCles() {
    const container = byId('edl-redac-cles');
    container.innerHTML = '';
    // Même principe que pour les compteurs : la section reste visible.
    byId('edl-redac-cles-title').hidden = !currentEdlRedaction;
    if (!currentEdlRedaction) return;
    if (!currentEdlRedaction.cles || currentEdlRedaction.cles.length === 0) {
      container.innerHTML = '<p class="charges-note">Aucune clé ni badge n\'est configuré pour ce bien. Ajoutez-les au panneau <strong>Clés et badges du bien</strong> ci-dessus, enregistrez, puis recréez cet état des lieux.</p>';
      return;
    }
    currentEdlRedaction.cles.forEach((c) => container.appendChild(createEdlRedacCle(c)));
  }

  // ---------- Signature locataire (canvas) ----------
  const edlSigCanvas = byId('edl-signature-locataire-canvas');
  const edlSigCtx = edlSigCanvas.getContext('2d');
  let edlSigDrawing = false;
  let edlSigHasStroke = false;

  function edlSigInitCanvas() {
    edlSigCtx.fillStyle = '#fff';
    edlSigCtx.fillRect(0, 0, edlSigCanvas.width, edlSigCanvas.height);
    edlSigCtx.strokeStyle = '#111';
    edlSigCtx.lineWidth = 2;
    edlSigCtx.lineCap = 'round';
    edlSigCtx.lineJoin = 'round';
    edlSigHasStroke = false;
  }

  function edlSigPointerPos(e) {
    const rect = edlSigCanvas.getBoundingClientRect();
    const scaleX = edlSigCanvas.width / rect.width;
    const scaleY = edlSigCanvas.height / rect.height;
    const point = (e.touches && e.touches.length) ? e.touches[0] : e;
    return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY };
  }

  function edlSigStart(e) {
    e.preventDefault();
    edlSigDrawing = true;
    const p = edlSigPointerPos(e);
    edlSigCtx.beginPath();
    edlSigCtx.moveTo(p.x, p.y);
  }
  function edlSigMove(e) {
    if (!edlSigDrawing) return;
    e.preventDefault();
    const p = edlSigPointerPos(e);
    edlSigCtx.lineTo(p.x, p.y);
    edlSigCtx.stroke();
    edlSigHasStroke = true;
  }
  function edlSigEnd() { edlSigDrawing = false; }

  edlSigCanvas.addEventListener('mousedown', edlSigStart);
  edlSigCanvas.addEventListener('mousemove', edlSigMove);
  window.addEventListener('mouseup', edlSigEnd);
  edlSigCanvas.addEventListener('touchstart', edlSigStart, { passive: false });
  edlSigCanvas.addEventListener('touchmove', edlSigMove, { passive: false });
  edlSigCanvas.addEventListener('touchend', edlSigEnd);

  function renderEdlSignatureBailleur() {
    const box = byId('edl-signature-bailleur-box');
    box.innerHTML = data.sci.signature
      ? `<img src="${escapeHTML(data.sci.signature)}" alt="Signature bailleur">`
      : '<span class="signature-empty">Aucune signature enregistrée (configurez-la dans "Ma SCI")</span>';
  }

  function renderEdlSignatureLocataire() {
    const preview = byId('edl-signature-locataire-preview');
    const clearBtn = byId('btn-edl-signature-clear');
    const resignBtn = byId('btn-edl-signature-resign');
    const signed = !!(currentEdlRedaction && currentEdlRedaction.signatureLocataire);
    if (signed) {
      preview.src = currentEdlRedaction.signatureLocataire;
      preview.hidden = false;
      edlSigCanvas.hidden = true;
      clearBtn.hidden = true;
      resignBtn.hidden = false;
    } else {
      preview.hidden = true;
      edlSigCanvas.hidden = false;
      edlSigInitCanvas();
      clearBtn.hidden = false;
      resignBtn.hidden = true;
    }
  }

  byId('btn-edl-signature-clear').addEventListener('click', () => {
    edlSigInitCanvas();
  });

  byId('btn-edl-signature-resign').addEventListener('click', () => {
    if (currentEdlRedaction) currentEdlRedaction.signatureLocataire = '';
    renderEdlSignatureLocataire();
  });

  function updateEdlRedacLabels() {
    if (!currentEdlRedaction) {
      byId('edl-redac-current-label').textContent = '—';
    // Remet l'écran en mode "pas de rédaction" : sans cela, le bandeau de
    // configuration masquée et le bloc Signatures restaient affichés alors
    // qu'il n'y avait plus rien à saisir (écran figé sur les signatures).
    updateEdlSaisieMode();
      return;
    }
    const loc = locataireById(currentEdlRedaction.locataireId);
    const sensLabel = currentEdlRedaction.sens === 'sortant' ? 'Sortant' : 'Entrant';
    const dateLabel = currentEdlRedaction.date ? new Date(`${currentEdlRedaction.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
    byId('edl-redac-current-label').textContent = `${loc ? loc.nom : '—'} — ${sensLabel} — ${dateLabel}`;
  }

  function updateEdlRedacCompareNote(entrant) {
    const note = byId('edl-redac-compare-note');
    if (currentEdlRedacSens !== 'sortant') {
      note.hidden = true;
      return;
    }
    if (entrant) {
      const dateLabel = entrant.date ? new Date(`${entrant.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      note.textContent = `Structure et écarts basés sur l'état des lieux d'entrée du ${dateLabel} pour ce locataire.`;
      note.classList.remove('edl-compare-warn');
    } else {
      note.textContent = "Aucun état des lieux d'entrée trouvé pour ce locataire dans cet outil — structure reprise du gabarit du bien, sans comparaison possible.";
      note.classList.add('edl-compare-warn');
    }
    note.hidden = false;
  }

  function clearCurrentEdlRedaction() {
    currentEdlRedaction = null;
    hasUnsavedWork = false;
    byId('edl-redac-rooms').innerHTML = '';
    byId('edl-redac-rooms-title').hidden = true;
    byId('edl-redac-meters').innerHTML = '';
    byId('edl-redac-meters-title').hidden = true;
    byId('edl-redac-cles').innerHTML = '';
    byId('edl-redac-cles-title').hidden = true;
    byId('edl-redac-actions').hidden = true;
    byId('edl-redac-current-label').textContent = '—';
    byId('edl-redac-compare-note').hidden = true;
    renderEdlSignatureBailleur();
    renderEdlSignatureLocataire();
  }

  byId('btn-edl-redac-new').addEventListener('click', () => {
    // Garde-fou : recliquer sur ce bouton pendant une saisie écrasait tout le
    // travail en cours, sans le moindre avertissement — le pire scénario le
    // jour d'un état des lieux, avec le locataire en face.
    if (currentEdlRedaction && !confirm("Un état des lieux est en cours de saisie. En créer un nouveau effacera tout ce que vous venez de saisir. Pour corriger une erreur, annulez : tous les champs restent modifiables directement.")) return;
    const bienId = byId('edl-gabarit-bien').value;
    const locataireId = byId('edl-redac-locataire').value;
    const date = byId('edl-redac-date').value;
    if (!bienId) { alert("Ajoutez d'abord un bien, puis sélectionnez-le."); return; }
    if (!locataireId) { alert("Ce bien n'a pas de locataire enregistré."); return; }
    if (!date) { alert('Renseignez une date.'); return; }
    // La configuration affichée est enregistrée avant de créer la rédaction :
    // sans cela, des compteurs ou des clés saisis au panneau 3 mais pas encore
    // enregistrés étaient ignorés en silence, et l'étape 1 restait vide.
    persistEdlGabarit();
    const gabarit = data.bienGabarits.find((g) => g.bienId === bienId);
    const entrant = currentEdlRedacSens === 'sortant' ? findLatestEntrantRedaction(bienId, locataireId) : null;
    if (!entrant && (!gabarit || gabarit.pieces.length === 0)) {
      alert("Ce bien n'a pas encore de pièces configurées (panneau 2 ci-dessus) — configurez-les d'abord.");
      return;
    }
    const basePieces = entrant ? entrant.pieces : (gabarit ? gabarit.pieces : []);
    const baseCompteurs = entrant ? (entrant.compteurs || []) : (gabarit ? (gabarit.compteurs || []) : []);
    const baseCles = entrant ? (entrant.cles || []) : (gabarit ? (gabarit.cles || []) : []);
    currentEdlRedaction = {
      id: null,
      bienId,
      locataireId,
      sens: currentEdlRedacSens,
      date,
      libelle: byId('edl-redac-libelle').value.trim(),
      entrantRedactionId: entrant ? entrant.id : null,
      pieces: basePieces.map((room) => ({
        id: Storage.uid(),
        nom: room.nom,
        type: room.type,
        elements: room.elements.map((el) => ({
          id: Storage.uid(),
          nom: el.nom,
          vetuste: '',
          note: '',
          files: [],
          vetusteEntree: entrant ? (el.vetuste || '') : undefined,
        })),
      })),
      compteurs: baseCompteurs.map((m) => ({
        id: Storage.uid(),
        nom: m.nom,
        numero: m.numero || '',
        index: '',
        consommation: '',
        files: [],
        indexEntree: entrant ? (m.index === '' || m.index == null ? '' : m.index) : undefined,
      })),
      cles: baseCles.map((c) => ({
        id: Storage.uid(),
        nom: c.nom,
        nombre: '',
        vetuste: '',
        files: [],
        nombreEntree: entrant ? (c.nombre === '' || c.nombre == null ? '' : c.nombre) : undefined,
        vetusteEntree: entrant ? (c.vetuste || '') : undefined,
      })),
      signatureLocataire: '',
      // Champs propres à l'état des lieux de sortie (ignorés pour un entrant).
      nouvelleAdresse: '',
      depotMontant: '',
      depotDate: '',
      conformite: '',
      causes: { degradations: false, vetuste: false, defautsEntree: false, indetermine: false },
    };
    renderEdlRedacRooms();
    renderEdlRedacMeters();
    renderEdlRedacCles();
    updateEdlRedacLabels();
    updateEdlRedacCompareNote(entrant);
    renderEdlSignatureBailleur();
    renderEdlSignatureLocataire();
    renderEdlSortantBloc();
    byId('edl-redac-actions').hidden = false;
    hasUnsavedWork = true;
  });

  // Bloc "sortie du locataire" : visible uniquement pour un état des lieux
  // sortant, et rempli depuis la rédaction en cours.
  function renderEdlSortantBloc() {
    const bloc = byId('edl-sortant-bloc');
    const estSortant = !!currentEdlRedaction && currentEdlRedaction.sens === 'sortant';
    bloc.hidden = !estSortant;
    if (!estSortant) return;
    const r = currentEdlRedaction;
    byId('edl-sortant-adresse').value = r.nouvelleAdresse || '';
    byId('edl-sortant-depot-montant').value = r.depotMontant || '';
    byId('edl-sortant-depot-date').value = r.depotDate || '';
    byId('edl-conf-conforme').checked = r.conformite === 'conforme';
    byId('edl-conf-differences').checked = r.conformite === 'differences';
    const c = r.causes || {};
    byId('edl-cause-degradations').checked = !!c.degradations;
    byId('edl-cause-vetuste').checked = !!c.vetuste;
    byId('edl-cause-entree').checked = !!c.defautsEntree;
    byId('edl-cause-indetermine').checked = !!c.indetermine;
    byId('edl-causes-bloc').hidden = r.conformite !== 'differences';
  }

  function captureEdlSortantBloc() {
    if (!currentEdlRedaction || currentEdlRedaction.sens !== 'sortant') return;
    const r = currentEdlRedaction;
    r.nouvelleAdresse = byId('edl-sortant-adresse').value.trim();
    r.depotMontant = byId('edl-sortant-depot-montant').value;
    r.depotDate = byId('edl-sortant-depot-date').value;
    r.conformite = byId('edl-conf-conforme').checked ? 'conforme'
      : (byId('edl-conf-differences').checked ? 'differences' : '');
    r.causes = {
      degradations: byId('edl-cause-degradations').checked,
      vetuste: byId('edl-cause-vetuste').checked,
      defautsEntree: byId('edl-cause-entree').checked,
      indetermine: byId('edl-cause-indetermine').checked,
    };
  }

  // Les sous-causes ne concernent que le cas "différences constatées".
  document.querySelectorAll('input[name="edl-conformite"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      byId('edl-causes-bloc').hidden = !byId('edl-conf-differences').checked;
      hasUnsavedWork = true;
    });
  });
  ['edl-sortant-adresse', 'edl-sortant-depot-montant', 'edl-sortant-depot-date'].forEach((id) => {
    byId(id).addEventListener('input', () => { hasUnsavedWork = true; });
  });

  function captureCurrentEdlSignatures() {
    if (!currentEdlRedaction) return;
    if (!edlSigCanvas.hidden && edlSigHasStroke) {
      currentEdlRedaction.signatureLocataire = edlSigCanvas.toDataURL('image/png');
    }
    // La signature du bailleur n'est PAS recopiée dans l'état des lieux : elle
    // est reprise depuis "Ma SCI" au moment de générer le PDF (même principe
    // que downloadPdf pour les quittances). La dupliquer ajoutait une image
    // base64 de plusieurs centaines de Ko à CHAQUE état des lieux, ce qui
    // saturait le stockage local du téléphone (plafonné à 5 Mo sur iOS).
    delete currentEdlRedaction.signatureBailleur;
  }

  function buildEdlPdfContext(r) {
    const bien = bienById(r.bienId);
    const loc = locataireById(r.locataireId);
    return {
      sens: r.sens,
      bienNom: bien ? bien.nom : '—',
      bienAdresse: bien ? bien.adresse : '',
      locataireNom: loc ? loc.nom : '—',
      date: r.date,
      dateLabel: r.date ? new Date(`${r.date}T00:00:00`).toLocaleDateString('fr-FR') : '—',
      pieces: r.pieces,
      compteurs: r.compteurs,
      cles: r.cles,
      // Champs propres à l'état des lieux de sortie.
      nouvelleAdresse: r.nouvelleAdresse || '',
      depotMontant: r.depotMontant || '',
      depotDate: r.depotDate || '',
      depotDateLabel: r.depotDate ? new Date(r.depotDate + 'T00:00:00').toLocaleDateString('fr-FR') : '',
      conformite: r.conformite || '',
      causes: r.causes || {},
      // Date de l'état des lieux d'entrée correspondant, rappelée en tête du
      // document de sortie (repère de comparaison pour les deux parties).
      dateEntrantLabel: (function () {
        const e = r.entrantRedactionId
          ? data.edlRedactions.find((x) => x.id === r.entrantRedactionId)
          : findLatestEntrantRedaction(r.bienId, r.locataireId);
        return e && e.date ? new Date(e.date + 'T00:00:00').toLocaleDateString('fr-FR') : '';
      })(),
      // Toujours reprise depuis "Ma SCI", jamais stockée dans la fiche.
      signatureBailleur: data.sci.signature || '',
      signatureLocataire: r.signatureLocataire,
      sciNom: data.sci.nom || '',
      sciAdresse: data.sci.adresse || '',
      sciSiret: data.sci.siret || '',
    };
  }

  async function archiveEdlPdf(r, blob, ctx) {
    const fileId = Storage.uid();
    await FilesDb.saveFile(fileId, blob);
    const fileName = EdlPdf.filename(ctx);
    const defaultLibelle = ctx.sens === 'sortant' ? 'État des lieux de sortie (rédigé)' : "État des lieux d'entrée (rédigé)";
    let entry = r.etatsDesLieuxId ? data.etatsDesLieux.find((e) => e.id === r.etatsDesLieuxId) : null;
    if (entry) {
      for (const f of entry.files) {
        try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
      }
      entry.locataireId = r.locataireId;
      entry.sens = r.sens;
      entry.date = r.date;
      entry.libelle = r.libelle || defaultLibelle;
      entry.files = [{ fileId, fileName }];
    } else {
      entry = {
        id: Storage.uid(),
        locataireId: r.locataireId,
        sens: r.sens,
        date: r.date,
        libelle: r.libelle || defaultLibelle,
        files: [{ fileId, fileName }],
      };
      data.etatsDesLieux.push(entry);
      r.etatsDesLieuxId = entry.id;
    }
    save();
  }

  function persistCurrentEdlRedaction() {
    if (!currentEdlRedaction) return null;
    currentEdlRedaction.libelle = byId('edl-redac-libelle').value.trim();
    captureEdlSortantBloc();
    captureCurrentEdlSignatures();
    const now = Date.now();
    if (currentEdlRedaction.id) {
      const idx = data.edlRedactions.findIndex((r) => r.id === currentEdlRedaction.id);
      currentEdlRedaction.updatedAt = now;
      if (idx !== -1) data.edlRedactions[idx] = currentEdlRedaction;
      else data.edlRedactions.push(currentEdlRedaction);
    } else {
      currentEdlRedaction.id = Storage.uid();
      currentEdlRedaction.createdAt = now;
      currentEdlRedaction.updatedAt = now;
      data.edlRedactions.push(currentEdlRedaction);
    }
    save();
    hasUnsavedWork = false;
    return currentEdlRedaction;
  }

  function canShareFile(file) {
    try {
      return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
    } catch (e) {
      return false;
    }
  }

  function openEdlEmailModal(r, ctx, blob) {
    const loc = locataireById(r.locataireId);
    const prefill = (loc && (loc.email1 || loc.email2)) || '';
    const fileName = EdlPdf.filename(ctx);
    const sensLabel = ctx.sens === 'sortant' ? 'de sortie' : "d'entrée";
    const testFile = new File([blob], fileName, { type: 'application/pdf' });
    const shareOk = canShareFile(testFile);
    openModal('Envoyer par mail', `
      <div class="field">
        <label>Adresse e-mail du destinataire</label>
        <input type="email" id="edl-mail-to" placeholder="locataire@exemple.fr" value="${escapeHTML(prefill)}">
      </div>
      <p class="charges-note">Le PDF a déjà été téléchargé sur cet appareil${shareOk ? '' : " — il faudra le joindre manuellement à l'e-mail"}.</p>
      <div class="preview-actions">
        ${shareOk ? '<button type="button" class="btn btn-primary" id="btn-edl-mail-share">Partager le PDF (pièce jointe automatique)</button>' : ''}
        <button type="button" class="btn" id="btn-edl-mail-open">Ouvrir dans l'app mail</button>
      </div>
    `);
    if (shareOk) {
      byId('btn-edl-mail-share').addEventListener('click', async () => {
        try {
          await navigator.share({
            files: [new File([blob], fileName, { type: 'application/pdf' })],
            title: fileName,
            text: `État des lieux ${sensLabel} — ${ctx.bienNom}`,
          });
          closeModal();
        } catch (e) {
          if (e.name !== 'AbortError') { console.error(e); alert('Le partage a échoué.'); }
        }
      });
    }
    byId('btn-edl-mail-open').addEventListener('click', () => {
      const to = byId('edl-mail-to').value.trim();
      const subject = encodeURIComponent(`État des lieux ${sensLabel} — ${ctx.bienNom}`);
      const body = encodeURIComponent(`Bonjour,\n\nVeuillez trouver ci-joint l'état des lieux ${sensLabel} du logement situé ${ctx.bienAdresse || ''}.\n\nCordialement.`);
      window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
      closeModal();
    });
  }

  async function generateEdlPdf(r, btn) {
    const originalText = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Génération du PDF...'; }
    try {
      const ctx = buildEdlPdfContext(r);
      const doc = await EdlPdf.generate(ctx);
      const blob = doc.output('blob');
      // L'archivage doit précéder le téléchargement : sur iOS, doc.save()
      // ouvre le PDF et fait quitter/suspendre la page, ce qui interrompait le
      // script avant l'archivage. L'état des lieux était alors bien généré en
      // PDF mais n'apparaissait nulle part dans l'application.
      await archiveEdlPdf(r, blob, ctx);
      doc.save(EdlPdf.filename(ctx));
      renderEdlRedacHistory();
      openEdlEmailModal(r, ctx, blob);
    } catch (e) {
      console.error(e);
      alert("Une erreur est survenue lors de la génération du PDF.");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
  }

  byId('btn-edl-redac-pdf').addEventListener('click', (e) => {
    const r = persistCurrentEdlRedaction();
    if (!r) return;
    renderEdlRedacHistory();
    renderEdlSignatureLocataire();
    generateEdlPdf(r, e.currentTarget);
  });

  byId('btn-edl-modeles-toggle').addEventListener('click', () => {
    const panneau = byId('edl-modeles-panel');
    panneau.hidden = !panneau.hidden;
    byId('btn-edl-modeles-toggle').textContent = panneau.hidden
      ? "Gérer les modèles d'état des lieux"
      : "Masquer les modèles d'état des lieux";
  });

  byId('btn-edl-show-config').addEventListener('click', () => {
    byId('view-edl-redaction').classList.add('edl-config-visible');
    byId('edl-config-hint').hidden = true;
  });

  // Clôt la rédaction : enregistre une dernière fois, libère l'écran et
  // ramène au tableau de bord. C'est le geste de fin sur le terrain, une fois
  // le PDF généré, téléchargé et éventuellement envoyé au locataire.
  byId('btn-edl-redac-fin').addEventListener('click', () => {
    const r = persistCurrentEdlRedaction();
    if (!r) { showView('dashboard'); return; }
    // L'archivage dans "Documents locataires" n'a lieu qu'à la génération du
    // PDF : on prévient si l'utilisateur termine sans l'avoir fait.
    const messageSansPdf = [
      "Le PDF de cet état des lieux n'a pas encore été généré : il ne sera donc pas",
      "archivé dans Documents locataires.",
      "",
      "Votre saisie reste enregistrée en brouillon et vous pourrez la reprendre",
      "depuis l'historique (bouton Modifier).",
      "",
      "Terminer quand même ?",
    ].join(String.fromCharCode(10));
    if (!r.etatsDesLieuxId && !confirm(messageSansPdf)) return;
    renderEdlRedacHistory();
    clearCurrentEdlRedaction();
    alert(r.etatsDesLieuxId
      ? "État des lieux terminé et archivé dans Documents locataires."
      : "Brouillon enregistré. Vous pourrez le reprendre depuis l'historique.");
    showView('dashboard');
  });

  byId('btn-edl-redac-save').addEventListener('click', () => {
    if (!persistCurrentEdlRedaction()) return;
    renderEdlRedacHistory();
    renderEdlSignatureLocataire();
    alert('Brouillon enregistré.');
  });

  function renderEdlRedacHistory() {
    const bienId = byId('edl-gabarit-bien').value;
    const bien = bienById(bienId);
    byId('edl-redac-history-label').textContent = bien ? bien.nom : '—';
    const tbody = document.querySelector('#edl-redac-history-table tbody');
    const items = data.edlRedactions
      .filter((r) => r.bienId === bienId)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!bienId || items.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun état des lieux rédigé pour ce bien.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map((r) => {
      const loc = locataireById(r.locataireId);
      const dateLabel = r.date ? new Date(`${r.date}T00:00:00`).toLocaleDateString('fr-FR') : '—';
      const sensLabel = r.sens === 'sortant' ? 'Sortant' : 'Entrant';
      const sensBadge = r.sens === 'sortant' ? 'badge-devis' : 'badge-facture';
      return `<tr>
        <td>${dateLabel}</td>
        <td><span class="badge ${sensBadge}">${sensLabel}</span></td>
        <td>${escapeHTML(r.libelle || (loc ? loc.nom : '—'))}</td>
        <td class="actions-cell">
          <button type="button" class="btn btn-sm" data-pdf-edl-redac="${r.id}">Télécharger le PDF</button>
          <button type="button" class="btn btn-sm" data-edit-edl-redac="${r.id}">Modifier</button>
          <button type="button" class="btn btn-sm btn-danger" data-del-edl-redac="${r.id}">Supprimer</button>
        </td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-pdf-edl-redac]').forEach((btn) => btn.addEventListener('click', (e) => {
      const r = data.edlRedactions.find((x) => x.id === btn.dataset.pdfEdlRedac);
      if (r) generateEdlPdf(r, e.currentTarget);
    }));
    tbody.querySelectorAll('[data-edit-edl-redac]').forEach((btn) => btn.addEventListener('click', () => loadEdlRedaction(btn.dataset.editEdlRedac)));
    tbody.querySelectorAll('[data-del-edl-redac]').forEach((btn) => btn.addEventListener('click', () => deleteEdlRedaction(btn.dataset.delEdlRedac)));
  }

  function loadEdlRedaction(id) {
    const r = data.edlRedactions.find((x) => x.id === id);
    if (!r) return;
    currentEdlRedaction = JSON.parse(JSON.stringify(r));
    byId('edl-redac-locataire').value = r.locataireId;
    byId('edl-redac-date').value = r.date;
    byId('edl-redac-libelle').value = r.libelle || '';
    currentEdlRedacSens = r.sens;
    document.querySelectorAll('#edl-redac-type-toggle .toggle-btn').forEach((b) => b.classList.toggle('active', b.dataset.edlRedacType === r.sens));
    renderEdlRedacRooms();
    renderEdlRedacMeters();
    renderEdlRedacCles();
    updateEdlRedacLabels();
    updateEdlRedacCompareNote(r.entrantRedactionId ? data.edlRedactions.find((x) => x.id === r.entrantRedactionId) : null);
    renderEdlSignatureBailleur();
    renderEdlSignatureLocataire();
    renderEdlSortantBloc();
    byId('edl-redac-actions').hidden = false;
  }

  async function purgeEdlRedactionFiles(r) {
    for (const room of r.pieces) {
      for (const el of room.elements) {
        for (const f of (el.files || [])) {
          try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
        }
      }
    }
    for (const m of (r.compteurs || [])) {
      for (const f of (m.files || [])) {
        try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
      }
    }
    for (const c of (r.cles || [])) {
      for (const f of (c.files || [])) {
        try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
      }
    }
    const archived = r.etatsDesLieuxId ? data.etatsDesLieux.find((e) => e.id === r.etatsDesLieuxId) : null;
    if (archived) {
      for (const f of archived.files) {
        try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
      }
      data.etatsDesLieux = data.etatsDesLieux.filter((e) => e.id !== archived.id);
    }
  }

  async function deleteEdlRedaction(id) {
    const r = data.edlRedactions.find((x) => x.id === id);
    if (!r) return;
    const archived = r.etatsDesLieuxId ? data.etatsDesLieux.find((e) => e.id === r.etatsDesLieuxId) : null;
    const warning = archived
      ? "Supprimer cet état des lieux rédigé, avec toutes ses photos et son PDF archivé dans « États des lieux » ?"
      : 'Supprimer cet état des lieux rédigé, avec toutes ses photos ?';
    if (!confirm(warning)) return;
    await purgeEdlRedactionFiles(r);
    data.edlRedactions = data.edlRedactions.filter((x) => x.id !== id);
    if (currentEdlRedaction && currentEdlRedaction.id === id) clearCurrentEdlRedaction();
    save();
    renderEdlRedacHistory();
    renderEdlStatusGrid();
    renderEdlHistoryTable();
  }

  byId('edl-gabarit-bien').addEventListener('change', () => {
    populateEdlRedacLocataireSelect();
    clearCurrentEdlRedaction();
    renderEdlRedacHistory();
  });

  const EDL_TEST_BIEN_ID = 'edl-test-bien';
  const EDL_TEST_LOC_ID = 'edl-test-locataire';

  function ensureEdlTestData() {
    let bien = data.biens.find((b) => b.id === EDL_TEST_BIEN_ID);
    if (!bien) {
      bien = {
        id: EDL_TEST_BIEN_ID,
        nom: "🧪 TEST — Appartement d'exemple",
        adresse: "12 rue de l'Exemple\n31000 Toulouse",
        loyer: 650,
        charges: 50,
        isTest: true,
      };
      data.biens.push(bien);
    }
    let loc = data.locataires.find((l) => l.id === EDL_TEST_LOC_ID);
    if (!loc) {
      loc = {
        id: EDL_TEST_LOC_ID,
        nom: '🧪 TEST — Jean Dupont',
        bienId: EDL_TEST_BIEN_ID,
        designation: '',
        adresseDestinataire: '',
        loyer: 650,
        charges: 50,
        dateEntree: todayISO(),
        lieuNaissance: '',
        dateNaissance: '',
        email1: 'test.locataire@exemple.fr',
        email2: '',
        tel1: '',
        tel2: '',
        actif: true,
        isTest: true,
      };
      data.locataires.push(loc);
    }
    let gabarit = data.bienGabarits.find((g) => g.bienId === EDL_TEST_BIEN_ID);
    if (!gabarit) {
      gabarit = {
        id: Storage.uid(),
        bienId: EDL_TEST_BIEN_ID,
        pieces: [
          { id: Storage.uid(), nom: 'Salon', type: 'salon', elements: EDL_ROOM_TYPES.salon.elements.map((nom) => ({ id: Storage.uid(), nom })) },
          { id: Storage.uid(), nom: 'Chambre 1', type: 'chambre', elements: EDL_ROOM_TYPES.chambre.elements.map((nom) => ({ id: Storage.uid(), nom })) },
        ],
        compteurs: EDL_METER_DEFAULTS.map((nom) => ({ id: Storage.uid(), nom })),
        cles: EDL_CLES_DEFAULTS.map((nom) => ({ id: Storage.uid(), nom })),
      };
      data.bienGabarits.push(gabarit);
    }
    save();
  }

  async function cleanupEdlTestData() {
    if (!confirm("Supprimer le bien, le locataire et tous les états des lieux de test créés pour l'entraînement ?")) return;
    const testRedactions = data.edlRedactions.filter((r) => r.bienId === EDL_TEST_BIEN_ID);
    for (const r of testRedactions) {
      for (const room of r.pieces) {
        for (const el of room.elements) {
          for (const f of (el.files || [])) {
            try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
          }
        }
      }
      for (const m of (r.compteurs || [])) {
        for (const f of (m.files || [])) {
          try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
        }
      }
      for (const c of (r.cles || [])) {
        for (const f of (c.files || [])) {
          try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
        }
      }
      if (r.etatsDesLieuxId) {
        const archived = data.etatsDesLieux.find((e) => e.id === r.etatsDesLieuxId);
        if (archived) {
          for (const f of archived.files) {
            try { await FilesDb.deleteFile(f.fileId); } catch (e) { console.error(e); }
          }
          data.etatsDesLieux = data.etatsDesLieux.filter((e) => e.id !== archived.id);
        }
      }
    }
    data.edlRedactions = data.edlRedactions.filter((r) => r.bienId !== EDL_TEST_BIEN_ID);
    data.bienGabarits = data.bienGabarits.filter((g) => g.bienId !== EDL_TEST_BIEN_ID);
    data.locataires = data.locataires.filter((l) => l.id !== EDL_TEST_LOC_ID);
    data.biens = data.biens.filter((b) => b.id !== EDL_TEST_BIEN_ID);
    if (currentEdlRedaction && currentEdlRedaction.bienId === EDL_TEST_BIEN_ID) clearCurrentEdlRedaction();
    save();
    renderEdlRedactionView();
  }

  function updateEdlTestButtonVisibility() {
    byId('btn-edl-test-clean').hidden = !data.biens.some((b) => b.id === EDL_TEST_BIEN_ID);
  }

  byId('btn-edl-test').addEventListener('click', () => {
    ensureEdlTestData();
    populateEdlGabaritBienSelect();
    byId('edl-gabarit-bien').value = EDL_TEST_BIEN_ID;
    byId('edl-gabarit-bien').dispatchEvent(new Event('change'));
    updateEdlTestButtonVisibility();
    alert('Un bien et un locataire "TEST" ont été créés, avec des pièces et compteurs déjà configurés (panneaux 2 et 3). Vous pouvez maintenant refaire tout le parcours ci-dessous comme pour un vrai dossier (panneaux 4 à 6, y compris photos, signature et PDF). Cliquez sur "Supprimer les données de test" une fois terminé.');
  });

  byId('btn-edl-test-clean').addEventListener('click', cleanupEdlTestData);

  function renderEdlRedactionView() {
    // ATTENTION : cette fonction est rappelée à chaque affichage de la vue, y
    // compris lors d'un rafraîchissement déclenché par la synchronisation
    // cloud. Elle ne doit JAMAIS effacer une rédaction en cours : sur le
    // terrain, cela faisait disparaître l'état des lieux une seconde après sa
    // création, sans rien enregistrer.
    populateEdlGabaritBienSelect();
    renderEdlGabaritRooms();
    renderEdlGabaritMeters();
    renderEdlGabaritCles();
    populateEdlModeleSelect();
    populateEdlApplyModeleSelect();
    loadEdlModeleIntoEditor(byId('edl-modele-select').value);
    populateEdlRedacLocataireSelect();

    if (currentEdlRedaction) {
      // Saisie en cours : on se contente de la réafficher telle quelle.
      renderEdlRedacRooms();
      renderEdlRedacMeters();
      renderEdlRedacCles();
      renderEdlSignatureBailleur();
      renderEdlSignatureLocataire();
      renderEdlSortantBloc();
    } else {
      byId('edl-redac-date').value = todayISO();
      byId('edl-redac-libelle').value = '';
      currentEdlRedacSens = 'entrant';
      document.querySelectorAll('#edl-redac-type-toggle .toggle-btn').forEach((b) => b.classList.toggle('active', b.dataset.edlRedacType === 'entrant'));
      clearCurrentEdlRedaction();
    }
    renderEdlRedacHistory();
    updateEdlTestButtonVisibility();
  }

  // ---------- Modal helpers ----------
  const modalOverlay = byId('modal-overlay');
  function openModal(title, bodyHTML) {
    byId('modal-title').textContent = title;
    byId('modal-body').innerHTML = bodyHTML;
    modalOverlay.hidden = false;
  }
  function closeModal() { modalOverlay.hidden = true; }
  byId('modal-close').addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

  // ---------- Publication et gestion annonce ----------

  // Bien et rédaction affichés. Conservés hors de `data` : c'est un état
  // d'écran, il n'a pas à être synchronisé ni sauvegardé.
  let annonceBienId = '';
  let annonceRedactionId = '';
  let annonceSaveTimer = null;

  const CLASSES_DPE = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

  // Caractéristiques permanentes : elles vivent sur le BIEN, pas sur la
  // rédaction, parce qu'elles ne changent pas d'une annonce à l'autre. La
  // saisie a lieu ici pour éviter un aller-retour vers la fiche du bien.
  const CHAMPS_BIEN = [
    { cle: 'typeBien', label: 'Type de bien', type: 'select', options: ['Maison', 'Appartement'] },
    { cle: 'surfaceHabitable', label: 'Surface habitable (m²)', type: 'number', step: '0.01', aide: 'Valeur exacte du mesurage, sans « environ »' },
    { cle: 'nbPieces', label: 'Nombre de pièces', type: 'number' },
    { cle: 'nbChambres', label: 'Dont chambres', type: 'number' },
    { cle: 'anneeConstruction', label: 'Année de construction', type: 'number' },
    { cle: 'normeConstruction', label: 'Norme de construction', type: 'text', aide: 'Ex : RT 2012' },
    { cle: 'dpeClasse', label: 'Classe DPE', type: 'select', options: CLASSES_DPE },
    { cle: 'gesClasse', label: 'Classe GES', type: 'select', options: CLASSES_DPE },
    { cle: 'dpeConsommation', label: 'Consommation (kWh/m²/an)', type: 'number' },
    { cle: 'dpeDateRealisation', label: 'Date du diagnostic', type: 'month' },
    { cle: 'energieCoutMin', label: 'Dépenses énergie, mini (€/an)', type: 'number' },
    { cle: 'energieCoutMax', label: 'Dépenses énergie, maxi (€/an)', type: 'number' },
    { cle: 'energieAnneeReference', label: 'Année de référence des prix', type: 'number', aide: 'Figure sur le DPE. Ce n\'est pas la date du diagnostic.' },
    { cle: 'chauffageType', label: 'Chauffage', type: 'text', aide: 'Ex : chaudière gaz à condensation' },
    { cle: 'eauChaudeType', label: 'Eau chaude sanitaire', type: 'text' },
    { cle: 'climatisation', label: 'Climatisation', type: 'text', aide: 'Ex : réversible au rez-de-chaussée et à l\'étage' },
    { cle: 'stationnement', label: 'Stationnement', type: 'text' },
    { cle: 'exterieurs', label: 'Extérieurs', type: 'text' },
    { cle: 'annexes', label: 'Annexes', type: 'text' },
  ];

  const CHAMPS_REDACTION = [
    { cle: 'loyer', label: 'Loyer mensuel hors charges (€)', type: 'number', step: '0.01' },
    { cle: 'charges', label: 'Provision sur charges (€)', type: 'number', step: '0.01' },
    { cle: 'depotGarantie', label: 'Dépôt de garantie (€)', type: 'number', step: '0.01' },
    { cle: 'honoraires', label: 'Honoraires locataire TTC (€)', type: 'number', step: '0.01', aide: 'Laisser à 0 en location directe' },
    { cle: 'disponibleLe', label: 'Disponible à compter du', type: 'date' },
    { cle: 'chargesResteACharge', label: 'Reste à la charge du locataire', type: 'text', aide: 'Ex : La taxe d\'enlèvement des ordures ménagères' },
  ];

  const CHAMPS_REGLAGES = [
    { cle: 'critereContrat', label: 'Contrat exigé', type: 'text', aide: 'Ex : CDI' },
    // Libellé explicite : « Revenus exigés (× le loyer) » a été compris comme
    // le montant, et une saisie de 2265 a produit « 2265 fois le loyer ».
    { cle: 'ratioRevenus', label: 'Revenus exigés : combien de fois le loyer ?', type: 'number', aide: 'Saisir 3, pas un montant. Le montant en euros est calculé tout seul.' },
    { cle: 'modalitesVisite', label: 'Modalités de visite', type: 'text' },
    { cle: 'canalContact', label: 'Prise de contact', type: 'text' },
  ];

  function reglagesAnnonce() {
    if (!data.reglagesAnnonce) data.reglagesAnnonce = Storage.mergeWithDefaults({}).reglagesAnnonce;
    return data.reglagesAnnonce;
  }

  function redactionsDuBien(bienId) {
    return data.annonceRedactions.filter((r) => r.bienId === bienId);
  }

  function redactionCourante() {
    return data.annonceRedactions.find((r) => r.id === annonceRedactionId) || null;
  }

  // Les écritures IndexedDB sont différées : sauvegarder à chaque frappe
  // saturerait la file d'écriture de storage.js pour rien.
  function planifierSauvegardeAnnonce() {
    if (annonceSaveTimer) clearTimeout(annonceSaveTimer);
    annonceSaveTimer = setTimeout(() => { annonceSaveTimer = null; save(); }, 800);
  }

  function champHTML(attribut, champ, valeur) {
    const val = valeur == null ? '' : String(valeur);
    const aide = champ.aide ? `<small class="annonce-aide">${escapeHTML(champ.aide)}</small>` : '';
    let controle;
    if (champ.type === 'select') {
      const options = ['<option value=""></option>'].concat(
        champ.options.map((o) => `<option value="${escapeHTML(o)}"${o === val ? ' selected' : ''}>${escapeHTML(o)}</option>`)
      ).join('');
      controle = `<select ${attribut}="${champ.cle}">${options}</select>`;
    } else {
      const step = champ.step ? ` step="${champ.step}"` : '';
      controle = `<input type="${champ.type}"${step} ${attribut}="${champ.cle}" value="${escapeHTML(val)}">`;
    }
    return `<div class="field"><label>${escapeHTML(champ.label)}</label>${controle}${aide}</div>`;
  }

  function champsHTML(attribut, champs, source) {
    return champs.map((c) => champHTML(attribut, c, source ? source[c.cle] : '')).join('');
  }

  // `forcer` est vrai quand la reconstruction est demandée par une action de
  // l'écran (créer, dupliquer, supprimer, changer de bien). Sans argument,
  // l'appel vient de showView — donc éventuellement d'un retour de
  // synchronisation Firestore, qu'il ne faut pas laisser interrompre une saisie.
  function renderAnnonces(forcer) {
    const conteneur = byId('annonces-contenu');
    if (!conteneur) return;

    // La synchronisation rappelle refreshCurrentView() à chaque enregistrement.
    // Sans ce garde-fou, chaque caractère tapé déclenchait une sauvegarde, qui
    // revenait du cloud, qui reconstruisait le DOM : on ne pouvait saisir
    // qu'une lettre à la fois.
    //
    // Il ne vise QUE les champs de saisie : un clic donne le focus au bouton
    // cliqué, et un garde-fou étendu à tout le conteneur rendait « Nouvelle
    // rédaction » et ses voisins inertes.
    const actif = document.activeElement;
    const enSaisie = !forcer && actif && conteneur.contains(actif)
      && (actif.tagName === 'TEXTAREA'
        || (actif.tagName === 'INPUT' && actif.type !== 'file' && actif.type !== 'button'));
    if (enSaisie) {
      majResultatAnnonce();
      return;
    }

    if (data.biens.length === 0) {
      conteneur.innerHTML = '<div class="panel"><p>Aucun bien enregistré. Créez d\'abord un bien dans « Biens ».</p></div>';
      return;
    }

    // Le bien mémorisé peut avoir été supprimé depuis le dernier affichage.
    if (!bienById(annonceBienId)) annonceBienId = data.biens[0].id;
    const bien = bienById(annonceBienId);

    const redactions = redactionsDuBien(annonceBienId);
    if (!redactions.some((r) => r.id === annonceRedactionId)) {
      annonceRedactionId = redactions.length ? redactions[0].id : '';
    }
    const redaction = redactionCourante();

    const optionsBiens = data.biens
      .map((b) => `<option value="${escapeHTML(b.id)}"${b.id === annonceBienId ? ' selected' : ''}>${escapeHTML(b.nom)}</option>`)
      .join('');

    const optionsRedactions = redactions.length
      ? redactions.map((r) => {
        const libelle = (r.titre && r.titre.trim()) || 'Sans titre';
        const date = r.updatedAt ? ' — ' + r.updatedAt.slice(0, 10) : '';
        return `<option value="${escapeHTML(r.id)}"${r.id === annonceRedactionId ? ' selected' : ''}>${escapeHTML(libelle + date)}</option>`;
      }).join('')
      : '<option value="">Aucune rédaction</option>';

    conteneur.innerHTML = `
      <div class="panel">
        <h2>Bien et rédaction</h2>
        <div class="grid-2">
          <div class="field"><label>Bien</label><select id="annonce-bien">${optionsBiens}</select></div>
          <div class="field"><label>Rédaction</label><select id="annonce-redaction"${redactions.length ? '' : ' disabled'}>${optionsRedactions}</select></div>
        </div>
        <div class="annonce-actions">
          <button class="btn btn-primary btn-sm" id="annonce-nouvelle">Nouvelle rédaction</button>
          <button class="btn btn-sm" id="annonce-dupliquer"${redaction ? '' : ' disabled'}>Dupliquer</button>
          <button class="btn btn-sm btn-danger" id="annonce-supprimer"${redaction ? '' : ' disabled'}>Supprimer</button>
        </div>
      </div>

      ${redaction ? `
      <details class="panel annonce-repliable"${bien.surfaceHabitable ? '' : ' open'}>
        <summary><h2>Caractéristiques du bien</h2><span class="annonce-summary-note">Saisies une fois, réutilisées à chaque annonce</span></summary>
        <div class="charges-form-grid">${champsHTML('data-bien-champ', CHAMPS_BIEN, bien)}</div>
      </details>

      <div class="panel">
        <h2>Rédaction</h2>
        <div class="field"><label>Titre de l'annonce</label><input type="text" data-red-champ="titre" value="${escapeHTML(redaction.titre || '')}"></div>
        <div class="field">
          <label>Descriptif</label>
          <textarea id="annonce-texte" rows="16" data-red-champ="texteLibre">${escapeHTML(redaction.texteLibre || '')}</textarea>
          <small class="annonce-aide">Ce texte est repris tel quel dans l'annonce. Les blocs légaux sont ajoutés automatiquement en dessous : inutile d'y répéter loyer, charges, DPE, caution, critères ou visites.</small>
          <button class="btn btn-sm" id="annonce-inserer-pieces">Insérer la liste des pièces</button>
        </div>
        <div class="charges-form-grid">${champsHTML('data-red-champ', CHAMPS_REDACTION, redaction)}</div>
        <div class="field">
          <label>Ce que couvrent les charges</label>
          <textarea rows="4" data-red-champ="chargesDetail">${escapeHTML((redaction.chargesDetail || []).join('\n'))}</textarea>
          <small class="annonce-aide">Une ligne par élément. Ex : l'entretien annuel de la chaudière</small>
        </div>
      </div>

      <div class="panel">
        <h2>Photos</h2>
        <p class="annonce-aide">La première photo devient la vignette de l'annonce. Les images sont réduites avant enregistrement : une photo de téléphone passe de plusieurs Mo à quelques centaines de Ko, sans différence visible en ligne.</p>
        <div id="annonce-photos" class="annonce-photos"></div>
        <div class="annonce-actions">
          <label class="btn btn-sm annonce-photo-add">
            Ajouter des photos
            <input type="file" id="annonce-photo-input" accept="image/*" multiple hidden>
          </label>
          <button class="btn btn-sm" id="annonce-exporter-photos">Exporter les photos (.zip)</button>
          <span id="annonce-photo-retour" class="annonce-copie-retour"></span>
        </div>
      </div>

      <details class="panel annonce-repliable">
        <summary><h2>Critères de candidature</h2><span class="annonce-summary-note">Communs à toutes vos annonces</span></summary>
        <div class="charges-form-grid">${champsHTML('data-reg-champ', CHAMPS_REGLAGES, reglagesAnnonce())}</div>
      </details>

      <div class="panel">
        <h2>Annonce à publier</h2>
        <div id="annonce-avertissements"></div>
        <textarea id="annonce-resultat" rows="22" readonly></textarea>
        <div class="annonce-actions">
          <button class="btn btn-primary" id="annonce-copier">Copier l'annonce</button>
          <span id="annonce-copie-retour" class="annonce-copie-retour"></span>
        </div>
      </div>
      ` : '<div class="panel"><p>Aucune rédaction pour ce bien. Cliquez sur « Nouvelle rédaction » pour commencer.</p></div>'}
    `;

    brancherEcouteursAnnonce();
    if (redaction) {
      majResultatAnnonce();
      afficherVignettesAnnonce();
    }
  }

  // Taille au-delà de laquelle on refuse le fichier : au-dessus, ce n'est
  // probablement pas une photo mais une vidéo ou un TIFF, et le
  // redimensionnement échouerait après avoir bloqué le navigateur.
  const ANNONCE_PHOTO_MAX_OCTETS = 15 * 1024 * 1024;

  // Les URL d'objet des vignettes affichées, à révoquer avant chaque nouveau
  // rendu : sans cela chaque affichage fuit un blob en mémoire.
  let annoncePhotoUrls = [];

  function libererVignettesAnnonce() {
    annoncePhotoUrls.forEach((u) => URL.revokeObjectURL(u));
    annoncePhotoUrls = [];
  }

  async function afficherVignettesAnnonce() {
    const conteneur = byId('annonce-photos');
    const redaction = redactionCourante();
    if (!conteneur || !redaction) return;

    libererVignettesAnnonce();
    conteneur.innerHTML = '';

    const photos = redaction.photos || [];
    if (photos.length === 0) {
      conteneur.innerHTML = '<p class="annonce-aide">Aucune photo pour l\'instant.</p>';
      return;
    }

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const vignette = document.createElement('div');
      vignette.className = 'annonce-photo';

      const blob = await FilesDb.getFile(photo.fileId);
      if (blob) {
        const url = URL.createObjectURL(blob);
        annoncePhotoUrls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Photo ' + (i + 1);
        vignette.appendChild(img);
      } else {
        // La photo n'est ni en local ni dans le cloud : on le dit sans casser
        // l'écran, la rédaction reste utilisable.
        const absente = document.createElement('div');
        absente.className = 'annonce-photo-absente';
        absente.textContent = 'Photo introuvable';
        vignette.appendChild(absente);
      }

      const barre = document.createElement('div');
      barre.className = 'annonce-photo-barre';
      barre.innerHTML = `
        <span class="annonce-photo-rang">${i + 1}${i === 0 ? ' — vignette' : ''}</span>
        <button type="button" class="btn btn-sm" data-photo-monter="${i}"${i === 0 ? ' disabled' : ''} title="Monter">↑</button>
        <button type="button" class="btn btn-sm" data-photo-descendre="${i}"${i === photos.length - 1 ? ' disabled' : ''} title="Descendre">↓</button>
        <button type="button" class="btn btn-sm btn-danger" data-photo-supprimer="${i}" title="Supprimer">×</button>`;
      vignette.appendChild(barre);
      conteneur.appendChild(vignette);
    }

    conteneur.querySelectorAll('[data-photo-monter]').forEach((b) => {
      b.addEventListener('click', () => deplacerPhotoAnnonce(Number(b.dataset.photoMonter), -1));
    });
    conteneur.querySelectorAll('[data-photo-descendre]').forEach((b) => {
      b.addEventListener('click', () => deplacerPhotoAnnonce(Number(b.dataset.photoDescendre), 1));
    });
    conteneur.querySelectorAll('[data-photo-supprimer]').forEach((b) => {
      b.addEventListener('click', () => supprimerPhotoAnnonce(Number(b.dataset.photoSupprimer)));
    });
  }

  // L'ordre du tableau fait foi ; le champ `ordre` n'est qu'un miroir, tenu à
  // jour à chaque modification pour qu'une lecture externe (export, autre
  // appareil) n'ait pas à le déduire.
  function renumeroterPhotosAnnonce(redaction) {
    (redaction.photos || []).forEach((p, i) => { p.ordre = i; });
  }

  async function ajouterPhotosAnnonce(fichiers) {
    const redaction = redactionCourante();
    if (!redaction || fichiers.length === 0) return;

    const retour = byId('annonce-photo-retour');
    const refuses = [];
    let ajoutees = 0;

    for (const fichier of fichiers) {
      if (!fichier.type || !fichier.type.startsWith('image/')) {
        refuses.push(fichier.name + ' (pas une image)');
        continue;
      }
      if (fichier.size > ANNONCE_PHOTO_MAX_OCTETS) {
        refuses.push(fichier.name + ' (plus de 15 Mo)');
        continue;
      }
      // Même réduction que pour les photos d'état des lieux.
      const reduit = await resizeImageFile(fichier, 1920, 0.85);
      const fileId = Storage.uid();
      try {
        await FilesDb.saveFile(fileId, reduit);
        if (!redaction.photos) redaction.photos = [];
        redaction.photos.push({ fileId: fileId, ordre: redaction.photos.length });
        ajoutees++;
      } catch (e) {
        console.error(e);
        refuses.push(fichier.name + ' (enregistrement impossible)');
      }
    }

    if (ajoutees) {
      renumeroterPhotosAnnonce(redaction);
      redaction.updatedAt = new Date().toISOString();
      save();
      await afficherVignettesAnnonce();
    }

    retour.textContent = refuses.length
      ? `${ajoutees} ajoutée(s). Refusé : ${refuses.join(', ')}`
      : `${ajoutees} photo(s) ajoutée(s).`;
    retour.className = 'annonce-copie-retour ' + (refuses.length ? 'annonce-copie-ko' : 'annonce-copie-ok');
  }

  function deplacerPhotoAnnonce(index, sens) {
    const redaction = redactionCourante();
    if (!redaction) return;
    const photos = redaction.photos;
    const cible = index + sens;
    if (cible < 0 || cible >= photos.length) return;
    const tmp = photos[index];
    photos[index] = photos[cible];
    photos[cible] = tmp;
    renumeroterPhotosAnnonce(redaction);
    redaction.updatedAt = new Date().toISOString();
    save();
    afficherVignettesAnnonce();
  }

  async function supprimerPhotoAnnonce(index) {
    const redaction = redactionCourante();
    if (!redaction) return;
    const photo = redaction.photos[index];
    if (!photo) return;
    if (!confirm('Supprimer cette photo ?')) return;
    redaction.photos.splice(index, 1);
    renumeroterPhotosAnnonce(redaction);
    redaction.updatedAt = new Date().toISOString();
    save();
    await afficherVignettesAnnonce();
    try { await FilesDb.deleteFile(photo.fileId); } catch (e) { console.error(e); }
  }

  async function exporterPhotosAnnonce() {
    const redaction = redactionCourante();
    const btn = byId('annonce-exporter-photos');
    const retour = byId('annonce-photo-retour');
    if (!redaction || !(redaction.photos || []).length) {
      retour.textContent = 'Aucune photo à exporter.';
      retour.className = 'annonce-copie-retour annonce-copie-ko';
      return;
    }

    const texteInitial = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Préparation…';
    try {
      const zip = new JSZip();
      let manquantes = 0;
      for (let i = 0; i < redaction.photos.length; i++) {
        const blob = await FilesDb.getFile(redaction.photos[i].fileId);
        if (!blob) { manquantes++; continue; }
        zip.file(QfAnnonce.nomFichierPhoto(i, blob.type), blob);
      }
      const archive = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(archive);
      const a = document.createElement('a');
      a.href = url;
      a.download = QfAnnonce.nomArchivePhotos(redaction.titre);
      a.click();
      URL.revokeObjectURL(url);

      retour.textContent = manquantes
        ? `Archive créée, mais ${manquantes} photo(s) introuvable(s).`
        : 'Archive téléchargée. Extrayez-la, puis sélectionnez toutes les photos sur le formulaire de dépôt.';
      retour.className = 'annonce-copie-retour ' + (manquantes ? 'annonce-copie-ko' : 'annonce-copie-ok');
    } catch (e) {
      console.error(e);
      retour.textContent = 'La création de l\'archive a échoué.';
      retour.className = 'annonce-copie-retour annonce-copie-ko';
    } finally {
      btn.disabled = false;
      btn.textContent = texteInitial;
    }
  }

  function brancherEcouteursAnnonce() {
    const conteneur = byId('annonces-contenu');

    byId('annonce-bien').addEventListener('change', (e) => {
      annonceBienId = e.target.value;
      annonceRedactionId = '';
      renderAnnonces(true);
    });

    const selRedaction = byId('annonce-redaction');
    if (selRedaction) selRedaction.addEventListener('change', (e) => {
      annonceRedactionId = e.target.value;
      renderAnnonces(true);
    });

    byId('annonce-nouvelle').addEventListener('click', creerRedactionAnnonce);
    const btnDup = byId('annonce-dupliquer');
    if (btnDup) btnDup.addEventListener('click', dupliquerRedactionAnnonce);
    const btnSup = byId('annonce-supprimer');
    if (btnSup) btnSup.addEventListener('click', supprimerRedactionAnnonce);

    const btnPieces = byId('annonce-inserer-pieces');
    if (btnPieces) btnPieces.addEventListener('click', insererPiecesDansAnnonce);

    const btnCopier = byId('annonce-copier');
    if (btnCopier) btnCopier.addEventListener('click', copierAnnonce);

    const inputPhotos = byId('annonce-photo-input');
    if (inputPhotos) inputPhotos.addEventListener('change', async (e) => {
      const fichiers = Array.from(e.target.files || []);
      e.target.value = ''; // permet de re-sélectionner le même fichier
      await ajouterPhotosAnnonce(fichiers);
    });

    const btnExport = byId('annonce-exporter-photos');
    if (btnExport) btnExport.addEventListener('click', exporterPhotosAnnonce);

    // Délégation : un seul écouteur, et surtout AUCUN nouveau rendu à la
    // frappe — seul le bloc résultat est recalculé, sinon le champ en cours
    // de saisie perdrait le focus à chaque caractère.
    conteneur.addEventListener('input', (e) => {
      if (appliquerSaisieAnnonce(e.target)) {
        planifierSauvegardeAnnonce();
        majResultatAnnonce();
      }
    });
    conteneur.addEventListener('change', (e) => {
      if (e.target.tagName === 'SELECT' && appliquerSaisieAnnonce(e.target)) {
        planifierSauvegardeAnnonce();
        majResultatAnnonce();
      }
    });
  }

  // Écrit la valeur saisie dans le bon objet. Renvoie true si quelque chose a
  // changé (donc s'il faut sauvegarder et recalculer).
  function appliquerSaisieAnnonce(cible) {
    const valeur = cible.value;

    const champBien = cible.dataset.bienChamp;
    if (champBien) {
      const bien = bienById(annonceBienId);
      if (!bien) return false;
      bien[champBien] = cible.type === 'number' ? (valeur === '' ? null : Number(valeur)) : valeur;
      return true;
    }

    const champRed = cible.dataset.redChamp;
    if (champRed) {
      const redaction = redactionCourante();
      if (!redaction) return false;
      if (champRed === 'chargesDetail') {
        // Les puces éventuellement collées depuis un ancien texte sont
        // retirées : la liste est réassemblée en phrase (« couvrant a, b et
        // c »), un tiret en tête s'y retrouverait au milieu de la phrase.
        redaction.chargesDetail = valeur.split('\n')
          .map((s) => s.replace(/^\s*[-–—•*]\s*/, '').trim())
          .filter(Boolean);
      } else if (cible.type === 'number') {
        redaction[champRed] = valeur === '' ? null : Number(valeur);
      } else {
        redaction[champRed] = valeur;
      }
      redaction.updatedAt = new Date().toISOString();
      return true;
    }

    const champReg = cible.dataset.regChamp;
    if (champReg) {
      const reglages = reglagesAnnonce();
      reglages[champReg] = cible.type === 'number' ? (valeur === '' ? null : Number(valeur)) : valeur;
      return true;
    }

    return false;
  }

  function majResultatAnnonce() {
    const redaction = redactionCourante();
    const bien = bienById(annonceBienId);
    if (!redaction || !bien) return;

    const res = QfAnnonce.construireAnnonce(bien, redaction, reglagesAnnonce());
    byId('annonce-resultat').value = res.texte;

    const bloquants = res.avertissements.filter((a) => a.gravite === 'bloquant');
    const attentions = res.avertissements.filter((a) => a.gravite === 'attention');

    const ligne = (a) => `<li>${escapeHTML(a.message)}</li>`;
    let html = '';
    if (bloquants.length) {
      html += `<div class="annonce-alerte annonce-alerte-bloquant"><strong>${bloquants.length} mention${bloquants.length > 1 ? 's' : ''} obligatoire${bloquants.length > 1 ? 's' : ''} manquante${bloquants.length > 1 ? 's' : ''}</strong><ul>${bloquants.map(ligne).join('')}</ul></div>`;
    }
    if (attentions.length) {
      html += `<div class="annonce-alerte annonce-alerte-attention"><strong>À vérifier</strong><ul>${attentions.map(ligne).join('')}</ul></div>`;
    }
    if (!html) html = '<div class="annonce-alerte annonce-alerte-ok">Annonce complète : toutes les mentions obligatoires sont présentes.</div>';
    byId('annonce-avertissements').innerHTML = html;

    // Le bouton reste actif malgré les bloquants : la décision de publier
    // appartient à l'utilisateur, l'outil signale mais n'interdit pas.
    byId('annonce-copier').textContent = bloquants.length
      ? `Copier l'annonce (${bloquants.length} manque${bloquants.length > 1 ? 's' : ''})`
      : 'Copier l\'annonce';
  }

  function creerRedactionAnnonce() {
    const bien = bienById(annonceBienId);
    if (!bien) return;
    const maintenant = new Date().toISOString();
    const redaction = {
      id: Storage.uid(),
      bienId: annonceBienId,
      titre: 'À louer ' + (bien.nom || ''),
      texteLibre: '',
      loyer: bien.loyer || null,
      charges: bien.charges != null ? bien.charges : null,
      chargesDetail: [],
      chargesResteACharge: '',
      depotGarantie: bien.loyer || null,
      disponibleLe: '',
      honoraires: 0,
      photos: [],
      statut: 'brouillon',
      createdAt: maintenant,
      updatedAt: maintenant,
    };
    data.annonceRedactions.push(redaction);
    annonceRedactionId = redaction.id;
    save();
    renderAnnonces(true);
  }

  function dupliquerRedactionAnnonce() {
    const source = redactionCourante();
    if (!source) return;
    const maintenant = new Date().toISOString();
    const copie = Object.assign({}, source, {
      id: Storage.uid(),
      titre: (source.titre || '') + ' (copie)',
      // Les photos sont partagées avec l'originale : elles vivent dans
      // FilesDb, on ne duplique que les références.
      photos: (source.photos || []).map((p) => Object.assign({}, p)),
      chargesDetail: (source.chargesDetail || []).slice(),
      statut: 'brouillon',
      createdAt: maintenant,
      updatedAt: maintenant,
    });
    data.annonceRedactions.push(copie);
    annonceRedactionId = copie.id;
    save();
    renderAnnonces(true);
  }

  function supprimerRedactionAnnonce() {
    const redaction = redactionCourante();
    if (!redaction) return;
    if (!confirm('Supprimer cette rédaction ?\n\nLe texte sera perdu. Les photos restent enregistrées.')) return;
    data.annonceRedactions = data.annonceRedactions.filter((r) => r.id !== redaction.id);
    annonceRedactionId = '';
    save();
    renderAnnonces(true);
  }

  // Les gabarits d'état des lieux portent déjà les pièces de chaque bien.
  // Ils n'en portent PAS les surfaces : on insère les noms, l'utilisateur
  // complète les m² à la main.
  function insererPiecesDansAnnonce() {
    const gabarit = data.bienGabarits.find((g) => g.bienId === annonceBienId);
    if (!gabarit || !gabarit.pieces || gabarit.pieces.length === 0) {
      alert('Aucune pièce enregistrée pour ce bien (elles proviennent du gabarit d\'état des lieux).');
      return;
    }
    const zone = byId('annonce-texte');
    const liste = gabarit.pieces.map((p) => '- ' + p.nom + ' : ').join('\n');
    // Ligne vide avant la liste pour la détacher du paragraphe précédent, et
    // aucun saut après : les blocs générés apportent déjà leur séparation, un
    // saut de plus produirait une ligne vide isolée dans l'annonce publiée.
    const separation = zone.value.trim() ? '\n\n' : '';
    zone.value = zone.value.replace(/\s+$/, '') + separation + liste;
    zone.dispatchEvent(new Event('input', { bubbles: true }));
    zone.focus();
  }

  // Copie partagée par l'annonce et le mail de refus. Le presse-papier moderne
  // exige un contexte sécurisé et n'est pas disponible partout : on retombe
  // sur la méthode historique.
  async function copierTexte(texte) {
    try {
      await navigator.clipboard.writeText(texte);
      return true;
    } catch (e) {
      try {
        const tmp = document.createElement('textarea');
        tmp.value = texte;
        tmp.style.position = 'fixed';
        tmp.style.opacity = '0';
        document.body.appendChild(tmp);
        tmp.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(tmp);
        return ok;
      } catch (e2) {
        console.error('Copie impossible', e2);
        return false;
      }
    }
  }

  async function copierAnnonce() {
    const retour = byId('annonce-copie-retour');
    const ok = await copierTexte(byId('annonce-resultat').value);
    retour.textContent = ok ? 'Annonce copiée.' : 'Copie impossible : sélectionnez le texte et copiez-le à la main.';
    retour.className = 'annonce-copie-retour ' + (ok ? 'annonce-copie-ok' : 'annonce-copie-ko');
    setTimeout(() => { retour.textContent = ''; }, 4000);
  }

  // ---------- Candidatures ----------

  let candidatureBienId = '';
  let candidatureCouranteId = '';
  let candidatureTri = 'date';
  let candidatureSaveTimer = null;

  const STATUTS_CANDIDATURE = {
    'recue': 'Reçue',
    'dossier-recu': 'Dossier reçu',
    'retenue': 'Retenue',
    'refusee': 'Refusée',
  };

  const TYPES_PIECE = {
    'identite': 'Pièce d\'identité',
    'bulletins-salaire': 'Bulletins de salaire',
    'avis-imposition': 'Avis d\'imposition',
    'justificatif-domicile': 'Quittances ou taxe foncière',
    'autre': 'Autre',
  };

  // Les extensions comptent autant que le type MIME : Windows renvoie parfois
  // un type vide pour un .doc, et un .odt n'a pas toujours de type déclaré.
  const EXTENSIONS_PIECE = ['.pdf', '.doc', '.docx', '.odt', '.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif'];
  const CANDIDATURE_PIECE_MAX_OCTETS = 15 * 1024 * 1024;

  const CHAMPS_CANDIDATURE = [
    { cle: 'nom', label: 'Nom et prénom', type: 'text' },
    { cle: 'telephone', label: 'Téléphone', type: 'tel' },
    { cle: 'email', label: 'Adresse e-mail', type: 'email' },
    { cle: 'dateReception', label: 'Demande reçue le', type: 'date' },
    { cle: 'ressources', label: 'Ressources mensuelles (€)', type: 'number', aide: 'Total déclaré : salaires, pensions, autres revenus' },
    { cle: 'chargesDeclarees', label: 'Charges mensuelles déclarées (€)', type: 'number', aide: 'Crédits, pensions versées. Déclaratif : aucun justificatif ne peut être exigé.' },
  ];

  function candidaturesDuBien(bienId) {
    return data.candidatures.filter((c) => c.bienId === bienId);
  }

  function candidatureCourante() {
    return data.candidatures.find((c) => c.id === candidatureCouranteId) || null;
  }

  function planifierSauvegardeCandidature() {
    if (candidatureSaveTimer) clearTimeout(candidatureSaveTimer);
    candidatureSaveTimer = setTimeout(() => { candidatureSaveTimer = null; save(); }, 800);
  }

  function indicateursDe(candidature) {
    return QfCandidature.calculerIndicateurs(candidature, bienById(candidature.bienId), reglagesAnnonce());
  }

  function trierCandidatures(liste) {
    const copie = liste.slice();
    if (candidatureTri === 'ratio') {
      copie.sort((a, b) => {
        const ra = indicateursDe(a).ratioLoyer, rb = indicateursDe(b).ratioLoyer;
        if (ra === null) return 1;
        if (rb === null) return -1;
        return rb - ra;
      });
    } else if (candidatureTri === 'reste') {
      copie.sort((a, b) => {
        const ra = indicateursDe(a).resteAVivre, rb = indicateursDe(b).resteAVivre;
        if (ra === null) return 1;
        if (rb === null) return -1;
        return rb - ra;
      });
    } else {
      copie.sort((a, b) => String(b.dateReception || '').localeCompare(String(a.dateReception || '')));
    }
    return copie;
  }

  function renderCandidatures(forcer) {
    const conteneur = byId('candidatures-contenu');
    if (!conteneur) return;

    // Même garde-fou que l'écran Publication : la synchronisation rappelle
    // refreshCurrentView() à chaque enregistrement, et reconstruire le DOM
    // pendant une frappe ferait perdre le focus. Limité aux champs de saisie,
    // sinon les boutons deviendraient inertes.
    const actif = document.activeElement;
    const enSaisie = !forcer && actif && conteneur.contains(actif)
      && (actif.tagName === 'TEXTAREA'
        || (actif.tagName === 'INPUT' && actif.type !== 'file' && actif.type !== 'button'));
    if (enSaisie) { majIndicateursCandidature(); return; }

    if (data.biens.length === 0) {
      conteneur.innerHTML = '<div class="panel"><p>Aucun bien enregistré. Créez d\'abord un bien dans « Biens ».</p></div>';
      return;
    }

    if (!bienById(candidatureBienId)) candidatureBienId = data.biens[0].id;

    const liste = trierCandidatures(candidaturesDuBien(candidatureBienId));
    if (!liste.some((c) => c.id === candidatureCouranteId)) {
      candidatureCouranteId = liste.length ? liste[0].id : '';
    }
    const candidature = candidatureCourante();

    const optionsBiens = data.biens
      .map((b) => `<option value="${escapeHTML(b.id)}"${b.id === candidatureBienId ? ' selected' : ''}>${escapeHTML(b.nom)}</option>`)
      .join('');

    const lignes = liste.length ? liste.map((c) => {
      const ind = indicateursDe(c);
      const bloquant = ind.alertes.some((a) => a.gravite === 'bloquant');
      return `<tr class="${c.id === candidatureCouranteId ? 'candidature-active' : ''}" data-candidature-ligne="${escapeHTML(c.id)}">
        <td data-label="Nom">${escapeHTML(c.nom || 'Sans nom')}</td>
        <td data-label="Statut"><span class="badge ${c.statut === 'retenue' ? 'badge-active' : 'badge-inactive'}">${escapeHTML(STATUTS_CANDIDATURE[c.statut] || c.statut || '—')}</span></td>
        <td data-label="Ratio">${ind.ratioLoyer === null ? '—' : ind.ratioLoyer.toFixed(2)}</td>
        <td data-label="Reste à vivre" class="${bloquant ? 'candidature-alerte' : ''}">${ind.resteAVivre === null ? '—' : euros(ind.resteAVivre)}</td>
        <td data-label="Pièces">${(c.pieces || []).length}</td>
        <td class="actions-cell"><button class="btn btn-sm" data-candidature-ouvrir="${escapeHTML(c.id)}">Ouvrir</button></td>
      </tr>`;
    }).join('') : '<tr class="empty-row"><td colspan="6">Aucune candidature pour ce bien.</td></tr>';

    conteneur.innerHTML = `
      <div class="panel">
        <h2>Bien concerné</h2>
        <div class="grid-2">
          <div class="field"><label>Bien</label><select id="candidature-bien">${optionsBiens}</select></div>
          <div class="field"><label>Trier par</label>
            <select id="candidature-tri">
              <option value="date"${candidatureTri === 'date' ? ' selected' : ''}>Date de réception</option>
              <option value="ratio"${candidatureTri === 'ratio' ? ' selected' : ''}>Ratio (loyer hors charges)</option>
              <option value="reste"${candidatureTri === 'reste' ? ' selected' : ''}>Reste à vivre</option>
            </select></div>
        </div>
        <div class="table-scroll">
          <table class="table table-cartes">
            <thead><tr><th>Nom</th><th>Statut</th><th>Ratio</th><th>Reste à vivre</th><th>Pièces</th><th></th></tr></thead>
            <tbody>${lignes}</tbody>
          </table>
        </div>
        <div class="annonce-actions">
          <button class="btn btn-primary btn-sm" id="candidature-nouvelle">Nouvelle candidature</button>
          <button class="btn btn-sm" id="candidature-fiche">Fiche de renseignements (PDF)</button>
        </div>
        <p class="annonce-aide">La fiche est vierge, à remettre aux candidats : elle reprend l'adresse, le loyer, les charges et le dépôt de garantie du bien sélectionné.</p>
      </div>

      ${candidature ? `
      <div class="panel">
        <h2>Dossier</h2>
        <div class="charges-form-grid">${champsHTML('data-cand-champ', CHAMPS_CANDIDATURE, candidature)}</div>
        <div class="field">
          <label>Notes</label>
          <textarea rows="3" data-cand-champ="notes">${escapeHTML(candidature.notes || '')}</textarea>
        </div>
        <div id="candidature-indicateurs"></div>
      </div>

      <div class="panel">
        <h2>Pièces du dossier</h2>
        <div id="candidature-pieces"></div>
        <div class="annonce-actions">
          <select id="candidature-type-piece">${Object.keys(TYPES_PIECE).map((k) => `<option value="${k}">${escapeHTML(TYPES_PIECE[k])}</option>`).join('')}</select>
          <label class="btn btn-sm annonce-photo-add">
            Ajouter des pièces
            <input type="file" id="candidature-piece-input" accept="image/*,.pdf,.doc,.docx,.odt" multiple hidden>
          </label>
          <span id="candidature-piece-retour" class="annonce-copie-retour"></span>
        </div>
        <p class="annonce-aide">PDF, Word, JPG, PNG acceptés. Les photos sont réduites automatiquement.</p>
      </div>

      <div class="panel">
        <h2>Décision</h2>
        <div class="annonce-actions">
          <button class="btn btn-primary btn-sm" id="candidature-retenir"${candidature.statut === 'retenue' ? ' disabled' : ''}>Retenir pour visite</button>
          <button class="btn btn-sm" id="candidature-refuser"${candidature.statut === 'refusee' ? ' disabled' : ''}>Refuser</button>
          <button class="btn btn-sm btn-danger" id="candidature-supprimer">Supprimer la candidature</button>
        </div>
        <div id="candidature-mail"></div>
      </div>
      ` : ''}
    `;

    brancherEcouteursCandidature();
    if (candidature) {
      majIndicateursCandidature();
      afficherPiecesCandidature();
      afficherMailRefus();
    }
  }

  function brancherEcouteursCandidature() {
    const conteneur = byId('candidatures-contenu');

    byId('candidature-bien').addEventListener('change', (e) => {
      candidatureBienId = e.target.value;
      candidatureCouranteId = '';
      renderCandidatures(true);
    });
    byId('candidature-tri').addEventListener('change', (e) => {
      candidatureTri = e.target.value;
      renderCandidatures(true);
    });
    byId('candidature-nouvelle').addEventListener('click', creerCandidature);
    byId('candidature-fiche').addEventListener('click', telechargerFicheRenseignements);

    conteneur.querySelectorAll('[data-candidature-ouvrir]').forEach((b) => {
      b.addEventListener('click', () => {
        candidatureCouranteId = b.dataset.candidatureOuvrir;
        renderCandidatures(true);
      });
    });

    const btnRetenir = byId('candidature-retenir');
    if (btnRetenir) btnRetenir.addEventListener('click', retenirCandidature);
    const btnRefuser = byId('candidature-refuser');
    if (btnRefuser) btnRefuser.addEventListener('click', refuserCandidature);
    const btnSupprimer = byId('candidature-supprimer');
    if (btnSupprimer) btnSupprimer.addEventListener('click', supprimerCandidature);

    const inputPieces = byId('candidature-piece-input');
    if (inputPieces) inputPieces.addEventListener('change', async (e) => {
      const fichiers = Array.from(e.target.files || []);
      e.target.value = '';
      await ajouterPiecesCandidature(fichiers);
    });

    conteneur.addEventListener('input', (e) => {
      if (appliquerSaisieCandidature(e.target)) {
        planifierSauvegardeCandidature();
        majIndicateursCandidature();
      }
    });
  }

  function appliquerSaisieCandidature(cible) {
    const champ = cible.dataset.candChamp;
    if (!champ) return false;
    const candidature = candidatureCourante();
    if (!candidature) return false;
    candidature[champ] = cible.type === 'number'
      ? (cible.value === '' ? null : Number(cible.value))
      : cible.value;
    return true;
  }

  // Le tableau n'est pas reconstruit pendant la saisie (garde-fou du focus) :
  // sans cette mise à jour ciblée, le nom qu'on est en train de taper
  // n'apparaîtrait pas dans la liste, qui resterait sur « Sans nom ».
  function majLigneCandidature(candidature, ind) {
    const ligne = document.querySelector('[data-candidature-ligne="' + candidature.id + '"]');
    if (!ligne) return;
    const cellules = ligne.querySelectorAll('td');
    if (cellules.length < 5) return;
    const bloquant = ind.alertes.some((a) => a.gravite === 'bloquant');
    cellules[0].textContent = candidature.nom || 'Sans nom';
    cellules[1].innerHTML = `<span class="badge ${candidature.statut === 'retenue' ? 'badge-active' : 'badge-inactive'}">${escapeHTML(STATUTS_CANDIDATURE[candidature.statut] || '—')}</span>`;
    cellules[2].textContent = ind.ratioLoyer === null ? '—' : ind.ratioLoyer.toFixed(2);
    cellules[3].textContent = ind.resteAVivre === null ? '—' : euros(ind.resteAVivre);
    cellules[3].className = bloquant ? 'candidature-alerte' : '';
    cellules[4].textContent = (candidature.pieces || []).length;
  }

  function majIndicateursCandidature() {
    const zone = byId('candidature-indicateurs');
    const candidature = candidatureCourante();
    if (!zone || !candidature) return;

    const ind = indicateursDe(candidature);
    majLigneCandidature(candidature, ind);
    let html = '';

    if (ind.ratioLoyer !== null) {
      html += `<div class="candidature-chiffres">
        <div><span class="candidature-chiffre">${(ind.tauxEffort * 100).toFixed(1)} %</span><small>Taux d'effort</small></div>
        <div><span class="candidature-chiffre">${euros(ind.resteAVivre)}</span><small>Reste à vivre</small></div>
        <div><span class="candidature-chiffre">${ind.ratioLoyer.toFixed(2)} ×</span><small>Le loyer hors charges</small></div>
      </div>`;
    }

    ind.alertes.forEach((a) => {
      const classe = a.gravite === 'bloquant' ? 'annonce-alerte-bloquant' : 'annonce-alerte-attention';
      html += `<div class="annonce-alerte ${classe}">${escapeHTML(a.message)}</div>`;
    });

    zone.innerHTML = html;
  }

  // Fiche vierge du bien sélectionné : montants pris sur le bien, jamais figés
  // dans le PDF. Le dépôt de garantie vaut un mois de loyer hors charges
  // (plafond légal pour une location vide), comme dans le générateur d'annonce.
  function telechargerFicheRenseignements() {
    const bien = bienById(candidatureBienId);
    if (!bien) return;
    downloadPdf('fiche-renseignements', {
      bienNom: bien.nom || '',
      locationAdresse: bien.adresse || '',
      loyer: bien.loyer != null ? bien.loyer : null,
      charges: bien.charges != null ? bien.charges : null,
      depotGarantie: bien.loyer != null ? bien.loyer : null,
      sciNom: data.sci.nom || '',
      ville: data.sci.ville || '',
    });
  }

  function creerCandidature() {
    const candidature = {
      id: Storage.uid(),
      bienId: candidatureBienId,
      nom: '', telephone: '', email: '',
      dateReception: todayISO(),
      statut: 'recue',
      ressources: null, chargesDeclarees: null,
      pieces: [], notes: '', dateDecision: '',
    };
    data.candidatures.push(candidature);
    candidatureCouranteId = candidature.id;
    save();
    renderCandidatures(true);
  }

  function retenirCandidature() {
    const candidature = candidatureCourante();
    if (!candidature) return;
    candidature.statut = 'retenue';
    candidature.dateDecision = todayISO();
    save();
    renderCandidatures(true);
  }

  // Les pièces sont effacées au refus : un dossier contient une pièce
  // d'identité, des bulletins de salaire et des avis d'imposition, et rien ne
  // justifie de les conserver une fois la décision prise. La fiche reste, pour
  // garder trace de qui a candidaté.
  async function refuserCandidature() {
    const candidature = candidatureCourante();
    if (!candidature) return;
    const nb = (candidature.pieces || []).length;
    const message = nb
      ? `Refuser cette candidature ?\n\nLes ${nb} pièce(s) du dossier seront définitivement supprimées. La fiche (nom, contact, date) est conservée.`
      : 'Refuser cette candidature ?';
    if (!confirm(message)) return;

    const pieces = (candidature.pieces || []).slice();
    candidature.pieces = [];
    candidature.statut = 'refusee';
    candidature.dateDecision = todayISO();
    save();
    renderCandidatures(true);

    for (const p of pieces) {
      try { await FilesDb.deleteFile(p.fileId); } catch (e) { console.error(e); }
    }
  }

  async function supprimerCandidature() {
    const candidature = candidatureCourante();
    if (!candidature) return;
    if (!confirm('Supprimer définitivement cette candidature et ses pièces ?')) return;
    const pieces = (candidature.pieces || []).slice();
    data.candidatures = data.candidatures.filter((c) => c.id !== candidature.id);
    // Un candidat supprimé ne doit plus figurer dans un planning de visite.
    data.visites.forEach((v) => {
      v.creneaux = (v.creneaux || []).filter((cr) => cr.candidatureId !== candidature.id);
    });
    candidatureCouranteId = '';
    save();
    renderCandidatures(true);
    for (const p of pieces) {
      try { await FilesDb.deleteFile(p.fileId); } catch (e) { console.error(e); }
    }
  }

  function afficherMailRefus() {
    const zone = byId('candidature-mail');
    const candidature = candidatureCourante();
    if (!zone || !candidature) return;
    if (candidature.statut !== 'refusee') { zone.innerHTML = ''; return; }

    const mail = QfCandidature.construireMailRefus(candidature, bienById(candidature.bienId), data.sci);
    zone.innerHTML = `
      <div class="field"><label>Objet</label><input type="text" id="candidature-mail-objet" value="${escapeHTML(mail.objet)}" readonly></div>
      <div class="field"><label>Message</label><textarea id="candidature-mail-corps" rows="12" readonly>${escapeHTML(mail.corps)}</textarea></div>
      <div class="annonce-actions">
        <button class="btn btn-primary btn-sm" id="candidature-copier-mail">Copier le message</button>
        <span id="candidature-mail-retour" class="annonce-copie-retour"></span>
      </div>
      <p class="annonce-aide">Le message ne donne aucun motif : un refus n'a pas à être justifié, et un motif mal formulé se lit comme discriminatoire. Relisez-le avant de l'envoyer depuis votre messagerie.</p>`;

    byId('candidature-copier-mail').addEventListener('click', async () => {
      const retour = byId('candidature-mail-retour');
      const ok = await copierTexte(byId('candidature-mail-corps').value);
      retour.textContent = ok ? 'Message copié.' : 'Copie impossible : sélectionnez le texte et copiez-le à la main.';
      retour.className = 'annonce-copie-retour ' + (ok ? 'annonce-copie-ok' : 'annonce-copie-ko');
      setTimeout(() => { retour.textContent = ''; }, 4000);
    });
  }

  // ---------- Pièces d'un dossier ----------

  let candidaturePieceUrls = [];

  function pieceAcceptee(fichier) {
    const type = fichier.type || '';
    if (type.startsWith('image/') || type === 'application/pdf') return true;
    if (type.indexOf('word') !== -1 || type.indexOf('opendocument.text') !== -1) return true;
    // Repli sur l'extension : Windows renvoie parfois un type vide pour un .doc.
    const nom = String(fichier.name || '').toLowerCase();
    return EXTENSIONS_PIECE.some((ext) => nom.endsWith(ext));
  }

  async function ajouterPiecesCandidature(fichiers) {
    const candidature = candidatureCourante();
    if (!candidature || fichiers.length === 0) return;
    const typeChoisi = byId('candidature-type-piece').value;
    const retour = byId('candidature-piece-retour');
    const refuses = [];
    let ajoutees = 0;

    for (const fichier of fichiers) {
      if (!pieceAcceptee(fichier)) { refuses.push(fichier.name + ' (format non accepté)'); continue; }
      if (fichier.size > CANDIDATURE_PIECE_MAX_OCTETS) { refuses.push(fichier.name + ' (plus de 15 Mo)'); continue; }

      // Seules les images sont réduites ; un PDF ou un .docx est stocké tel quel.
      const aStocker = (fichier.type || '').startsWith('image/')
        ? await resizeImageFile(fichier, 1920, 0.85)
        : fichier;

      const fileId = Storage.uid();
      try {
        await FilesDb.saveFile(fileId, aStocker);
        if (!candidature.pieces) candidature.pieces = [];
        candidature.pieces.push({ fileId: fileId, type: typeChoisi, nom: fichier.name });
        ajoutees++;
      } catch (e) {
        console.error(e);
        refuses.push(fichier.name + ' (enregistrement impossible)');
      }
    }

    if (ajoutees) {
      // Recevoir une pièce, c'est avoir le dossier : le statut suit tout seul.
      if (candidature.statut === 'recue') candidature.statut = 'dossier-recu';
      save();
      renderCandidatures(true);
    }

    const zoneRetour = byId('candidature-piece-retour') || retour;
    if (zoneRetour) {
      zoneRetour.textContent = refuses.length
        ? `${ajoutees} ajoutée(s). Refusé : ${refuses.join(', ')}`
        : `${ajoutees} pièce(s) ajoutée(s).`;
      zoneRetour.className = 'annonce-copie-retour ' + (refuses.length ? 'annonce-copie-ko' : 'annonce-copie-ok');
    }
  }

  async function afficherPiecesCandidature() {
    const zone = byId('candidature-pieces');
    const candidature = candidatureCourante();
    if (!zone || !candidature) return;

    candidaturePieceUrls.forEach((u) => URL.revokeObjectURL(u));
    candidaturePieceUrls = [];

    const pieces = candidature.pieces || [];
    if (pieces.length === 0) {
      zone.innerHTML = '<p class="annonce-aide">Aucune pièce enregistrée.</p>';
      return;
    }

    zone.innerHTML = pieces.map((p, i) => `
      <div class="candidature-piece">
        <span class="candidature-piece-nom">${escapeHTML(p.nom || 'Sans nom')}</span>
        <select data-piece-type="${i}">${Object.keys(TYPES_PIECE).map((k) => `<option value="${k}"${k === p.type ? ' selected' : ''}>${escapeHTML(TYPES_PIECE[k])}</option>`).join('')}</select>
        <button class="btn btn-sm" data-piece-ouvrir="${i}">Ouvrir</button>
        <button class="btn btn-sm btn-danger" data-piece-supprimer="${i}">×</button>
      </div>`).join('');

    zone.querySelectorAll('[data-piece-ouvrir]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = pieces[Number(b.dataset.pieceOuvrir)];
        openStoredFile(p.fileId, p.nom);
      });
    });
    zone.querySelectorAll('[data-piece-type]').forEach((s) => {
      s.addEventListener('change', () => {
        pieces[Number(s.dataset.pieceType)].type = s.value;
        save();
      });
    });
    zone.querySelectorAll('[data-piece-supprimer]').forEach((b) => {
      b.addEventListener('click', async () => {
        const i = Number(b.dataset.pieceSupprimer);
        const p = pieces[i];
        if (!confirm('Supprimer « ' + (p.nom || 'cette pièce') + ' » ?')) return;
        pieces.splice(i, 1);
        save();
        await afficherPiecesCandidature();
        try { await FilesDb.deleteFile(p.fileId); } catch (e) { console.error(e); }
      });
    });
  }

  // ---------- Visites ----------

  let visiteBienId = '';
  let visiteCouranteId = '';
  let visiteSaveTimer = null;

  function dateVisiteFR(iso) {
    return iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR') : '';
  }

  function visitesDuBien(bienId) {
    return data.visites
      .filter((v) => v.bienId === bienId)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }

  function visiteCourante() {
    return data.visites.find((v) => v.id === visiteCouranteId) || null;
  }

  function planifierSauvegardeVisite() {
    if (visiteSaveTimer) clearTimeout(visiteSaveTimer);
    visiteSaveTimer = setTimeout(() => { visiteSaveTimer = null; save(); }, 800);
  }

  // Le planning suit les décisions prises dans l'écran Candidatures : un
  // candidat retenu après coup est ajouté à la suite, un candidat refusé ou
  // supprimé disparaît. L'ordre déjà établi à la main n'est pas touché.
  function synchroniserCreneaux(visite) {
    const retenues = data.candidatures.filter((c) => c.bienId === visite.bienId && c.statut === 'retenue');
    const idsRetenus = retenues.map((c) => c.id);
    const avant = (visite.creneaux || []).map((cr) => cr.candidatureId).join('|');

    const conserves = (visite.creneaux || []).filter((cr) => idsRetenus.indexOf(cr.candidatureId) !== -1);
    const dejaLa = conserves.map((cr) => cr.candidatureId);
    const ajouts = idsRetenus
      .filter((id) => dejaLa.indexOf(id) === -1)
      .map((id) => ({ candidatureId: id, heure: '' }));

    visite.creneaux = conserves.concat(ajouts);
    return visite.creneaux.map((cr) => cr.candidatureId).join('|') !== avant;
  }

  // L'ordre du tableau fait foi : les heures ne sont qu'un miroir, recalculé à
  // chaque modification, comme `ordre` pour les photos d'annonce.
  function majHeuresCreneaux(visite) {
    const heures = QfCandidature.calculerCreneaux(visite.heureDebut, visite.dureeCreneau, visite.creneaux.length);
    let modifie = false;
    visite.creneaux.forEach((cr, i) => {
      const heure = heures[i] || '';
      if (cr.heure !== heure) { cr.heure = heure; modifie = true; }
    });
    return modifie;
  }

  function lignesVisite(visite) {
    return visite.creneaux.map((cr) => {
      const candidature = data.candidatures.find((c) => c.id === cr.candidatureId);
      return {
        heure: cr.heure || '—',
        nom: (candidature && candidature.nom) || 'Sans nom',
        telephone: (candidature && candidature.telephone) || '',
      };
    });
  }

  function texteVisite(visite) {
    const bien = bienById(visite.bienId);
    const entete = `Visites — ${bien ? bien.nom : 'Bien supprimé'}${visite.date ? ' — ' + dateVisiteFR(visite.date) : ''}`;
    const lignes = lignesVisite(visite)
      .map((l) => `${l.heure} — ${l.nom}${l.telephone ? ' — ' + l.telephone : ''}`);
    return [entete, ''].concat(lignes).join('\n');
  }

  function renderVisites(forcer) {
    const conteneur = byId('visites-contenu');
    if (!conteneur) return;

    // Même garde-fou que les écrans Publication et Candidatures : la
    // synchronisation ne doit pas reconstruire le DOM pendant une frappe.
    const actif = document.activeElement;
    const enSaisie = !forcer && actif && conteneur.contains(actif)
      && (actif.tagName === 'TEXTAREA'
        || (actif.tagName === 'INPUT' && actif.type !== 'file' && actif.type !== 'button'));
    if (enSaisie) return;

    if (data.biens.length === 0) {
      conteneur.innerHTML = '<div class="panel"><p>Aucun bien enregistré. Créez d\'abord un bien dans « Biens ».</p></div>';
      return;
    }

    if (!bienById(visiteBienId)) visiteBienId = data.biens[0].id;

    const seances = visitesDuBien(visiteBienId);
    if (!seances.some((v) => v.id === visiteCouranteId)) {
      visiteCouranteId = seances.length ? seances[0].id : '';
    }

    const visite = visiteCourante();
    let modifie = false;
    if (visite) {
      modifie = synchroniserCreneaux(visite);
      modifie = majHeuresCreneaux(visite) || modifie;
      if (modifie) save();
    }

    const optionsBiens = data.biens
      .map((b) => `<option value="${escapeHTML(b.id)}"${b.id === visiteBienId ? ' selected' : ''}>${escapeHTML(b.nom)}</option>`)
      .join('');
    const optionsSeances = seances
      .map((v) => `<option value="${escapeHTML(v.id)}"${v.id === visiteCouranteId ? ' selected' : ''}>${escapeHTML(v.date ? dateVisiteFR(v.date) : 'Sans date')}</option>`)
      .join('');

    const retenues = data.candidatures.filter((c) => c.bienId === visiteBienId && c.statut === 'retenue');

    conteneur.innerHTML = `
      <div class="panel">
        <h2>Séance de visites</h2>
        <div class="grid-2">
          <div class="field"><label>Bien</label><select id="visite-bien">${optionsBiens}</select></div>
          <div class="field"><label>Séance</label>
            ${seances.length
              ? `<select id="visite-seance">${optionsSeances}</select>`
              : '<p class="annonce-aide">Aucune séance pour ce bien.</p>'}
          </div>
        </div>
        <div class="annonce-actions">
          <button class="btn btn-primary btn-sm" id="visite-nouvelle">Nouvelle séance</button>
          ${visite ? '<button class="btn btn-sm btn-danger" id="visite-supprimer">Supprimer la séance</button>' : ''}
        </div>
      </div>

      ${visite ? `
      <div class="panel">
        <h2>Horaires</h2>
        <div class="charges-form-grid">
          <div class="field"><label>Date</label><input type="date" data-visite-champ="date" value="${escapeHTML(visite.date || '')}"></div>
          <div class="field"><label>Heure de début</label><input type="time" data-visite-champ="heureDebut" value="${escapeHTML(visite.heureDebut || '')}"></div>
          <div class="field"><label>Durée d'un créneau (min)</label><input type="number" min="5" step="5" data-visite-champ="dureeCreneau" value="${visite.dureeCreneau == null ? '' : visite.dureeCreneau}"></div>
        </div>
      </div>

      <div class="panel">
        <h2>Planning</h2>
        <div id="visite-planning"></div>
        <p class="annonce-aide">Les candidats retenus dans « Candidatures » sont placés à la suite. Les heures se recalculent d'après l'ordre du tableau.</p>
      </div>

      <div class="panel">
        <h2>Liste à emporter</h2>
        <div class="field"><textarea id="visite-texte" rows="${Math.max(4, visite.creneaux.length + 3)}" readonly>${escapeHTML(texteVisite(visite))}</textarea></div>
        <div class="annonce-actions">
          <button class="btn btn-primary btn-sm" id="visite-copier">Copier la liste</button>
          <span id="visite-copie-retour" class="annonce-copie-retour"></span>
        </div>
      </div>
      ` : `
      <div class="panel">
        <p>${retenues.length
          ? 'Créez une séance pour placer les ' + retenues.length + ' candidat(s) retenu(s).'
          : 'Aucun candidat retenu pour ce bien : retenez d\'abord des candidatures dans « Candidatures ».'}</p>
      </div>`}
    `;

    brancherEcouteursVisite();
    if (visite) afficherPlanningVisite();
  }

  function afficherPlanningVisite() {
    const zone = byId('visite-planning');
    const visite = visiteCourante();
    if (!zone || !visite) return;

    if (visite.creneaux.length === 0) {
      zone.innerHTML = '<p class="annonce-aide">Aucun candidat retenu pour ce bien : le planning reste vide tant qu\'une candidature n\'est pas retenue.</p>';
      return;
    }

    const lignes = lignesVisite(visite).map((l, i) => `<tr>
      <td data-label="Heure">${escapeHTML(l.heure)}</td>
      <td data-label="Candidat">${escapeHTML(l.nom)}</td>
      <td data-label="Téléphone">${escapeHTML(l.telephone || '—')}</td>
      <td class="actions-cell">
        <button type="button" class="btn btn-sm" data-creneau-monter="${i}"${i === 0 ? ' disabled' : ''} title="Monter">↑</button>
        <button type="button" class="btn btn-sm" data-creneau-descendre="${i}"${i === visite.creneaux.length - 1 ? ' disabled' : ''} title="Descendre">↓</button>
      </td>
    </tr>`).join('');

    zone.innerHTML = `<div class="table-scroll">
      <table class="table table-cartes">
        <thead><tr><th>Heure</th><th>Candidat</th><th>Téléphone</th><th></th></tr></thead>
        <tbody>${lignes}</tbody>
      </table>
    </div>`;

    zone.querySelectorAll('[data-creneau-monter]').forEach((b) => {
      b.addEventListener('click', () => deplacerCreneau(Number(b.dataset.creneauMonter), -1));
    });
    zone.querySelectorAll('[data-creneau-descendre]').forEach((b) => {
      b.addEventListener('click', () => deplacerCreneau(Number(b.dataset.creneauDescendre), 1));
    });
  }

  function brancherEcouteursVisite() {
    const conteneur = byId('visites-contenu');

    byId('visite-bien').addEventListener('change', (e) => {
      visiteBienId = e.target.value;
      visiteCouranteId = '';
      renderVisites(true);
    });
    const selSeance = byId('visite-seance');
    if (selSeance) selSeance.addEventListener('change', (e) => {
      visiteCouranteId = e.target.value;
      renderVisites(true);
    });
    byId('visite-nouvelle').addEventListener('click', creerSeanceVisite);
    const btnSupprimer = byId('visite-supprimer');
    if (btnSupprimer) btnSupprimer.addEventListener('click', supprimerSeanceVisite);

    const btnCopier = byId('visite-copier');
    if (btnCopier) btnCopier.addEventListener('click', async () => {
      const retour = byId('visite-copie-retour');
      const ok = await copierTexte(byId('visite-texte').value);
      retour.textContent = ok ? 'Liste copiée.' : 'Copie impossible : sélectionnez le texte et copiez-le à la main.';
      retour.className = 'annonce-copie-retour ' + (ok ? 'annonce-copie-ok' : 'annonce-copie-ko');
      setTimeout(() => { retour.textContent = ''; }, 4000);
    });

    conteneur.addEventListener('input', (e) => {
      const champ = e.target.dataset.visiteChamp;
      if (!champ) return;
      const visite = visiteCourante();
      if (!visite) return;
      visite[champ] = champ === 'dureeCreneau'
        ? (e.target.value === '' ? null : Number(e.target.value))
        : e.target.value;
      majHeuresCreneaux(visite);
      planifierSauvegardeVisite();
      majAffichageVisite();
    });
  }

  // Mise à jour ciblée pendant la saisie : le DOM n'est pas reconstruit, mais
  // les heures et la liste à emporter doivent suivre la frappe.
  function majAffichageVisite() {
    const visite = visiteCourante();
    if (!visite) return;
    afficherPlanningVisite();
    const texte = byId('visite-texte');
    if (texte) texte.value = texteVisite(visite);
  }

  function creerSeanceVisite() {
    const visite = {
      id: Storage.uid(),
      bienId: visiteBienId,
      date: todayISO(),
      heureDebut: '09:00',
      dureeCreneau: 30,
      creneaux: [],
    };
    synchroniserCreneaux(visite);
    majHeuresCreneaux(visite);
    data.visites.push(visite);
    visiteCouranteId = visite.id;
    save();
    renderVisites(true);
  }

  function supprimerSeanceVisite() {
    const visite = visiteCourante();
    if (!visite) return;
    if (!confirm('Supprimer cette séance de visites ?')) return;
    data.visites = data.visites.filter((v) => v.id !== visite.id);
    visiteCouranteId = '';
    save();
    renderVisites(true);
  }

  function deplacerCreneau(index, delta) {
    const visite = visiteCourante();
    if (!visite) return;
    const cible = index + delta;
    if (cible < 0 || cible >= visite.creneaux.length) return;
    const [creneau] = visite.creneaux.splice(index, 1);
    visite.creneaux.splice(cible, 0, creneau);
    majHeuresCreneaux(visite);
    save();
    renderVisites(true);
  }

  // ---------- Import / Export ----------
  function slugify(str) {
    return String(str || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '')
      .toLowerCase() || 'sans-nom';
  }

  byId('btn-export').addEventListener('click', async () => {
    const btn = byId('btn-export');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Préparation de l'archive...";
    try {
      const zip = new JSZip();
      const manifest = {};

      const addFiles = async (folder, record) => {
        const files = filesOf(record);
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const blob = await FilesDb.getFile(f.fileId);
          if (!blob) continue;
          const pageSuffix = files.length > 1 ? `-page${i + 1}` : '';
          const name = `${record.date || 'sans-date'}${pageSuffix}-${f.fileName || f.fileId}`;
          const path = `fichiers/${folder}/${name}`;
          zip.file(path, blob);
          manifest[f.fileId] = { path, type: blob.type || 'application/octet-stream' };
        }
      };

      for (const c of data.charges) {
        const catLabel = CHARGE_CATEGORIES[c.categorie] || c.categorie || 'autre';
        await addFiles(`charges-locatives/${slugify(catLabel)}`, c);
      }
      for (const b of data.baux) {
        const loc = locataireById(b.locataireId);
        await addFiles(`bail/${slugify(loc ? loc.nom : 'locataire-inconnu')}`, b);
      }
      for (const e of data.etatsDesLieux) {
        const loc = locataireById(e.locataireId);
        await addFiles(`etats-des-lieux/${e.sens}/${slugify(loc ? loc.nom : 'locataire-inconnu')}`, e);
      }
      for (const d of data.documentsAdmin) {
        const catLabel = ADMIN_DOC_CATEGORIES[d.categorie] || d.categorie || 'autre';
        await addFiles(`documents-administratifs/${slugify(catLabel)}`, d);
      }
      for (const d of data.documentsLocataires) {
        const loc = locataireById(d.locataireId);
        await addFiles(`anciens-locataires/${slugify(loc ? loc.nom : 'locataire-inconnu')}`, d);
      }
      for (const c of data.credits) {
        const catLabel = CREDIT_CATEGORIES[c.categorie] || c.categorie || 'autre';
        await addFiles(`credits/${slugify(catLabel)}`, c);
      }
      for (const d of data.facturesTravaux) {
        const catLabel = FACTURES_TRAVAUX_CATEGORIES[d.categorie] || d.categorie || 'autre';
        await addFiles(`factures-et-travaux/${slugify(catLabel)}`, d);
      }
      for (const r of data.edlRedactions) {
        const bien = bienById(r.bienId);
        const baseFolder = `etats-des-lieux-rediges/${slugify(bien ? bien.nom : 'bien-inconnu')}/${r.sens}-${slugify(r.date || 'sans-date')}`;
        for (const room of r.pieces) {
          for (const el of room.elements) {
            if (!el.files || el.files.length === 0) continue;
            await addFiles(`${baseFolder}/${slugify(room.nom)}-${slugify(el.nom)}`, { date: r.date, files: el.files });
          }
        }
        for (const m of (r.compteurs || [])) {
          if (!m.files || m.files.length === 0) continue;
          await addFiles(`${baseFolder}/compteurs-${slugify(m.nom)}`, { date: r.date, files: m.files });
        }
        for (const c of (r.cles || [])) {
          if (!c.files || c.files.length === 0) continue;
          await addFiles(`${baseFolder}/cles-${slugify(c.nom)}`, { date: r.date, files: c.files });
        }
      }

      // Les photos d'annonce sont rangées sous `photos` et non sous `files` :
      // filesOf() ne les voit pas, il faut donc les présenter explicitement.
      // Sans cette boucle elles seraient absentes de la sauvegarde, alors que
      // l'export manuel est la seule protection contre une perte de données.
      for (const r of data.annonceRedactions) {
        if (!r.photos || r.photos.length === 0) continue;
        const bien = bienById(r.bienId);
        await addFiles(
          `annonces/${slugify(bien ? bien.nom : 'bien-inconnu')}/${slugify(r.titre || r.id)}`,
          {
            date: (r.createdAt || '').slice(0, 10) || 'sans-date',
            files: r.photos.map((p, i) => ({
              fileId: p.fileId,
              fileName: QfAnnonce.nomFichierPhoto(i, 'image/jpeg'),
            })),
          }
        );
      }

      // Même raison que pour les photos d'annonce : les pièces d'un dossier
      // vivent sous `pieces`, que filesOf() ne reconnaît pas. Sans cette
      // boucle, les justificatifs des candidats seraient absents de la
      // sauvegarde.
      for (const c of data.candidatures) {
        if (!c.pieces || c.pieces.length === 0) continue;
        const bien = bienById(c.bienId);
        await addFiles(
          `candidatures/${slugify(bien ? bien.nom : 'bien-inconnu')}/${slugify(c.nom || c.id)}`,
          {
            date: c.dateReception || 'sans-date',
            files: c.pieces.map((p) => ({
              fileId: p.fileId,
              fileName: p.nom || (p.type || 'piece'),
            })),
          }
        );
      }

      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      zip.file('donnees.json', JSON.stringify(data, null, 2));

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = todayISO();
      a.href = url;
      a.download = `quittance-facile-sauvegarde-${stamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert("Une erreur est survenue lors de la génération de l'archive.");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  byId('btn-import').addEventListener('click', () => byId('file-import').click());
  byId('file-import').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.zip')) {
      importZipBackup(file);
    } else {
      importJsonBackup(file);
    }
    e.target.value = '';
  });

  function importJsonBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!confirm('Importer ces données remplacera vos données actuelles. Continuer ?')) return;
        Object.assign(data, {
          sci: parsed.sci || {},
          biens: parsed.biens || [],
          locataires: parsed.locataires || [],
          documents: parsed.documents || [],
          charges: parsed.charges || [],
          baux: parsed.baux || [],
          etatsDesLieux: parsed.etatsDesLieux || [],
          documentsAdmin: parsed.documentsAdmin || [],
          documentsLocataires: parsed.documentsLocataires || [],
          credits: parsed.credits || [],
          bailModele: parsed.bailModele || '',
          bailRedactions: parsed.bailRedactions || [],
          facturesTravaux: parsed.facturesTravaux || [],
          bienGabarits: parsed.bienGabarits || [],
          edlRedactions: parsed.edlRedactions || [],
          edlModeles: parsed.edlModeles || [],
          annonceRedactions: parsed.annonceRedactions || [],
          candidatures: parsed.candidatures || [],
          visites: parsed.visites || [],
          reglagesAnnonce: parsed.reglagesAnnonce || Storage.mergeWithDefaults({}).reglagesAnnonce,
        });
        save();
        showView('dashboard');
        alert('Import terminé.');
      } catch (err) {
        console.error(err);
        alert('Fichier invalide.');
      }
    };
    reader.readAsText(file);
  }

  async function importZipBackup(file) {
    if (!confirm("Importer cette archive remplacera vos données actuelles, y compris les justificatifs déjà enregistrés. Continuer ?")) return;
    const btn = byId('btn-import');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Import en cours...";
    try {
      const zip = await JSZip.loadAsync(file);
      const donneesEntry = zip.file('donnees.json');
      if (!donneesEntry) { alert('Archive invalide : donnees.json introuvable.'); return; }
      const parsed = JSON.parse(await donneesEntry.async('string'));
      const manifestEntry = zip.file('manifest.json');
      const manifest = manifestEntry ? JSON.parse(await manifestEntry.async('string')) : {};

      for (const [fileId, info] of Object.entries(manifest)) {
        const entry = zip.file(info.path);
        if (!entry) continue;
        const arrayBuffer = await entry.async('arraybuffer');
        const blob = new Blob([arrayBuffer], { type: info.type || 'application/octet-stream' });
        await FilesDb.saveFile(fileId, blob);
      }

      Object.assign(data, {
        sci: parsed.sci || {},
        biens: parsed.biens || [],
        locataires: parsed.locataires || [],
        documents: parsed.documents || [],
        charges: parsed.charges || [],
        baux: parsed.baux || [],
        etatsDesLieux: parsed.etatsDesLieux || [],
        documentsAdmin: parsed.documentsAdmin || [],
        documentsLocataires: parsed.documentsLocataires || [],
        credits: parsed.credits || [],
        bailModele: parsed.bailModele || '',
        bailRedactions: parsed.bailRedactions || [],
        facturesTravaux: parsed.facturesTravaux || [],
        bienGabarits: parsed.bienGabarits || [],
        edlRedactions: parsed.edlRedactions || [],
        edlModeles: parsed.edlModeles || [],
        annonceRedactions: parsed.annonceRedactions || [],
        candidatures: parsed.candidatures || [],
        visites: parsed.visites || [],
        reglagesAnnonce: parsed.reglagesAnnonce || Storage.mergeWithDefaults({}).reglagesAnnonce,
      });
      save();
      showView('dashboard');
      alert('Import terminé.');
    } catch (err) {
      console.error(err);
      alert('Impossible de lire cette archive.');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  // ---------- Migration des fichiers existants vers le cloud (Phase 4 sync) ----------
  // Reprend les mêmes conteneurs que l'export ZIP, mais se contente de
  // collecter les fileId (pas de chemin/dossier nécessaire ici).
  function collectAllFileIds() {
    const ids = [];
    const addFrom = (record) => filesOf(record).forEach((f) => { if (f.fileId) ids.push(f.fileId); });
    data.charges.forEach(addFrom);
    data.baux.forEach(addFrom);
    data.etatsDesLieux.forEach(addFrom);
    data.documentsAdmin.forEach(addFrom);
    data.documentsLocataires.forEach(addFrom);
    data.credits.forEach(addFrom);
    data.facturesTravaux.forEach(addFrom);
    data.edlRedactions.forEach((r) => {
      r.pieces.forEach((room) => room.elements.forEach((el) => addFrom({ files: el.files || [] })));
      (r.compteurs || []).forEach((m) => addFrom({ files: m.files || [] }));
      (r.cles || []).forEach((c) => addFrom({ files: c.files || [] }));
    });
    return ids;
  }

  byId('btn-migrate-files').addEventListener('click', async () => {
    const uid = window.QfAuth && window.QfAuth.currentUser ? window.QfAuth.currentUser.uid : null;
    if (!uid || !window.QfFileSync) { alert('Vous devez être connecté pour synchroniser vos fichiers.'); return; }
    const btn = byId('btn-migrate-files');
    const status = byId('migrate-files-status');
    const ids = collectAllFileIds();
    btn.disabled = true;
    let done = 0, ok = 0, missing = 0, failed = 0;
    for (const fileId of ids) {
      status.textContent = `Envoi en cours... (${done}/${ids.length})`;
      try {
        const blob = await FilesDb.getFile(fileId);
        if (!blob) { missing++; } else {
          await window.QfFileSync.upload(uid, fileId, blob);
          ok++;
        }
      } catch (e) {
        console.error('Échec de la migration du fichier', fileId, e);
        failed++;
      }
      done++;
    }
    btn.disabled = false;
    status.textContent = `Terminé : ${ok} fichier(s) envoyé(s)${missing ? `, ${missing} introuvable(s) localement` : ''}${failed ? `, ${failed} échec(s)` : ''} sur ${ids.length}.`;
  });

  // ---------- Init ----------
  renderDashboard();
  renderGenererOptions();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        // Verifie a chaque ouverture s'il existe une version plus recente, et
        // recharge la page des qu'elle a pris la main. Sans cela, un appareil
        // pouvait rester sur une version ancienne tres longtemps (constate sur
        // iPhone, ou l'application est lancee depuis l'ecran d'accueil).
        reg.update().catch(() => { /* hors ligne : sans effet */ });
        reg.addEventListener('updatefound', () => {
          const nouveau = reg.installing;
          if (!nouveau) return;
          nouveau.addEventListener('statechange', () => {
            // Un seul rechargement automatique par session : si une nouvelle
            // version s'installait en boucle, la page se rechargerait sans fin.
            if (nouveau.state === 'installed' && navigator.serviceWorker.controller
                && !sessionStorage.getItem('qf_maj_rechargee')) {
              sessionStorage.setItem('qf_maj_rechargee', '1');
              window.location.reload();
            }
          });
        });
      }).catch(() => { /* file:// ou hors ligne : sans effet */ });
    });
  }

  // Reduit le risque que le navigateur (surtout mobile) libere le stockage local
  // sous pression memoire, ce qui perdrait photos/PDF archives dans IndexedDB.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => { /* sans effet si refuse */ });
  }
})();
