// Génération de vrais fichiers PDF (jsPDF) — mise en page tenant sur une seule page,
// sans en-tête/pied de page navigateur, avec intégration de la signature du bailleur.
const PdfBuilder = (function () {
  const PAGE_W = 595.28; // A4 en pt
  const PAGE_H = 841.89;
  const MARGIN = 56;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  function fmtEUR(n) {
    return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
  }

  function addWrapped(doc, text, x, y, maxWidth, lineHeight) {
    const lines = doc.splitTextToSize(text, maxWidth);
    doc.text(lines, x, y);
    return y + lines.length * lineHeight;
  }

  function drawHeader(doc, ctx, y) {
    doc.setFont('times', 'normal');
    doc.setFontSize(10);
    const bLines = (ctx.bailleurBlock || '').split('\n').filter(Boolean);
    const lLines = (ctx.locataireBlock || '').split('\n').filter(Boolean);
    bLines.forEach((line, i) => doc.text(line, MARGIN, y + i * 13));
    lLines.forEach((line, i) => doc.text(line, PAGE_W - MARGIN, y + i * 13, { align: 'right' }));
    let ny = y + Math.max(bLines.length, lLines.length) * 13 + 20;
    doc.setFontSize(9);
    doc.text(`${ctx.ville || ''}, le ${ctx.dateDuJour}`, PAGE_W - MARGIN, ny, { align: 'right' });
    return ny + 24;
  }

  function drawTitle(doc, title, subtitle, y) {
    doc.setFont('times', 'bold');
    doc.setFontSize(17);
    doc.text(title, PAGE_W / 2, y, { align: 'center' });
    y += 6;
    if (subtitle) {
      doc.setFont('times', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(90);
      doc.text(subtitle, PAGE_W / 2, y + 12, { align: 'center' });
      doc.setTextColor(20);
      y += 26;
    } else {
      y += 16;
    }
    return y;
  }

  function drawTable(doc, rows, y) {
    const rowH = 22;
    const labelW = CONTENT_W * 0.62;
    doc.setFontSize(9.5);
    rows.forEach((r, i) => {
      const ry = y + i * rowH;
      if (r.total) {
        doc.setFillColor(244, 244, 244);
        doc.rect(MARGIN, ry, CONTENT_W, rowH, 'F');
      }
      doc.setDrawColor(200);
      doc.rect(MARGIN, ry, labelW, rowH);
      doc.rect(MARGIN + labelW, ry, CONTENT_W - labelW, rowH);
      doc.setFont('times', r.total ? 'bold' : 'normal');
      doc.setTextColor(20);
      doc.text(r.label, MARGIN + 8, ry + rowH / 2 + 3.5);
      doc.text(r.value, MARGIN + CONTENT_W - 8, ry + rowH / 2 + 3.5, { align: 'right' });
    });
    doc.setFont('times', 'normal');
    return y + rows.length * rowH + 18;
  }

  function drawSignature(doc, ctx, y, label) {
    doc.setFont('times', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text(`Fait à ${ctx.ville || ''}, le ${ctx.dateDuJour}`, PAGE_W - MARGIN, y, { align: 'right' });
    doc.setFontSize(8.5);
    doc.setTextColor(120);
    doc.text(label, PAGE_W - MARGIN, y + 14, { align: 'right' });
    doc.setTextColor(20);
    if (ctx.signatureDataUrl) {
      try {
        const format = /^data:image\/png/i.test(ctx.signatureDataUrl) ? 'PNG' : 'JPEG';
        doc.addImage(ctx.signatureDataUrl, format, PAGE_W - MARGIN - 140, y + 20, 140, 55, undefined, 'FAST');
      } catch (e) {
        console.error('Impossible d\'ajouter la signature au PDF', e);
      }
    }
  }

  function quittance(doc, ctx) {
    let y = drawHeader(doc, ctx, 64);
    y = drawTitle(doc, 'QUITTANCE DE LOYER', `Période du ${ctx.periodeLabel}`, y);
    const total = (Number(ctx.loyer) || 0) + (Number(ctx.charges) || 0);
    doc.setFont('times', 'normal');
    doc.setFontSize(10.5);
    const body = `Je soussigné(e) ${ctx.bailleurNom}, propriétaire du logement désigné ci-dessous, déclare avoir reçu de ${ctx.locataireNom} la somme de ${fmtEUR(total)} € (${NumberToWords.amountToWords(total)}), au titre du paiement du loyer et des charges pour la période susmentionnée, et lui en donne quittance, sous réserve de tous mes droits antérieurs non atteints par la présente quittance.`;
    y = addWrapped(doc, body, MARGIN, y, CONTENT_W, 14.5) + 16;
    y = drawTable(doc, [
      { label: 'Logement concerné', value: (ctx.locationAdresse || '').replace(/\n/g, ', ') },
      { label: 'Loyer hors charges', value: fmtEUR(ctx.loyer) + ' €' },
      { label: 'Provisions pour charges', value: fmtEUR(ctx.charges) + ' €' },
      { label: 'Total payé', value: fmtEUR(total) + ' €', total: true },
    ], y);
    doc.setFontSize(8);
    doc.setTextColor(110);
    y = addWrapped(
      doc,
      "Cette quittance annule tout reçu qui aurait pu être établi précédemment en cas de paiement partiel du terme concerné. À conserver par le locataire pendant 3 ans après son départ du logement.",
      MARGIN, y, CONTENT_W, 11
    );
    doc.setTextColor(20);
    drawSignature(doc, ctx, y + 26, 'Signature du bailleur');
  }

  function recuPartiel(doc, ctx) {
    let y = drawHeader(doc, ctx, 64);
    y = drawTitle(doc, 'REÇU DE PAIEMENT PARTIEL', `Période du ${ctx.periodeLabel}`, y);
    const totalDu = Number(ctx.totalDu) || 0;
    const paye = Number(ctx.montantPaye) || 0;
    const solde = Math.max(0, totalDu - paye);
    doc.setFont('times', 'normal');
    doc.setFontSize(10.5);
    const body = `Je soussigné(e) ${ctx.bailleurNom}, propriétaire du logement désigné ci-dessous, déclare avoir reçu de ${ctx.locataireNom} la somme de ${fmtEUR(paye)} € (${NumberToWords.amountToWords(paye)}), à valoir sur le loyer et les charges dus au titre de la période susmentionnée. Ce paiement partiel ne vaut pas quittance pour la totalité du terme.`;
    y = addWrapped(doc, body, MARGIN, y, CONTENT_W, 14.5) + 16;
    y = drawTable(doc, [
      { label: 'Logement concerné', value: (ctx.locationAdresse || '').replace(/\n/g, ', ') },
      { label: 'Total dû pour la période', value: fmtEUR(totalDu) + ' €' },
      { label: 'Montant payé ce jour', value: fmtEUR(paye) + ' €' },
      { label: 'Solde restant dû', value: fmtEUR(solde) + ' €', total: true },
    ], y);
    drawSignature(doc, ctx, y + 26, 'Signature du bailleur');
  }

  function relance(doc, ctx) {
    let y = drawHeader(doc, ctx, 64);
    y = drawTitle(doc, 'RELANCE POUR IMPAYÉ', null, y);
    const impaye = Number(ctx.montantImpaye) || 0;
    doc.setFont('times', 'normal');
    doc.setFontSize(10.5);
    y = addWrapped(doc, 'Madame, Monsieur,', MARGIN, y, CONTENT_W, 14.5) + 12;
    const p1 = `Sauf erreur ou omission de notre part, votre compte locataire concernant le logement situé ${(ctx.locationAdresse || '').replace(/\n/g, ', ')} fait apparaître à ce jour un solde débiteur de ${fmtEUR(impaye)} € (${NumberToWords.amountToWords(impaye)}).`;
    y = addWrapped(doc, p1, MARGIN, y, CONTENT_W, 14.5) + 14;
    const p2 = "Nous vous remercions de bien vouloir régulariser cette situation dans les meilleurs délais. À défaut de règlement de votre part, nous nous verrions contraints de mettre en œuvre les dispositions prévues par le contrat de bail et la législation en vigueur.";
    y = addWrapped(doc, p2, MARGIN, y, CONTENT_W, 14.5) + 14;
    const p3 = "Restant à votre disposition pour tout renseignement complémentaire, nous vous prions d'agréer, Madame, Monsieur, l'expression de nos salutations distinguées.";
    y = addWrapped(doc, p3, MARGIN, y, CONTENT_W, 14.5) + 20;
    drawSignature(doc, ctx, y + 20, 'Signature du bailleur');
  }

  function avenant(doc, ctx) {
    let y = 60;
    doc.setFont('times', 'bold');
    doc.setFontSize(16);
    doc.text('AVENANT AU CONTRAT DE LOCATION', PAGE_W / 2, y, { align: 'center' });
    y += 18;
    doc.setFont('times', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(90);
    doc.text('Loi Alur n° 89-462 du 6 juillet 1989', PAGE_W / 2, y, { align: 'center' });
    doc.setTextColor(20);
    y += 28;

    doc.setFont('times', 'bold');
    doc.setFontSize(11);
    doc.text('Entre les soussignés', MARGIN, y);
    y += 20;

    doc.setFont('times', 'normal');
    doc.setFontSize(10.5);
    const bailleurTxt = `${ctx.sciNom}, société civile immobilière au capital de ${ctx.sciCapital} euros, immatriculée au RCS de ${ctx.sciRcsVille} sous le numéro ${ctx.sciSiret} et dont le siège social est à ${(ctx.sciAdresse || '').replace(/\n/g, ', ')}, représentée par ${ctx.gerant}, gérant et régulièrement habilité à l'effet des présentes en vertu des statuts.`;
    y = addWrapped(doc, bailleurTxt, MARGIN, y, CONTENT_W, 14.5) + 12;
    y = addWrapped(doc, "Ci-après dénommé « le bailleur » d'une part", MARGIN, y, CONTENT_W, 14.5) + 16;

    const locataireTxt = `Et ${ctx.locataireNom}, né(e) à ${ctx.locataireNaissanceLieu || '—'} le ${ctx.locataireNaissanceDate || '—'}, demeurant à ${(ctx.locataireAdresse || '').replace(/\n/g, ', ')}.`;
    y = addWrapped(doc, locataireTxt, MARGIN, y, CONTENT_W, 14.5) + 12;
    y = addWrapped(doc, 'Ci-après dénommé « les locataires » d\'autre part.', MARGIN, y, CONTENT_W, 14.5) + 20;

    y = addWrapped(doc, 'Il a été arrêté et convenu ce qui suit,', MARGIN, y, CONTENT_W, 14.5) + 16;

    doc.setFont('times', 'bold');
    y = addWrapped(doc, "Objet de l'avenant", MARGIN, y, CONTENT_W, 14.5) + 2;
    doc.setFont('times', 'normal');
    y = addWrapped(doc, `Cet avenant a pour objet de modifier le contrat initial signé le : ${ctx.dateContratInitial || '—'} entre les parties susmentionnées.`, MARGIN, y, CONTENT_W, 14.5) + 16;

    doc.setFont('times', 'bold');
    y = addWrapped(doc, 'Modifications apportées', MARGIN, y, CONTENT_W, 14.5) + 2;
    doc.setFont('times', 'normal');
    y = addWrapped(doc, 'Les modifications suivantes sont apportées au contrat initial :', MARGIN, y, CONTENT_W, 14.5) + 12;

    const totalWords = NumberToWords.amountToWords(ctx.totalCharges).toUpperCase();
    y = addWrapped(doc, `Provisions sur charges d'un montant de ${fmtEUR(ctx.totalCharges)} euros (${totalWords}) comprenant :`, MARGIN, y, CONTENT_W, 14.5) + 8;

    (ctx.chargeLines || []).forEach((l) => {
      const line = `-  ${l.libelle || ''} : ${fmtEUR(l.montant)} euros${l.note ? ' ' + l.note : ''}`;
      y = addWrapped(doc, line, MARGIN + 10, y, CONTENT_W - 10, 14) + 2;
    });
    y += 12;

    doc.setFontSize(8.5);
    doc.setTextColor(100);
    y = addWrapped(doc, 'Il est rappelé que la provision sur charges est révisable chaque année en fonction des dépenses réelles.', MARGIN, y, CONTENT_W, 11) + 16;
    doc.setTextColor(20);
    doc.setFontSize(10.5);

    doc.setFont('times', 'bold');
    y = addWrapped(doc, "Prise d'effet et durée", MARGIN, y, CONTENT_W, 14.5) + 2;
    doc.setFont('times', 'normal');
    y = addWrapped(doc, `Le présent avenant commence à courir le ${ctx.dateEffet || '—'}`, MARGIN, y, CONTENT_W, 14.5) + 16;

    y = addWrapped(doc, 'Toutes les autres dispositions du contrat initial non modifiées par le présent avenant restent en vigueur et pleinement applicables.', MARGIN, y, CONTENT_W, 14.5) + 20;

    y = addWrapped(doc, `Fait à ${ctx.ville || ''}, le ${ctx.dateDuJour}`, MARGIN, y, CONTENT_W, 14.5) + 30;

    doc.setFont('times', 'bold');
    doc.text('Le bailleur', MARGIN, y);
    doc.text('Le locataire', PAGE_W / 2 + 20, y);
    doc.setFont('times', 'normal');
    if (ctx.signatureDataUrl) {
      try {
        const format = /^data:image\/png/i.test(ctx.signatureDataUrl) ? 'PNG' : 'JPEG';
        doc.addImage(ctx.signatureDataUrl, format, MARGIN, y + 10, 130, 50, undefined, 'FAST');
      } catch (e) {
        console.error('Impossible d\'ajouter la signature au PDF', e);
      }
    }
  }

  // Titre de section souligné, pour les documents à remplir à la main.
  function drawSection(doc, titre, y) {
    doc.setFont('times', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(20);
    doc.text(titre, MARGIN, y);
    doc.setDrawColor(120);
    doc.line(MARGIN, y + 3.5, MARGIN + CONTENT_W, y + 3.5);
    doc.setFont('times', 'normal');
    return y + 17;
  }

  // Une ligne de champs vierges : le libellé, puis un trait jusqu'au champ
  // suivant. Les colonnes se partagent la largeur utile à parts égales.
  function drawFields(doc, labels, y) {
    const colW = CONTENT_W / labels.length;
    doc.setFont('times', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(20);
    doc.setDrawColor(175);
    labels.forEach((label, i) => {
      const x = MARGIN + i * colW;
      doc.text(label, x, y);
      const debut = x + doc.getTextWidth(label) + 5;
      const fin = x + colW - (i === labels.length - 1 ? 0 : 12);
      if (fin > debut) doc.line(debut, y + 2, fin, y + 2);
    });
    return y + 19;
  }

  // Fiche vierge remise au candidat. Volontairement sans « régime matrimonial »
  // ni « lieu de mariage » : l'article 1751 du Code civil rend les époux
  // cotitulaires du bail quel que soit leur régime, et le contrat de mariage
  // fait partie des pièces dont la remise est interdite. Le remboursement de
  // prêts reste demandé en déclaratif — c'est le justificatif qui est interdit,
  // pas le renseignement.
  function ficheRenseignements(doc, ctx) {
    const montant = (v) => (v === null || v === undefined || v === '' ? '—' : fmtEUR(v) + ' €');
    let y = 58;
    y = drawTitle(doc, 'FICHE DE RENSEIGNEMENTS', ctx.sciNom ? `${ctx.sciNom} — candidature à la location` : 'Candidature à la location', y);

    doc.setFont('times', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(110);
    y = addWrapped(
      doc,
      "À remplir par le candidat. Ces informations servent uniquement à l'examen de la candidature et sont détruites en cas de refus. Aucun document autre que ceux listés en bas de page ne peut être exigé (décret n° 2015-1437 du 5 novembre 2015).",
      MARGIN, y, CONTENT_W, 10.5
    ) + 10;
    doc.setTextColor(20);

    y = drawTable(doc, [
      { label: 'Logement concerné', value: (ctx.locationAdresse || ctx.bienNom || '').replace(/\n/g, ', ') },
      { label: 'Loyer hors charges', value: montant(ctx.loyer) },
      { label: 'Provisions pour charges', value: montant(ctx.charges) },
      { label: 'Dépôt de garantie', value: montant(ctx.depotGarantie), total: true },
    ], y);

    y = drawSection(doc, 'Candidat', y);
    y = drawFields(doc, ['Nom et prénom :'], y);
    y = drawFields(doc, ['Né(e) le :', 'à :'], y);
    y = drawFields(doc, ['Téléphone :', 'Adresse e-mail :'], y);
    y = drawFields(doc, ['Adresse actuelle :'], y);
    y = drawFields(doc, ['Situation actuelle (locataire, propriétaire, hébergé) :'], y);
    y = drawFields(doc, ['Situation familiale (marié, pacsé, concubin, seul) :', 'Personnes à charge :'], y);

    y = drawSection(doc, 'Second candidat (le cas échéant)', y);
    y = drawFields(doc, ['Nom et prénom :'], y);
    y = drawFields(doc, ['Né(e) le :', 'à :'], y);
    y = drawFields(doc, ['Téléphone :', 'Adresse e-mail :'], y);

    y = drawSection(doc, 'Situation professionnelle et ressources', y);
    y = drawFields(doc, ['Profession :', 'Employeur :'], y);
    y = drawFields(doc, ['Type de contrat :', 'Depuis le :'], y);
    y = drawFields(doc, ['Revenus mensuels nets :', 'Autres ressources (nature, montant) :'], y);
    y = drawFields(doc, ['Ressources du second candidat :', 'Profession :'], y);

    y = drawSection(doc, 'Charges déclarées', y);
    y = drawFields(doc, ['Remboursement de prêts (par mois) :', 'Pension versée :'], y);

    y = drawSection(doc, 'Garant (le cas échéant)', y);
    y = drawFields(doc, ['Nom et prénom :', 'Profession :'], y);
    y = drawFields(doc, ['Adresse :', 'Revenus mensuels nets :'], y);

    y = drawSection(doc, 'Pièces à joindre', y);
    doc.setFontSize(9.5);
    [
      "Pièce d'identité en cours de validité, recto-verso",
      'Trois derniers bulletins de salaire',
      "Deux derniers avis d'imposition",
      'Trois dernières quittances de loyer, ou avis de taxe foncière si vous êtes propriétaire',
    ].forEach((p) => {
      y = addWrapped(doc, '-  ' + p, MARGIN + 6, y, CONTENT_W - 6, 13) + 1;
    });
    y += 14;

    doc.setFontSize(10);
    doc.text('Fait à …………………………………………, le ……… / ……… / …………', MARGIN, y);
    doc.setFontSize(8.5);
    doc.setTextColor(120);
    doc.text('Signature du ou des candidats', PAGE_W - MARGIN, y, { align: 'right' });
    doc.setTextColor(20);
  }

  function libre(doc, ctx) {
    let y = drawHeader(doc, ctx, 64);
    y = drawTitle(doc, ctx.objet || 'Courrier', null, y);
    doc.setFont('times', 'normal');
    doc.setFontSize(10.5);
    y = addWrapped(doc, ctx.message || '', MARGIN, y, CONTENT_W, 14.5) + 20;
    drawSignature(doc, ctx, y + 20, 'Signature');
  }

  function generate(type, ctx) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const full = Object.assign({ dateDuJour: Documents.todayFR() }, ctx);
    if (type === 'quittance') quittance(doc, full);
    else if (type === 'recu-partiel') recuPartiel(doc, full);
    else if (type === 'relance') relance(doc, full);
    else if (type === 'avenant') avenant(doc, full);
    else if (type === 'libre') libre(doc, full);
    else if (type === 'fiche-renseignements') ficheRenseignements(doc, full);
    return doc;
  }

  function slug(str) {
    return String(str || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '')
      .toLowerCase();
  }

  function filename(type, ctx) {
    // La fiche est vierge : elle est nommée d'après le bien, pas d'un locataire.
    if (type === 'fiche-renseignements') {
      const bien = slug(ctx.bienNom);
      return 'fiche-renseignements' + (bien ? '-' + bien : '') + '.pdf';
    }
    const typeSlug = { quittance: 'quittance', 'recu-partiel': 'recu-partiel', relance: 'relance', avenant: 'avenant', libre: 'courrier' }[type] || 'document';
    const per = ctx.periode ? `-${ctx.periode}` : '';
    return `${typeSlug}-${slug(ctx.locataireNom)}${per}.pdf`;
  }

  return { generate, filename };
})();
