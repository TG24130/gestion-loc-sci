// Conversion d'un montant en euros vers son écriture en toutes lettres (français).
const NumberToWords = (function () {
  const UNITS = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
  const TEENS = ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
  const TENS = ['', 'dix', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante-dix', 'quatre-vingt', 'quatre-vingt-dix'];

  function convertTens(n) {
    if (n < 10) return UNITS[n];
    if (n < 20) return TEENS[n - 10];
    const ten = Math.floor(n / 10);
    const unit = n % 10;
    if (ten === 7 || ten === 9) {
      const base = ten === 7 ? 'soixante' : 'quatre-vingt';
      if (unit === 0) return ten === 7 ? 'soixante-dix' : 'quatre-vingt-dix';
      if (unit === 1 && ten === 7) return 'soixante-et-onze';
      return base + '-' + TEENS[unit];
    }
    if (unit === 0) return ten === 8 ? 'quatre-vingts' : TENS[ten];
    if (unit === 1 && ten !== 8) return TENS[ten] + '-et-un';
    return TENS[ten] + '-' + UNITS[unit];
  }

  function convertHundreds(n) {
    const hundred = Math.floor(n / 100);
    const rest = n % 100;
    let str = '';
    if (hundred > 0) {
      str += hundred === 1 ? 'cent' : UNITS[hundred] + ' cent';
      if (hundred > 1 && rest === 0) str += 's';
      if (rest > 0) str += ' ';
    }
    if (rest > 0) str += convertTens(rest);
    return str;
  }

  function convertInteger(n) {
    if (n === 0) return 'zéro';
    const billions = Math.floor(n / 1e9);
    const millions = Math.floor((n % 1e9) / 1e6);
    const thousands = Math.floor((n % 1e6) / 1e3);
    const rest = n % 1000;
    const parts = [];
    if (billions > 0) parts.push((billions === 1 ? '' : convertHundreds(billions) + ' ') + 'milliard' + (billions > 1 ? 's' : ''));
    if (millions > 0) parts.push((millions === 1 ? '' : convertHundreds(millions) + ' ') + 'million' + (millions > 1 ? 's' : ''));
    if (thousands > 0) parts.push(thousands === 1 ? 'mille' : convertHundreds(thousands) + ' mille');
    if (rest > 0) parts.push(convertHundreds(rest));
    return parts.join(' ').trim();
  }

  function amountToWords(amount) {
    const safe = Math.max(0, Number(amount) || 0);
    const euros = Math.floor(safe);
    const cents = Math.round((safe - euros) * 100);
    let str = convertInteger(euros) + ' euro' + (euros > 1 ? 's' : '');
    if (cents > 0) {
      str += ' et ' + convertInteger(cents) + ' centime' + (cents > 1 ? 's' : '');
    }
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  return { amountToWords };
})();
