// Persistance locale (localStorage) des données de l'application.
const Storage = (function () {
  const KEY = 'qf_data_v1';

  function defaultData() {
    return {
      schemaVersion: 1,
      sci: { nom: '', adresse: '', ville: '', email: '', tel: '', siret: '', signature: '', capitalSocial: '', gerant: '' },
      biens: [],
      locataires: [],
      documents: [],
      charges: [],
      baux: [],
      etatsDesLieux: [],
      documentsAdmin: [],
      documentsLocataires: [],
      credits: [],
      bailModele: '',
      bailRedactions: [],
      facturesTravaux: [],
      bienGabarits: [],
      edlRedactions: [],
      edlModeles: [],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultData();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultData(), parsed);
    } catch (e) {
      console.error('Erreur de lecture des données locales', e);
      return defaultData();
    }
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('Échec de la sauvegarde locale (quota dépassé ou stockage indisponible)', e);
      return false;
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  return { load, save, uid };
})();
