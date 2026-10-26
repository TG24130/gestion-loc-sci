// Génération du HTML des documents (quittance, reçu partiel, relance, mise en demeure, courrier libre).
const Documents = (function () {
  const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  function fmtEUR(n) {
    return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
  }

  function todayFR() {
    const d = new Date();
    return d.getDate() + ' ' + MONTHS_FR[d.getMonth()] + ' ' + d.getFullYear();
  }

  // nbMois = 1 (mensuel) ou 3 (trimestriel) : la periode couverte va du 1er du
  // mois choisi au dernier jour du dernier mois du trimestre.
  function periodLabel(monthValue, nbMois) {
    if (!monthValue) return '';
    const duree = Number(nbMois) > 0 ? Number(nbMois) : 1;
    const [y, m] = monthValue.split('-').map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m - 1 + duree, 0);
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

  // Le nom saisi porte déjà la civilité (« Mr Chabrier », « Mme Lavoix ») :
  // les courriers d'impayé s'adressent au locataire par ce nom plutôt que par
  // « Madame, Monsieur », conservé seulement si le nom manque.
  function appelLocataire(ctx) {
    return String(ctx.locataireNom || '').trim() || 'Madame, Monsieur';
  }

  function relance(ctx) {
    const impaye = Number(ctx.montantImpaye) || 0;
    const appel = escapeHTML(appelLocataire(ctx));
    return `
      <div class="doc">
        ${header(ctx)}
        <h1 class="doc-title">Relance pour impayé</h1>
        <p class="doc-body">
          ${appel},
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
          Restant à votre disposition pour tout renseignement complémentaire, nous vous prions d'agréer, ${appel},
          l'expression de nos salutations distinguées.
        </p>
        ${signatureBlock(ctx, 'Signature du bailleur')}
      </div>
    `;
  }

  // Texte de la mise en demeure, partagé entre l'aperçu HTML et le PDF.
  function moisLabel(monthValue) {
    if (!monthValue) return '';
    const [y, m] = monthValue.split('-').map(Number);
    return MONTHS_FR[m - 1] + ' ' + y;
  }

  function dateLabel(isoDate) {
    if (!isoDate) return '';
    const d = new Date(`${isoDate}T00:00:00`);
    return (d.getDate() === 1 ? '1er' : d.getDate()) + ' ' + MONTHS_FR[d.getMonth()] + ' ' + d.getFullYear();
  }

  function miseEnDemeureTexte(ctx) {
    const montant = Number(ctx.montantImpaye) || 0;
    const r1 = dateLabel(ctx.relance1);
    const r2 = dateLabel(ctx.relance2);
    let relances;
    if (r1 && r2) relances = `Malgré nos deux précédentes relances en date des ${r1} et ${r2}`;
    else if (r1 || r2) relances = `Malgré notre précédente relance en date du ${r1 || r2}`;
    else relances = 'Malgré nos précédentes relances';
    const mois = moisLabel(ctx.periode);
    const jour = Number(ctx.jourExigibilite) || 1;
    const appel = appelLocataire(ctx);
    return {
      objet: 'MISE EN DEMEURE DE PAYER – Loyers impayés',
      mention: 'Lettre recommandée avec accusé de réception',
      paragraphes: [
        `${appel},`,
        `${relances}, nous constatons qu'à ce jour, le règlement du loyer correspondant ${mois ? 'au mois de ' + mois : 'à la période due'} ne nous est toujours pas parvenu.`,
        `Pour rappel, conformément aux dispositions de votre contrat de location, le loyer est exigible le ${jour === 1 ? '1er' : jour} de chaque mois.`,
        `À ce jour, et sauf erreur ou omission de notre part, la somme de ${fmtEUR(montant)} euros (${NumberToWords.amountToWords(montant)}) demeure impayée.`,
        "En conséquence, nous vous mettons formellement en demeure, conformément à l'article 1344 du Code civil, de procéder au règlement intégral de cette somme dans un délai de huit (8) jours à compter de la première présentation du présent courrier recommandé.",
        'Nous vous remercions de bien vouloir régulariser votre situation dans ce délai, selon les modalités de paiement habituelles.',
        "À défaut de règlement de votre part dans le délai indiqué, nous nous verrons contraints d'envisager les démarches nécessaires au recouvrement des sommes dues, conformément aux dispositions légales applicables.",
        "Nous souhaitons naturellement privilégier une résolution amiable de cette situation et éviter l'engagement de telles démarches.",
        'Si votre règlement est intervenu entre-temps, nous vous remercions de ne pas tenir compte de la présente demande et de bien vouloir nous en informer.',
        `Dans l'attente d'une régularisation rapide, nous vous prions d'agréer, ${appel}, l'expression de nos salutations distinguées.`,
      ],
    };
  }

  function miseEnDemeure(ctx) {
    const t = miseEnDemeureTexte(ctx);
    return `
      <div class="doc">
        ${header(ctx)}
        <p class="doc-body"><em>${t.mention}</em></p>
        <h1 class="doc-title">Mise en demeure pour impayé</h1>
        <p class="doc-body"><strong>Objet : ${escapeHTML(t.objet)}</strong></p>
        ${t.paragraphes.map((p) => `<p class="doc-body">${escapeHTML(p)}</p>`).join('')}
        ${signatureBlock(ctx, 'Signature du bailleur')}
      </div>
    `;
  }

  // Courrier de régularisation annuelle de la TEOM (art. 23 de la loi
  // n° 89-462 ; décret n° 87-713, annexe, rubrique VIII). Texte partagé entre
  // l'aperçu HTML et le PDF.
  function regularisationTexte(ctx) {
    const appel = appelLocataire(ctx);
    const annee = ctx.annee || '';
    const solde = Number(ctx.solde) || 0;
    const abs = Math.abs(solde);
    const prochain = ctx.modalite !== 'separe';
    const mois = moisLabel(ctx.moisProchainLoyer);
    const loyerDe = mois ? `votre prochain loyer de ${mois}` : 'votre prochain loyer';
    const surf = (n) => (Number(n) || 0).toLocaleString('fr-FR') + ' m²';
    const lignes = [
      { label: 'Logement concerné', value: String(ctx.locationAdresse || '').replace(/\n/g, ', ') },
      { label: `TEOM ${annee} (avis de taxe foncière, tous logements)`, value: fmtEUR(ctx.totalTeom) + ' €' },
      { label: 'Surface de votre logement / surface totale', value: `${surf(ctx.surface)} / ${surf(ctx.surfaceTotale)}` },
      { label: 'TEOM réellement due pour votre logement', value: fmtEUR(ctx.teomDue) + ' €' },
      { label: `Provisions versées en ${annee}`, value: fmtEUR(ctx.provisions) + ' €' },
    ];
    if (Number(ctx.regulDeja)) lignes.push({ label: 'Régularisation déjà effectuée', value: fmtEUR(ctx.regulDeja) + ' €' });
    lignes.push({
      label: solde > 0 ? 'Solde restant à votre charge' : solde < 0 ? 'Trop-perçu en votre faveur' : 'Solde',
      value: fmtEUR(abs) + ' €',
      total: true,
    });

    let conclusion;
    if (solde > 0) {
      conclusion = `Les provisions versées étant inférieures à la somme réellement due, il reste à votre charge un montant de ${fmtEUR(abs)} euros (${NumberToWords.amountToWords(abs)}). `
        + (prochain
          ? `Nous vous remercions de bien vouloir le régler en même temps que ${loyerDe}.`
          : 'Nous vous remercions de bien vouloir nous le régler, selon les modalités de paiement habituelles, dans un délai d\'un mois à compter de la réception du présent courrier.');
    } else if (solde < 0) {
      conclusion = `Les provisions versées étant supérieures à la somme réellement due, vous bénéficiez d'un trop-perçu de ${fmtEUR(abs)} euros (${NumberToWords.amountToWords(abs)}). `
        + (prochain
          ? `Ce montant sera déduit de ${loyerDe}.`
          : 'Ce montant vous sera remboursé par virement dans les meilleurs délais.');
    } else {
      conclusion = 'Les provisions versées correspondent exactement à la somme réellement due : aucune somme n\'est due de part ni d\'autre.';
    }

    const paragraphes = [
      `${appel},`,
      `Conformément à l'article 23 de la loi n° 89-462 du 6 juillet 1989, les provisions pour charges que vous versez chaque mois font l'objet d'une régularisation annuelle. Nous vous adressons ci-dessous le décompte de la taxe d'enlèvement des ordures ménagères (TEOM) pour l'année ${annee}, charge récupérable en application du décret n° 87-713 du 26 août 1987.`,
      `La TEOM portée sur l'avis de taxe foncière ${annee} concerne l'ensemble des logements. Elle est répartie entre eux au prorata de leur surface habitable.`,
    ];
    const suite = [conclusion];
    const nouvelle = Number(ctx.nouvelleProvision) || 0;
    const actuelle = Number(ctx.provisionActuelle) || 0;
    if (nouvelle) {
      const aCompter = mois ? `à compter de votre loyer de ${mois}` : 'à compter de votre prochaine échéance';
      let sens = '';
      if (actuelle && nouvelle > actuelle) sens = `, en hausse par rapport à la provision actuelle de ${fmtEUR(actuelle)} euros`;
      else if (actuelle && nouvelle < actuelle) sens = `, en baisse par rapport à la provision actuelle de ${fmtEUR(actuelle)} euros`;
      else if (actuelle) sens = ', inchangée par rapport à la provision actuelle';
      suite.push(`Afin que vos provisions correspondent au montant réel de la TEOM, votre provision mensuelle au titre de cette taxe est fixée à ${fmtEUR(nouvelle)} euros ${aCompter}${sens}.`);

      const loyer = Number(ctx.loyer) || 0;
      const charges = Number(ctx.chargesHorsTeom) || 0;
      const mensuel = Math.round((loyer + charges + nouvelle) * 100) / 100;
      const detail = `loyer ${fmtEUR(loyer)} € + charges locatives ${fmtEUR(charges)} € + provision TEOM ${fmtEUR(nouvelle)} €`;
      const [ay, am] = String(ctx.moisProchainLoyer || '').split('-').map(Number);
      const suivants = am === 1 ? `de février à décembre ${ay}` : 'pour les mois suivants';
      if (prochain && solde !== 0) {
        const premier = Math.round((mensuel + solde) * 100) / 100;
        const regul = solde > 0 ? ` + régularisation ${fmtEUR(abs)} €` : ` − trop-perçu ${fmtEUR(abs)} €`;
        suite.push(`Votre virement ${mois ? `de ${mois}` : 'du prochain mois'} sera donc exceptionnellement de ${fmtEUR(premier)} euros (${detail}${regul}). ${suivants.charAt(0).toUpperCase() + suivants.slice(1)}, votre virement mensuel sera de ${fmtEUR(mensuel)} euros (${detail}).`);
      } else {
        suite.push(`${mois ? `À compter de ${mois}` : 'À compter de votre prochaine échéance'}, votre virement mensuel sera donc de ${fmtEUR(mensuel)} euros (${detail}).`);
      }
    }
    suite.push(`Les pièces justificatives (avis de taxe foncière ${annee}) sont tenues à votre disposition pendant six mois à compter de l'envoi du présent décompte.`);
    suite.push(`Restant à votre disposition pour toute précision, nous vous prions d'agréer, ${appel}, l'expression de nos salutations distinguées.`);
    return {
      titre: 'Régularisation des charges locatives',
      objet: `Régularisation annuelle des charges – TEOM ${annee}`,
      paragraphes,
      lignes,
      suite,
    };
  }

  // Courrier annonçant la provision TEOM (redevance incitative du SMD3
  // remplacée par la TEOM). Même forme que le courrier de régularisation.
  function passageTeomTexte(ctx) {
    const appel = appelLocataire(ctx);
    const mois = moisLabel(ctx.moisEffet);
    const [y, m] = String(ctx.moisEffet || '').split('-').map(Number);
    const dateEffet = y ? `1er ${MONTHS_FR[m - 1]} ${y}` : '';
    const trimestriel = Number(ctx.nbMois) === 3;
    const periode = trimestriel ? 'trimestriel' : 'mensuel';
    const provision = Number(ctx.provisionTeom) || 0;
    const nouveau = Number(ctx.nouveauVirement) || 0;
    const lignes = [
      { label: 'Logement concerné', value: String(ctx.locationAdresse || '').replace(/\n/g, ', ') },
      { label: `Virement ${periode} actuel (loyer et charges)`, value: fmtEUR(ctx.virementActuel) + ' €' },
      { label: 'Provision TEOM mensuelle', value: fmtEUR(provision) + ' €' + (trimestriel ? ` (soit ${fmtEUR(provision * 3)} € par trimestre)` : '') },
      { label: `Nouveau virement ${periode} à compter du ${dateEffet}`, value: fmtEUR(nouveau) + ' €', total: true },
    ];
    return {
      titre: 'Ordures ménagères : passage à la TEOM',
      objet: `Provision pour charges TEOM à compter du ${dateEffet} – nouveau montant de votre virement`,
      paragraphes: [
        `${appel},`,
        `Comme l'ont annoncé le SMD3 et les Finances publiques de la Dordogne, la redevance incitative d'enlèvement des ordures ménagères est remplacée au ${dateEffet} par la taxe d'enlèvement des ordures ménagères (TEOM).`,
        "À compter de cette date, vous ne recevrez plus de facture du SMD3 pour les déchets. La TEOM est facturée au propriétaire avec son avis de taxe foncière et, conformément au décret n° 87-713 du 26 août 1987, elle fait partie des charges récupérables auprès du locataire.",
        `Son montant pour ${y || ''} ne sera connu qu'à réception de l'avis de taxe foncière, attendu en août ou septembre ${y || ''}. Dans l'attente, et comme le prévoit l'avenant à votre contrat de location joint au présent courrier, une provision de ${fmtEUR(provision)} euros par mois au titre de la TEOM est ajoutée à vos charges à compter du ${dateEffet}.`,
      ],
      lignes,
      suite: [
        `À compter de votre loyer de ${mois}, votre virement ${periode} passera donc de ${fmtEUR(ctx.virementActuel)} euros à ${fmtEUR(nouveau)} euros (${NumberToWords.amountToWords(nouveau)}). Nous vous remercions de bien vouloir modifier votre virement en conséquence.`,
        `Conformément à l'article 23 de la loi n° 89-462 du 6 juillet 1989, ces provisions feront l'objet d'une régularisation annuelle : à réception de l'avis de taxe foncière ${y || ''}, nous vous adresserons le décompte de la TEOM réellement due pour votre logement, avec le solde éventuel à régler ou à vous rembourser.`,
        "Nous vous remercions de bien vouloir nous retourner l'avenant ci-joint, daté et signé.",
        `Restant à votre disposition pour toute précision, nous vous prions d'agréer, ${appel}, l'expression de nos salutations distinguées.`,
      ],
    };
  }

  function courrierAvecTableau(t, ctx) {
    const p = (txt) => `<p class="doc-body">${escapeHTML(txt)}</p>`;
    return `
      <div class="doc">
        ${header(ctx)}
        <h1 class="doc-title">${escapeHTML(t.titre)}</h1>
        <p class="doc-body"><strong>Objet : ${escapeHTML(t.objet)}</strong></p>
        ${t.paragraphes.map(p).join('')}
        <table class="doc-table">
          ${t.lignes.map((l) => `<tr${l.total ? ' class="total"' : ''}><td>${escapeHTML(l.label)}</td><td>${escapeHTML(l.value)}</td></tr>`).join('')}
        </table>
        ${t.suite.map(p).join('')}
        ${signatureBlock(ctx, 'Signature du bailleur')}
      </div>
    `;
  }

  function regularisationCharges(ctx) {
    const t = regularisationTexte(ctx);
    const p = (txt) => `<p class="doc-body">${escapeHTML(txt)}</p>`;
    return `
      <div class="doc">
        ${header(ctx)}
        <h1 class="doc-title">${t.titre}</h1>
        <p class="doc-body"><strong>Objet : ${escapeHTML(t.objet)}</strong></p>
        ${t.paragraphes.map(p).join('')}
        <table class="doc-table">
          ${t.lignes.map((l) => `<tr${l.total ? ' class="total"' : ''}><td>${escapeHTML(l.label)}</td><td>${escapeHTML(l.value)}</td></tr>`).join('')}
        </table>
        ${t.suite.map(p).join('')}
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
      case 'mise-en-demeure': return miseEnDemeure(full);
      case 'regularisation-charges': return regularisationCharges(full);
      case 'passage-teom': return courrierAvecTableau(passageTeomTexte(full), full);
      case 'avenant': return avenant(full);
      case 'libre': return libre(full);
      default: return '';
    }
  }

  return { build, fmtEUR, todayFR, periodLabel, miseEnDemeureTexte, regularisationTexte, passageTeomTexte, appelLocataire };
})();
