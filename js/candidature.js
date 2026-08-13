// Calculs et textes liés aux candidatures locatives.
//
// Trois responsabilités, toutes PURES : ni DOM, ni IndexedDB, ni réseau. C'est
// ce qui permet de les tester par `node tests/candidature.test.js`, sans
// navigateur — le projet n'ayant ni intégration continue ni environnement de
// test, c'est la seule protection avant la production.
//
// L'export passe par `window.QfCandidature` et non par une const de haut
// niveau : `vm.runInContext`, utilisé par le harnais de test, n'expose pas les
// const sur l'objet sandbox. Une const rendrait ce module intestable.
(function () {
  'use strict';

  const GRAVITE_BLOQUANT = 'bloquant';
  const GRAVITE_ATTENTION = 'attention';

  // Mêmes raisons que dans annonce.js : Intl.NumberFormat produit selon la
  // version d'ICU une espace fine ou une insécable comme séparateur de
  // milliers, ce qui ferait diverger le texte entre Node et le navigateur.
  function formaterEuros(valeur) {
    const nombre = Number(valeur);
    if (!isFinite(nombre)) return '';
    const arrondi = Math.round(nombre);
    const signe = arrondi < 0 ? '-' : '';
    return signe + String(Math.abs(arrondi)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' €';
  }

  function estRenseigne(valeur) {
    return valeur !== undefined && valeur !== null && String(valeur).trim() !== '';
  }

  function nombreOuZero(valeur) {
    const n = Number(valeur);
    return isFinite(n) ? n : 0;
  }

  // ---------- Indicateurs ----------

  /**
   * Compare un dossier au coût réel du logement.
   *
   * Le seul ratio « trois fois le loyer » met à égalité deux candidats aux
   * mêmes ressources, alors que l'un peut rembourser 600 € de crédit par mois.
   * Le reste à vivre les sépare : c'est lui qui dit ce qu'il restera au
   * locataire une fois le loyer et ses charges payés.
   */
  function calculerIndicateurs(candidature, bien, reglages) {
    const c = candidature || {};
    const b = bien || {};
    const r = reglages || {};
    const alertes = [];

    const loyer = nombreOuZero(b.loyer);
    const chargesLocatives = nombreOuZero(b.charges);
    const loyerTotal = loyer + chargesLocatives;
    const ressources = nombreOuZero(c.ressources);
    const chargesDeclarees = nombreOuZero(c.chargesDeclarees);

    if (!estRenseigne(c.ressources) || ressources <= 0) {
      alertes.push({
        champ: 'ressources', gravite: GRAVITE_ATTENTION,
        message: 'Ressources non renseignées : impossible de calculer le taux d\'effort et le reste à vivre.',
      });
      return { tauxEffort: null, resteAVivre: null, ratioLoyer: null, loyerTotal: loyerTotal, alertes: alertes };
    }

    const tauxEffort = loyerTotal / ressources;
    const resteAVivre = ressources - chargesDeclarees - loyerTotal;
    // Le ratio se calcule sur le loyer HORS charges : c'est la convention de
    // l'annonce (« trois fois le loyer hors charges »).
    const ratioLoyer = loyer > 0 ? ressources / loyer : null;

    const ratioExige = Number(r.ratioRevenus);
    if (ratioExige > 0 && ratioLoyer !== null && ratioLoyer < ratioExige) {
      alertes.push({
        champ: 'ratioLoyer', gravite: GRAVITE_ATTENTION,
        message: 'Ressources à ' + ratioLoyer.toFixed(1) + ' fois le loyer hors charges, '
          + 'en dessous des ' + ratioExige + ' fois demandés.',
      });
    }

    // Objectif, contrairement à un seuil de reste à vivre qui dépendrait de la
    // composition du foyer : à zéro ou en dessous, le loyer n'est pas payable.
    if (resteAVivre <= 0) {
      alertes.push({
        champ: 'resteAVivre', gravite: GRAVITE_BLOQUANT,
        message: 'Reste à vivre de ' + formaterEuros(resteAVivre) + ' : le loyer et les charges '
          + 'déclarées absorbent la totalité des ressources.',
      });
    }

    return {
      tauxEffort: tauxEffort,
      resteAVivre: resteAVivre,
      ratioLoyer: ratioLoyer,
      loyerTotal: loyerTotal,
      alertes: alertes,
    };
  }

  // ---------- Mail de refus ----------

  /**
   * Refus courtois et SANS MOTIF.
   *
   * Un refus de candidature locative n'a pas à être justifié, et un motif mal
   * formulé — situation de famille, origine ou montant des revenus, animal — se
   * lit comme discriminatoire. Le silence sur les raisons est ici la formulation
   * la plus sûre, pas une facilité.
   *
   * L'application n'envoie rien : elle produit un texte à relire et à coller.
   */
  function construireMailRefus(candidature, bien, sci) {
    const c = candidature || {};
    const b = bien || {};
    const s = sci || {};

    const designation = estRenseigne(b.nom) ? String(b.nom).trim() : 'le logement';
    const nom = estRenseigne(c.nom) ? String(c.nom).trim() : 'Madame, Monsieur';

    const objet = 'Votre candidature pour la location — ' + designation;

    const signature = estRenseigne(s.gerant) ? String(s.gerant).trim()
      : (estRenseigne(s.nom) ? String(s.nom).trim() : '');

    const corps = [
      'Bonjour ' + nom + ',',
      '',
      'Vous avez manifesté votre intérêt pour la location de ' + designation
        + ', et je vous en remercie.',
      '',
      'Après examen de l\'ensemble des candidatures, je ne suis pas en mesure de '
        + 'retenir la vôtre.',
      '',
      'Je vous souhaite une bonne continuation dans vos recherches.',
      '',
      'Cordialement,',
      signature,
    ].filter((ligne, i, tab) => !(ligne === '' && tab[i - 1] === '')).join('\n');

    return { objet: objet, corps: corps.replace(/\n+$/, '') };
  }

  // ---------- Créneaux de visite ----------

  function minutesVersHeure(minutes) {
    const total = ((minutes % 1440) + 1440) % 1440; // reste dans la journée
    const h = Math.floor(total / 60);
    const m = total % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  /**
   * Place `nombre` visites à la suite depuis `heureDebut`, espacées de
   * `dureeCreneau` minutes.
   */
  function calculerCreneaux(heureDebut, dureeCreneau, nombre) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(heureDebut || '').trim());
    const total = Number(nombre);
    const duree = Number(dureeCreneau);
    if (!m || !isFinite(total) || total <= 0 || !isFinite(duree) || duree <= 0) return [];

    const depart = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const creneaux = [];
    for (let i = 0; i < total; i++) creneaux.push(minutesVersHeure(depart + i * duree));
    return creneaux;
  }

  window.QfCandidature = { calculerIndicateurs, construireMailRefus, calculerCreneaux };
})();
