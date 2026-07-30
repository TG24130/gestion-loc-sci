// Génération du HTML des documents (quittance, reçu partiel, relance, courrier libre).
const Documents = (function () {
  const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  function fmtEUR(n) {
    return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
  }

  function todayFR() {
    const d = new Date();
    return d.getDate() + ' ' + MONTHS_FR[d.getMonth()] + ' ' + d.getFullYear();
  }

  function periodLabel(monthValue) {
    if (!monthValue) return '';
    const [y, m] = monthValue.split('-').map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0);
    const startStr = (start.getDate() === 1 ? '1er' : start.getDate()) + ' ' + MONTHS_FR[start.getMonth()] + ' ' + start.getFullYear();
    const endStr = end.getDate() + ' ' + MONTHS_FR[end.getMonth()] + ' ' + end.getFullYear();
    return startStr + ' au ' + endStr;
  }

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function nl2br(str) {
    return escapeHTML(str).replace(/\n/g, '<br>');
  }

  function oneLine(str) {
    return escapeHTML(String(str || '').replace(/\n/g, ', '));
  }

  function header(ctx) {
    return `
      <div class="doc-header">
        <div class="doc-from">${nl2br(ctx.bailleurBlock)}</div>
        <div class="doc-to">${nl2br(ctx.locataireBlock)}</div>
      </div>
      <div class="doc-place-date">${escapeHTML(ctx.ville || '')}, le ${ctx.dateDuJour}</div>
    `;
  }

  function signatureBlock(ctx, label) {
    const img = ctx.signatureDataUrl
      ? `<img src="${ctx.signatureDataUrl}" class="doc-signature-img" alt="Signature">`
      : '';
    return `<div class="doc-signature">Fait à ${escapeHTML(ctx.ville || '')}, le ${ctx.dateDuJour}<span class="sign-label">${label}</span>${img}</div>`;
  }

  function quittance(ctx) {
    const total = (Number(ctx.loyer) || 0) + (Number(ctx.charges) || 0);
    return `
      <div class="doc">
        ${header(ctx)}
        <h1 class="doc-title">Quittance de loyer</h1>
        <p class="doc-subtitle">Période du ${ctx.periodeLabel}</p>
        <p class="doc-body">
          Je soussigné(e) <strong>${escapeHTML(ctx.bailleurNom)}</strong>, propriétaire du logement désigné ci-dessous,
          déclare avoir reçu de <strong>${escapeHTML(ctx.locataireNom)}</strong> la somme de
          <strong>${fmtEUR(total)} €</strong> (${NumberToWords.amountToWords(total)}), au titre du paiement du loyer
          et des charges pour la période susmentionnée, et lui en donne quittance, sous réserve de tous mes droits
          antérieurs non atteints par la présente quittance.
        </p>
        <table class="doc-table">
          <tr><td>Logement concerné</td><td>${oneLine(ctx.locationAdresse)}</td></tr>
          <tr><td>Loyer hors charges</td><td>${fmtEUR(ctx.loyer)} €</td></tr>
          <tr><td>Provisions pour charges</td><td>${fmtEUR(ctx.charges)} €</td></tr>
          <tr class="total"><td>Total payé</td><td>${fmtEUR(total)} €</td></tr>
        </table>
        <p class="doc-note">
          Cette quittance annule tout reçu qui aurait pu être établi précédemment en cas de paiement partiel du
          terme concerné. À conserver par le locataire pendant 3 ans après son départ du logement.
        </p>
        ${signatureBlock(ctx, 'Signature du bailleur')}
      </div>
    `;
  }

  function recuPartiel(ctx) {
    const totalDu = Number(ctx.totalDu) || 0;
    const paye = Number(ctx.montantPaye) || 0;
    const solde = Math.max(0, totalDu - paye);
    return `
      <div class="doc">
        ${header(ctx)}
        <h1 class="doc-title">Reçu de paiement partiel</h1>
        <p class="doc-subtitle">Période du ${ctx.periodeLabel}</p>
        <p class="doc-body">
          Je soussigné(e) <strong>${escapeHTML(ctx.bailleurNom)}</strong>, propriétaire du logement désigné ci-dessous,
          déclare avoir reçu de <strong>${escapeHTML(ctx.locataireNom)}</strong> la somme de
          <strong>${fmtEUR(paye)} €</strong> (${NumberToWords.amountToWords(paye)}), à valoir sur le loyer et les
          charges dus au titre de la période susmentionnée. Ce paiement partiel ne vaut pas quittance pour la
          totalité du terme.
        </p>
        <table class="doc-table">
          <tr><td>Logement concerné</td><td>${oneLine(ctx.locationAdresse)}</td></tr>
          <tr><td>Total dû pour la période</td><td>${fmtEUR(totalDu)} €</td></tr>
          <tr><td>Montant payé ce jour</td><td>${fmtEUR(paye)} €</td></tr>
          <tr class="total"><td>Solde restant dû</td><td>${fmtEUR(solde)} €</td></tr>
        </table>
        ${signatureBlock(ctx, 'Signature du bailleur')}
      </div>
    `;
  }

  function relance(ctx) {
    const impaye = Number(ctx.montantImpaye) || 0;
    return `
      <div class="doc">
        ${header(ctx)}
        <h1 class="doc-title">Relance pour impayé</h1>
        <p class="doc-body">
          Madame, Monsieur,
        </p>
        <p class="doc-body">
          Sauf erreur ou omission de notre part, votre compte locataire concernant le logement situé
          ${oneLine(ctx.locationAdresse)} fait apparaître à ce jour un solde débiteur de
          <strong>${fmtEUR(impaye)} €</strong> (${NumberToWords.amountToWords(impaye)}).
        </p>
        <p class="doc-body">
          Nous vous remercions de bien vouloir régulariser cette situation dans les meilleurs délais. À défaut de
          règlement de votre part, nous nous verrions contraints de mettre en œuvre les dispositions prévues par le
          contrat de bail et la législation en vigueur.
        </p>
        <p class="doc-body">
          Restant à votre disposition pour tout renseignement complémentaire, nous vous prions d'agréer, Madame,
          Monsieur, l'expression de nos salutations distinguées.
        </p>
        ${signatureBlock(ctx, 'Signature du bailleur')}
      </div>
    `;
  }

  function avenant(ctx) {
    const lignesHtml = (ctx.chargeLines || []).map((l) => {
      const montant = fmtEUR(l.montant) + ' €';
      const note = l.note ? ` ${escapeHTML(l.note)}` : '';
      return `<li>${escapeHTML(l.libelle || '')} : ${montant}${note}</li>`;
    }).join('');

    return `
      <div class="doc">
        <h1 class="doc-title">Avenant au contrat de location</h1>
        <p class="doc-subtitle">Loi Alur n° 89-462 du 6 juillet 1989</p>

        <p class="doc-body"><strong>Entre les soussignés</strong></p>

        <p class="doc-body">
          ${escapeHTML(ctx.sciNom)}, société civile immobilière au capital de ${escapeHTML(ctx.sciCapital)} euros,
          immatriculée au RCS de ${escapeHTML(ctx.sciRcsVille)} sous le numéro ${escapeHTML(ctx.sciSiret)} et dont le
          siège social est à ${oneLine(ctx.sciAdresse)}, représentée par ${escapeHTML(ctx.gerant)}, gérant et
          régulièrement habilité à l'effet des présentes en vertu des statuts.
        </p>
        <p class="doc-body">Ci-après dénommé « le bailleur » d'une part</p>

        <p class="doc-body">
          Et ${escapeHTML(ctx.locataireNom)}, né(e) à ${escapeHTML(ctx.locataireNaissanceLieu) || '—'} le ${escapeHTML(ctx.locataireNaissanceDate) || '—'},
          demeurant à ${oneLine(ctx.locataireAdresse)}.
        </p>
        <p class="doc-body">Ci-après dénommé « les locataires » d'autre part.</p>

        <p class="doc-body">Il a été arrêté et convenu ce qui suit,</p>

        <p class="doc-body"><strong>Objet de l'avenant</strong><br>
        Cet avenant a pour objet de modifier le contrat initial signé le : ${escapeHTML(ctx.dateContratInitial) || '—'} entre les parties susmentionnées.</p>

        <p class="doc-body"><strong>Modifications apportées</strong><br>
        Les modifications suivantes sont apportées au contrat initial :</p>

        <p class="doc-body">
          Provisions sur charges d'un montant de ${fmtEUR(ctx.totalCharges)} euros
          (${NumberToWords.amountToWords(ctx.totalCharges).toUpperCase()}) comprenant :
        </p>
        <ul class="doc-list">${lignesHtml}</ul>

        <p class="doc-note">Il est rappelé que la provision sur charges est révisable chaque année en fonction des dépenses réelles.</p>

        <p class="doc-body"><strong>Prise d'effet et durée</strong><br>
        Le présent avenant commence à courir le ${escapeHTML(ctx.dateEffet) || '—'}</p>

        <p class="doc-body">Toutes les autres dispositions du contrat initial non modifiées par le présent avenant restent en vigueur et pleinement applicables.</p>

        <p class="doc-body">Fait à ${escapeHTML(ctx.ville || '')}, le ${ctx.dateDuJour}</p>

        <div class="doc-signature-columns">
          <div class="doc-signature-col">
            <strong>Le bailleur</strong>
            ${ctx.signatureDataUrl ? `<img src="${ctx.signatureDataUrl}" class="doc-signature-img-inline" alt="Signature">` : ''}
          </div>
          <div class="doc-signature-col">
            <strong>Le locataire</strong>
          </div>
        </div>
      </div>
    `;
  }

  function libre(ctx) {
    return `
      <div class="doc">
        ${header(ctx)}
        <h1 class="doc-title">${escapeHTML(ctx.objet || 'Courrier')}</h1>
        <p class="doc-body">${nl2br(ctx.message || '')}</p>
        ${signatureBlock(ctx, 'Signature')}
      </div>
    `;
  }

  function build(type, ctx) {
    const full = Object.assign({ dateDuJour: todayFR() }, ctx);
    switch (type) {
      case 'quittance': return quittance(full);
      case 'recu-partiel': return recuPartiel(full);
      case 'relance': return relance(full);
      case 'avenant': return avenant(full);
      case 'libre': return libre(full);
      default: return '';
    }
  }

  return { build, fmtEUR, todayFR, periodLabel };
})();
