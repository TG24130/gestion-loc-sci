// Génération du texte d'une annonce de location nue à usage d'habitation.
//
// Le descriptif rédigé par l'utilisateur est restitué SANS AUCUNE
// MODIFICATION : ce module ne rédige pas, il assemble. Il calcule seulement
// les blocs chiffrés et légaux (énergie, conditions financières, candidature)
// et signale ce qui manque.
//
// La fonction est PURE : ni DOM, ni IndexedDB, ni réseau. C'est ce qui permet
// de la tester par `node tests/annonce.test.js`, sans navigateur. Le projet
// n'ayant ni intégration continue ni environnement de test, une erreur dans
// une mention obligatoire se découvrirait autrement sur une annonce déjà
// publiée.
//
// L'export passe par `window.QfAnnonce` et non par une const de haut niveau
// (le style de storage.js) : `vm.runInContext`, utilisé par le harnais de
// test, n'expose pas les const de haut niveau sur l'objet sandbox. Une const
// rendrait ce module intestable.
(function () {
  'use strict';

  const MOIS = [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
  ];

  const NOMBRES_EN_LETTRES = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six'];

  // Les mentions obligatoires d'une annonce de location nue. La liste sert au
  // contrôle : chaque entrée absente produit un avertissement bloquant.
  const GRAVITE_BLOQUANT = 'bloquant';
  const GRAVITE_ATTENTION = 'attention';

  // ---------- Formatage ----------

  // Formatage maison plutôt qu'Intl.NumberFormat : ce dernier produit selon la
  // version d'ICU une espace fine insécable (U+202F) ou une insécable normale
  // (U+00A0) comme séparateur de milliers. Le texte différerait donc entre
  // Node et le navigateur, et les comparaisons de test deviendraient fragiles.
  function formaterEuros(valeur) {
    const nombre = Number(valeur);
    if (!isFinite(nombre)) return '';
    const arrondi = Math.round(nombre * 100) / 100;
    const entier = Math.floor(Math.abs(arrondi));
    const centimes = Math.round((Math.abs(arrondi) - entier) * 100);
    let texte = String(entier).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    if (centimes > 0) texte += ',' + String(centimes).padStart(2, '0');
    return (arrondi < 0 ? '-' : '') + texte + ' €';
  }

  // "2026-10-01" -> "1er octobre 2026"
  function formaterDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    const jour = parseInt(m[3], 10);
    const mois = MOIS[parseInt(m[2], 10) - 1];
    if (!mois) return '';
    return (jour === 1 ? '1er' : String(jour)) + ' ' + mois + ' ' + m[1];
  }

  // "2025-10" ou "2025-10-15" -> "octobre 2025"
  function formaterMoisAnnee(iso) {
    const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    const mois = MOIS[parseInt(m[2], 10) - 1];
    if (!mois) return '';
    return mois + ' ' + m[1];
  }

  function nombreEnLettres(n) {
    const entier = Number(n);
    if (Number.isInteger(entier) && entier >= 0 && entier < NOMBRES_EN_LETTRES.length) {
      return NOMBRES_EN_LETTRES[entier];
    }
    return String(n);
  }

  // ["a", "b", "c"] -> "a, b et c"
  function joindreEnumeration(items) {
    const liste = (items || []).map((s) => String(s).trim()).filter(Boolean);
    if (liste.length === 0) return '';
    if (liste.length === 1) return liste[0];
    return liste.slice(0, -1).join(', ') + ' et ' + liste[liste.length - 1];
  }

  // L'adresse est saisie dans un textarea libre ("12 rue de la Paix\n24100
  // Bergerac"). On y cherche un code postal suivi d'un nom de commune.
  function extraireCommune(adresse) {
    const m = /(\d{5})\s+([^\n,;]+)/.exec(String(adresse || ''));
    if (!m) return null;
    const ville = m[2].trim();
    if (!ville) return null;
    return { codePostal: m[1], ville: ville };
  }

  function estRenseigne(valeur) {
    return valeur !== undefined && valeur !== null && String(valeur).trim() !== '';
  }

  // ---------- Blocs générés ----------

  // Résumé factuel du bien, placé avant le descriptif : il pose les
  // caractéristiques, le texte libre les raconte ensuite. C'est ici que la
  // surface habitable est annoncée — mention obligatoire, mais qui se lit
  // mieux avec le reste du logement qu'au milieu des conditions financières.
  function blocLogement(bien, avertir) {
    const lignes = [];
    const surfaceRenseignee = estRenseigne(bien.surfaceHabitable) && Number(bien.surfaceHabitable) > 0;

    // Phrase d'ouverture : nature, surface, distribution, année.
    const nature = estRenseigne(bien.typeBien) ? String(bien.typeBien).trim() : 'Logement';
    const qualites = [];
    if (surfaceRenseignee) qualites.push(bien.surfaceHabitable + ' m² habitables');
    if (estRenseigne(bien.nbPieces)) {
      let pieces = bien.nbPieces + (Number(bien.nbPieces) > 1 ? ' pièces' : ' pièce');
      if (estRenseigne(bien.nbChambres)) {
        pieces += ' dont ' + bien.nbChambres + (Number(bien.nbChambres) > 1 ? ' chambres' : ' chambre');
      }
      qualites.push(pieces);
    } else if (estRenseigne(bien.nbChambres)) {
      qualites.push(bien.nbChambres + (Number(bien.nbChambres) > 1 ? ' chambres' : ' chambre'));
    }

    let ouverture = nature;
    // Virgules et non « et » : c'est une liste de caractéristiques, pas une
    // énumération de fin de phrase.
    if (qualites.length) ouverture += ' de ' + qualites.join(', ');
    const construction = [];
    // « année 2016 » plutôt que « construite en 2016 » : le participe devrait
    // s'accorder avec le type de bien, que l'utilisateur saisit librement.
    if (estRenseigne(bien.anneeConstruction)) construction.push('année ' + bien.anneeConstruction);
    if (estRenseigne(bien.normeConstruction)) construction.push('norme ' + String(bien.normeConstruction).trim());
    if (construction.length) ouverture += ', ' + construction.join(', ');
    lignes.push(ouverture + '.');

    if (!surfaceRenseignee) {
      avertir(
        'surfaceHabitable', GRAVITE_BLOQUANT,
        'Surface habitable absente : elle est obligatoire et doit être la valeur exacte du mesurage.'
      );
    }

    // Équipements : une ligne chacun, omis s'ils ne sont pas renseignés.
    const equipements = [
      { cle: 'chauffageType', prefixe: 'Chauffage : ' },
      { cle: 'eauChaudeType', prefixe: 'Eau chaude sanitaire : ' },
      { cle: 'climatisation', prefixe: 'Climatisation : ' },
      { cle: 'stationnement', prefixe: 'Stationnement : ' },
      { cle: 'exterieurs', prefixe: 'Extérieurs : ' },
      { cle: 'annexes', prefixe: 'Annexes : ' },
    ];
    equipements.forEach((eq) => {
      if (estRenseigne(bien[eq.cle])) {
        const valeur = String(bien[eq.cle]).trim();
        lignes.push(eq.prefixe + valeur + (/[.!?]$/.test(valeur) ? '' : '.'));
      }
    });

    return lignes.join('\n');
  }

  function blocEnergie(bien, avertir) {
    const lignes = [];

    if (estRenseigne(bien.dpeClasse) && estRenseigne(bien.gesClasse)) {
      lignes.push(
        'Performance énergétique : DPE classe ' + String(bien.dpeClasse).toUpperCase()
        + ' — GES classe ' + String(bien.gesClasse).toUpperCase() + '.'
      );
    }
    if (!estRenseigne(bien.dpeClasse)) {
      avertir('dpeClasse', GRAVITE_BLOQUANT, 'Classe DPE absente : elle est obligatoire dans l\'annonce.');
    }
    if (!estRenseigne(bien.gesClasse)) {
      avertir('gesClasse', GRAVITE_BLOQUANT, 'Classe GES absente : elle est obligatoire dans l\'annonce.');
    }

    // La consommation chiffrée et la date du diagnostic ne sont pas exigées
    // dans l'annonce : on les publie si elles sont connues, sans les réclamer.
    const complements = [];
    if (estRenseigne(bien.dpeConsommation)) {
      complements.push('Consommation : ' + bien.dpeConsommation + ' kWh/m²/an.');
    }
    const moisDiagnostic = formaterMoisAnnee(bien.dpeDateRealisation);
    if (moisDiagnostic) {
      complements.push('Diagnostic réalisé en ' + moisDiagnostic + '.');
    }
    if (complements.length) lignes.push(complements.join(' '));

    const min = bien.energieCoutMin;
    const max = bien.energieCoutMax;
    const annee = bien.energieAnneeReference;
    const aUnCout = estRenseigne(min) || estRenseigne(max);

    if (aUnCout) {
      let montant;
      if (estRenseigne(min) && estRenseigne(max) && Number(min) !== Number(max)) {
        montant = 'entre ' + formaterEuros(min) + ' et ' + formaterEuros(max) + ' par an';
      } else {
        montant = 'environ ' + formaterEuros(estRenseigne(min) ? min : max) + ' par an';
      }
      let phrase = 'Montant estimé des dépenses annuelles d\'énergie pour un usage standard : '
        + montant + '.';
      if (estRenseigne(annee)) {
        phrase += ' Prix moyens des énergies indexés au 1er janvier ' + annee + '.';
      }
      lignes.push(phrase);
    } else {
      avertir(
        'energieCout', GRAVITE_BLOQUANT,
        'Estimation des dépenses annuelles d\'énergie absente : elle est obligatoire dans l\'annonce.'
      );
    }

    if (!estRenseigne(annee)) {
      avertir(
        'energieAnneeReference', GRAVITE_BLOQUANT,
        'Année de référence des prix de l\'énergie absente. Elle figure sur le DPE et '
        + 'ne se confond pas avec la date de réalisation du diagnostic.'
      );
    }

    // Un DPE est valable dix ans. Passé ce délai, l'annonce s'appuie sur un
    // diagnostic périmé — signalé sans bloquer, la date exacte du
    // renouvellement relevant de l'utilisateur.
    if (estRenseigne(bien.dpeDateRealisation)) {
      const m = /^(\d{4})/.exec(String(bien.dpeDateRealisation));
      if (m && (new Date().getFullYear() - parseInt(m[1], 10)) > 10) {
        avertir('dpeDateRealisation', GRAVITE_ATTENTION, 'Le diagnostic a plus de dix ans : il n\'est probablement plus valable.');
      }
    }

    return lignes.join('\n');
  }

  function blocFinancier(bien, redaction, avertir) {
    const lignes = [];
    const loyer = redaction.loyer;

    if (estRenseigne(loyer) && Number(loyer) > 0) {
      lignes.push('Loyer mensuel : ' + formaterEuros(loyer) + ' hors charges.');
    } else {
      avertir('loyer', GRAVITE_BLOQUANT, 'Loyer absent : il est obligatoire dans l\'annonce.');
    }

    if (estRenseigne(redaction.charges)) {
      if (Number(redaction.charges) > 0) {
        let phrase = 'Provision mensuelle sur charges : ' + formaterEuros(redaction.charges)
          + ', régularisation annuelle';
        const detail = joindreEnumeration(redaction.chargesDetail);
        phrase += detail ? ', couvrant ' + detail + '.' : '.';
        lignes.push(phrase);
      } else {
        lignes.push('Aucune provision sur charges.');
      }
    } else {
      avertir(
        'charges', GRAVITE_BLOQUANT,
        'Montant des charges absent : le montant et le mode de règlement sont obligatoires.'
      );
    }

    if (estRenseigne(redaction.chargesResteACharge)) {
      lignes.push(String(redaction.chargesResteACharge).trim() + ' à la charge du locataire.');
    }

    if (estRenseigne(redaction.depotGarantie)) {
      const depot = Number(redaction.depotGarantie);
      if (depot > 0) {
        let phrase = 'Dépôt de garantie : ' + formaterEuros(depot);
        // "un mois de loyer hors charges" parle davantage qu'un montant seul,
        // quand le dépôt est un multiple exact du loyer.
        const loyerNum = Number(loyer);
        if (loyerNum > 0 && depot % loyerNum === 0) {
          const mois = depot / loyerNum;
          phrase += ' (' + nombreEnLettres(mois) + ' mois de loyer hors charges)';
        }
        lignes.push(phrase + '.');
      } else {
        lignes.push('Aucun dépôt de garantie.');
      }
    } else {
      avertir('depotGarantie', GRAVITE_BLOQUANT, 'Dépôt de garantie absent : il est obligatoire dans l\'annonce.');
    }

    // La surface habitable est annoncée par le bloc « logement », en tête :
    // elle n'est pas répétée ici.
    const commune = extraireCommune(bien.adresse);
    if (commune) {
      lignes.push('Logement situé à ' + commune.ville + ' (' + commune.codePostal + ').');
    } else {
      avertir(
        'commune', GRAVITE_BLOQUANT,
        'Commune introuvable dans l\'adresse du bien : la commune est obligatoire dans l\'annonce.'
      );
    }

    const dispo = formaterDate(redaction.disponibleLe);
    if (dispo) {
      lignes.push('Disponible à compter du ' + dispo + '.');
    } else {
      avertir('disponibleLe', GRAVITE_BLOQUANT, 'Date de disponibilité absente.');
    }

    if (estRenseigne(redaction.honoraires) && Number(redaction.honoraires) > 0) {
      lignes.push(
        'Honoraires de location à la charge du locataire : '
        + formaterEuros(redaction.honoraires) + ' TTC.'
      );
    } else {
      lignes.push('Aucun honoraire de location (location en direct).');
    }

    return lignes.join('\n');
  }

  function blocCandidature(redaction, reglages) {
    const lignes = [];
    const exigences = [];

    if (estRenseigne(reglages.critereContrat)) {
      exigences.push('justificatif de ' + String(reglages.critereContrat).trim());
    }

    const ratio = Number(reglages.ratioRevenus);
    const loyer = Number(redaction.loyer);
    if (ratio > 0 && loyer > 0) {
      exigences.push(
        'revenus nets mensuels d\'au moins ' + formaterEuros(ratio * loyer)
        + ' (' + nombreEnLettres(ratio) + ' fois le loyer hors charges)'
      );
    }

    if (exigences.length) {
      lignes.push('Candidature : ' + exigences.join(' et ') + '.');
    }

    const fin = [];
    if (estRenseigne(reglages.modalitesVisite)) fin.push(String(reglages.modalitesVisite).trim());
    if (estRenseigne(reglages.canalContact)) fin.push(String(reglages.canalContact).trim());
    if (fin.length) lignes.push(fin.join(' ') + (/[.!?]$/.test(fin[fin.length - 1]) ? '' : '.'));

    return lignes.join('\n');
  }

  // ---------- Contrôles de qualité sur le texte libre ----------

  // Chaque motif correspond à une information désormais produite par un bloc
  // généré. La retrouver dans le descriptif signale une répétition : le
  // lecteur de l'annonce la verrait deux fois.
  const MOTIFS_REPETITION = [
    { champ: 'texteLibre.loyer', regex: /\bloyers?\b/i, quoi: 'le loyer' },
    { champ: 'texteLibre.charges', regex: /\bcharges?\s+(provisionnelles?|mensuelles?)\b/i, quoi: 'les charges' },
    { champ: 'texteLibre.dpe', regex: /\bDPE\b|\bGES\b/i, quoi: 'le DPE' },
    { champ: 'texteLibre.depot', regex: /\bcaution\b|\bdépôt\s+de\s+garantie\b/i, quoi: 'le dépôt de garantie' },
    { champ: 'texteLibre.candidature', regex: /\bCDI\b|\brevenus?\b/i, quoi: 'les critères de candidature' },
    { champ: 'texteLibre.visite', regex: /\bvisites?\b/i, quoi: 'les modalités de visite' },
    { champ: 'texteLibre.chauffage', regex: /\bchauffage\b|\beau chaude\b/i, quoi: 'le chauffage' },
    { champ: 'texteLibre.climatisation', regex: /\bclimatisation\b|\bclim\b/i, quoi: 'la climatisation' },
    { champ: 'texteLibre.stationnement', regex: /\bstationnement\b|\bparking\b|\bgarage\b/i, quoi: 'le stationnement' },
  ];

  // "95m2 environ", "95 m² env.", "environ 95 m2" : la surface habitable doit
  // être exacte, une approximation dans le descriptif la contredit.
  //
  // Pas de \b après l'unité : « ² » n'est pas un caractère de mot, donc aucune
  // frontière ne suit « m² » devant un point ou une virgule, et la variante
  // typographique correcte échapperait au contrôle. On exclut simplement un
  // chiffre suivant, pour ne pas confondre « m2 » et « m25 ».
  const REGEX_SURFACE_APPROX = /(environ\s*\d+[\d\s,.]*\s*m(?:²|2)(?![0-9]))|(\d+[\d\s,.]*\s*m(?:²|2)(?![0-9])\s*(?:environ|env\.))/i;

  function controlerTexteLibre(texteLibre, avertir) {
    const texte = String(texteLibre || '');

    if (texte.trim().length < 300) {
      avertir(
        'texteLibre', GRAVITE_ATTENTION,
        'Descriptif court (moins de 300 caractères) : une annonce détaillée attire davantage de candidats sérieux.'
      );
    }

    if (REGEX_SURFACE_APPROX.test(texte)) {
      avertir(
        'texteLibre.surface', GRAVITE_ATTENTION,
        'Une surface approximative (« environ ») figure dans le descriptif : la surface habitable annoncée doit être exacte.'
      );
    }

    MOTIFS_REPETITION.forEach((motif) => {
      if (motif.regex.test(texte)) {
        avertir(
          motif.champ, GRAVITE_ATTENTION,
          'Le descriptif mentionne ' + motif.quoi + ', déjà repris plus bas dans un bloc généré. '
          + 'Tu peux retirer ce passage pour éviter la répétition.'
        );
      }
    });
  }

  // ---------- Point d'entrée ----------

  function construireAnnonce(bien, redaction, reglagesSci) {
    const b = bien || {};
    const r = redaction || {};
    const reglages = reglagesSci || {};
    const avertissements = [];

    function avertir(champ, gravite, message) {
      avertissements.push({ champ: champ, gravite: gravite, message: message });
    }

    const blocs = [];

    if (estRenseigne(r.titre)) blocs.push(String(r.titre).trim());

    const logement = blocLogement(b, avertir);
    if (logement) blocs.push(logement);

    // Restitué tel quel : ni reformulé, ni recadré, ni nettoyé.
    if (estRenseigne(r.texteLibre)) blocs.push(r.texteLibre);

    controlerTexteLibre(r.texteLibre, avertir);

    const energie = blocEnergie(b, avertir);
    if (energie) blocs.push(energie);

    const financier = blocFinancier(b, r, avertir);
    if (financier) blocs.push(financier);

    const candidature = blocCandidature(r, reglages);
    if (candidature) blocs.push(candidature);

    return { texte: blocs.join('\n\n'), avertissements: avertissements };
  }

  window.QfAnnonce = { construireAnnonce };
})();
