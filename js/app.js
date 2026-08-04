(function () {
  const data = Storage.load();

  // ---------- Utilities ----------
  function save() {
    const ok = Storage.save(data);
    if (!ok) {
      alert("⚠️ La sauvegarde a échoué (stockage plein ou indisponible). Vos dernières modifications n'ont probablement PAS été enregistrées.\n\nExportez vos données immédiatement (bouton \"Exporter mes données (.zip)\" dans le menu de gauche) avant de continuer, puis libérez de la place si besoin.");
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

  // Hachage simple (non cryptographique) du code de verrouillage : évite de stocker
  // le code en clair dans localStorage. Ce verrou est un frein à l'accès de passage,
  // pas une vraie protection (le code source de l'appli est public).
  function simpleHash(str) {
    const input = 'qf-lock-2025:' + str;
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i++) {
      const ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
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
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  document.querySelectorAll('.nav-group-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const subgroup = document.getElementById(`nav-subgroup-${btn.dataset.toggleGroup}`);
      if (!subgroup) return;
      const collapsed = subgroup.classList.toggle('collapsed');
      btn.classList.toggle('collapsed', collapsed);
    });
  });

  function showView(view) {
    const isCharges = view.indexOf('charges-') === 0;
    const isDocsAdmin = view.indexOf('docsadmin-') === 0;
    const isCredits = view.indexOf('credits-') === 0;
    const isFacturesTravaux = view.indexOf('facturestravaux-') === 0;
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
  }

  document.querySelectorAll('[data-action="quick-quittance"]').forEach((b) => b.addEventListener('click', () => showView('generer')));
  document.querySelectorAll('[data-action="quick-edl"]').forEach((b) => b.addEventListener('click', () => showView('edl-redaction')));
  document.querySelectorAll('[data-action="quick-locataire"], [data-action="new-locataire"]').forEach((b) => b.addEventListener('click', () => openLocataireModal()));
  document.querySelectorAll('[data-action="quick-bien"], [data-action="new-bien"]').forEach((b) => b.addEventListener('click', () => openBienModal()));

  // ---------- Dashboard ----------
  function renderDashboard() {
    byId('stat-biens').textContent = data.biens.length;
    byId('stat-locataires').textContent = data.locataires.filter((l) => l.actif !== false).length;

    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const moisTotal = data.documents
      .filter((d) => d.periode === ym && (d.type === 'quittance' || d.type === 'recu-partiel'))
      .reduce((sum, d) => sum + (Number(d.montant) || 0), 0);
    byId('stat-mois').textContent = euros(moisTotal);
    byId('stat-docs').textContent = data.documents.length;

    const tbody = document.querySelector('#dashboard-recent tbody');
    tbody.innerHTML = '';
    const recent = [...data.documents].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
    if (recent.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Aucun document généré pour le moment.</td></tr>';
    } else {
      recent.forEach((d) => {
        tbody.innerHTML += `<tr>
          <td>${d.dateLabel}</td>
          <td>${DOC_LABELS[d.type] || d.type}</td>
          <td>${escapeHTML(d.locataireNom)}</td>
          <td>${escapeHTML(d.periodeLabel || '—')}</td>
          <td>${d.montant != null ? euros(d.montant) : '—'}</td>
        </tr>`;
      });
    }
  }

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
      <button class="btn btn-primary" id="m-bien-save">${isEdit ? 'Enregistrer' : 'Ajouter'}</button>
    `);
    if (isEdit) {
      byId('m-bien-nom').value = existing.nom || '';
      byId('m-bien-adresse').value = existing.adresse || '';
      byId('m-bien-loyer').value = existing.loyer || 0;
      byId('m-bien-charges').value = existing.charges || 0;
    }
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

  // Supprimer un locataire supprime aussi tout ce qui lui est rattache (sinon ces
  // enregistrements deviennent invisibles mais restent en stockage indefiniment,
  // avec leurs fichiers/photos orphelins dans IndexedDB).
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

    const warning = totalRelated > 0
      ? `Supprimer « ${loc.nom} » supprimera aussi définitivement ${totalRelated} élément(s) associé(s) (documents générés, baux, états des lieux, rédactions...) et leurs pièces jointes. Continuer ?`
      : 'Supprimer ce locataire ?';
    if (!confirm(warning)) return;

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
    } else {
      const b = data.biens[0];
      byId('m-loc-loyer').value = b.loyer || 0;
      byId('m-loc-charges').value = b.charges || 0;
    }
    byId('m-loc-bien').addEventListener('change', () => {
      const b = bienById(byId('m-loc-bien').value);
      if (b && !isEdit) {
        byId('m-loc-loyer').value = b.loyer || 0;
        byId('m-loc-charges').value = b.charges || 0;
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
  function renderHistorique() {
    const tbody = document.querySelector('#table-historique tbody');
    tbody.innerHTML = '';
    if (data.documents.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Aucun document dans l\'historique.</td></tr>';
      return;
    }
    const sorted = [...data.documents].sort((a, b) => b.createdAt - a.createdAt);
    sorted.forEach((d) => {
      tbody.innerHTML += `<tr>
        <td>${d.dateLabel}</td>
        <td>${DOC_LABELS[d.type] || d.type}</td>
        <td>${escapeHTML(d.locataireNom)}</td>
        <td>${escapeHTML(d.periodeLabel || '—')}</td>
        <td>${d.montant != null ? euros(d.montant) : '—'}</td>
        <td class="actions-cell">
          <button class="btn btn-sm" data-view-doc="${d.id}">Télécharger le PDF</button>
          <button class="btn btn-sm btn-danger" data-del-doc="${d.id}">Supprimer</button>
        </td>
      </tr>`;
    });
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
    const fullCtx = Object.assign({}, ctx, { signatureDataUrl: data.sci.signature || '' });
    const doc = PdfBuilder.generate(type, fullCtx);
    doc.save(PdfBuilder.filename(type, fullCtx));
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
    renderLockStatus();
    byId('lock-new-code').value = '';
    byId('lock-new-code-confirm').value = '';
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

  // ---------- Verrouillage de l'application ----------
  const LOCK_KEY = 'qf_lock_hash';

  function renderLockStatus() {
    const hasLock = !!localStorage.getItem(LOCK_KEY);
    byId('lock-status').textContent = hasLock ? 'Verrouillage activé' : 'Aucun code défini';
  }

  byId('btn-lock-save').addEventListener('click', () => {
    const code = byId('lock-new-code').value.trim();
    const confirm2 = byId('lock-new-code-confirm').value.trim();
    if (!code) { alert('Renseignez un code.'); return; }
    if (code.length < 4) { alert('Le code doit contenir au moins 4 caractères.'); return; }
    if (code !== confirm2) { alert('Les deux codes ne correspondent pas.'); return; }
    localStorage.setItem(LOCK_KEY, simpleHash(code));
    byId('lock-new-code').value = '';
    byId('lock-new-code-confirm').value = '';
    renderLockStatus();
    alert('Code enregistré. Il sera demandé au prochain chargement de l\'application.');
  });

  byId('btn-lock-remove').addEventListener('click', () => {
    if (!localStorage.getItem(LOCK_KEY)) { alert('Aucun verrouillage actif.'); return; }
    if (!confirm('Désactiver le verrouillage de l\'application ?')) return;
    localStorage.removeItem(LOCK_KEY);
    renderLockStatus();
    alert('Verrouillage désactivé.');
  });

  function attemptUnlock() {
    const input = byId('lock-code-input');
    const stored = localStorage.getItem(LOCK_KEY);
    if (!stored || simpleHash(input.value) === stored) {
      document.documentElement.classList.remove('qf-locked');
      byId('lock-error').hidden = true;
      input.value = '';
    } else {
      byId('lock-error').hidden = false;
      input.value = '';
      input.focus();
    }
  }

  byId('lock-unlock-btn').addEventListener('click', attemptUnlock);
  byId('lock-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptUnlock();
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

  function updateDocFieldsVisibility() {
    const type = typeSelect.value;
    byId('fields-quittance').hidden = type !== 'quittance';
    byId('fields-recu-partiel').hidden = type !== 'recu-partiel';
    byId('fields-relance').hidden = type !== 'relance';
    byId('fields-avenant').hidden = type !== 'avenant';
    byId('fields-libre').hidden = type !== 'libre';
    byId('field-periode').hidden = type === 'libre' || type === 'avenant';
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
    const periodeLabel = type === 'libre' ? '' : Documents.periodLabel(periode);

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
      ctx.loyer = parseFloat(byId('doc-loyer').value) || 0;
      ctx.charges = parseFloat(byId('doc-charges').value) || 0;
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

    lastGenerated = { type, locataireId: l.id, locataireNom: l.nom, periode, periodeLabel, montant, ctx };
  });

  byId('btn-download-pdf').addEventListener('click', () => {
    if (!lastGenerated) return;
    downloadPdf(lastGenerated.type, lastGenerated.ctx);

    const now = new Date();
    data.documents.push({
      id: Storage.uid(),
      createdAt: now.getTime(),
      dateLabel: now.toLocaleDateString('fr-FR'),
      ...lastGenerated,
    });
    save();
    renderDashboard();
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
    renderFacturesTravauxTable();
  }

  function renderFacturesTravauxTable() {
    const tbody = document.querySelector('#facturestravaux-table tbody');
    const docs = data.facturesTravaux
      .filter((d) => d.categorie === currentFacturesTravauxCategory)
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
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-danger" data-del-facturestravaux="${d.id}">Supprimer</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-view-file]').forEach((btn) => btn.addEventListener('click', () => openStoredFile(btn.dataset.viewFile, btn.title)));
    tbody.querySelectorAll('[data-del-facturestravaux]').forEach((btn) => btn.addEventListener('click', () => deleteFacturesTravaux(btn.dataset.delFacturestravaux)));
  }

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
  ];
  let currentRedactionDraftId = null;
  // Avertit avant fermeture/rechargement de l'onglet si un brouillon (bail ou EDL)
  // n'a pas ete enregistre depuis sa creation/derniere modification.
  let hasUnsavedWork = false;
  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedWork) return;
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

  byId('btn-edl-gabarit-save').addEventListener('click', () => {
    const bienId = byId('edl-gabarit-bien').value;
    if (!bienId) { alert("Ajoutez d'abord un bien, puis sélectionnez-le."); return; }
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

  function renderEdlRedacRooms() {
    const container = byId('edl-redac-rooms');
    container.innerHTML = '';
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
    const hasMeters = !!(currentEdlRedaction && currentEdlRedaction.compteurs && currentEdlRedaction.compteurs.length > 0);
    byId('edl-redac-meters-title').hidden = !hasMeters;
    if (!hasMeters) return;
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
    const hasCles = !!(currentEdlRedaction && currentEdlRedaction.cles && currentEdlRedaction.cles.length > 0);
    byId('edl-redac-cles-title').hidden = !hasCles;
    if (!hasCles) return;
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
    const bienId = byId('edl-gabarit-bien').value;
    const locataireId = byId('edl-redac-locataire').value;
    const date = byId('edl-redac-date').value;
    if (!bienId) { alert("Ajoutez d'abord un bien, puis sélectionnez-le."); return; }
    if (!locataireId) { alert("Ce bien n'a pas de locataire enregistré."); return; }
    if (!date) { alert('Renseignez une date.'); return; }
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
      signatureBailleur: '',
      signatureLocataire: '',
    };
    renderEdlRedacRooms();
    renderEdlRedacMeters();
    renderEdlRedacCles();
    updateEdlRedacLabels();
    updateEdlRedacCompareNote(entrant);
    renderEdlSignatureBailleur();
    renderEdlSignatureLocataire();
    byId('edl-redac-actions').hidden = false;
    hasUnsavedWork = true;
  });

  function captureCurrentEdlSignatures() {
    if (!currentEdlRedaction) return;
    if (!edlSigCanvas.hidden && edlSigHasStroke) {
      currentEdlRedaction.signatureLocataire = edlSigCanvas.toDataURL('image/png');
    }
    currentEdlRedaction.signatureBailleur = data.sci.signature || '';
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
      signatureBailleur: r.signatureBailleur,
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
      doc.save(EdlPdf.filename(ctx));
      const blob = doc.output('blob');
      await archiveEdlPdf(r, blob, ctx);
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
    populateEdlGabaritBienSelect();
    renderEdlGabaritRooms();
    renderEdlGabaritMeters();
    renderEdlGabaritCles();
    populateEdlModeleSelect();
    populateEdlApplyModeleSelect();
    loadEdlModeleIntoEditor(byId('edl-modele-select').value);
    populateEdlRedacLocataireSelect();
    byId('edl-redac-date').value = todayISO();
    byId('edl-redac-libelle').value = '';
    currentEdlRedacSens = 'entrant';
    document.querySelectorAll('#edl-redac-type-toggle .toggle-btn').forEach((b) => b.classList.toggle('active', b.dataset.edlRedacType === 'entrant'));
    clearCurrentEdlRedaction();
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

  // ---------- Init ----------
  renderDashboard();
  renderGenererOptions();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* file:// ou hors ligne : sans effet */ });
    });
  }

  // Reduit le risque que le navigateur (surtout mobile) libere le stockage local
  // sous pression memoire, ce qui perdrait photos/PDF archives dans IndexedDB.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => { /* sans effet si refuse */ });
  }
})();
