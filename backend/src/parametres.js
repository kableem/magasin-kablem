// Lecture des paramètres de l'application (table « parametres »)
const db = require('./db');
const { LIMITES_CONNECTEUR_DEFAUT } = require('./rangement');

const TAMPON_DEFAUT = 20;

async function capaciteTampon(connexion = db) {
  const [[ligne]] = await connexion.query("SELECT valeur FROM parametres WHERE cle = 'tampon_capacite'");
  const n = Number(ligne?.valeur);
  return Number.isInteger(n) && n >= 0 ? n : TAMPON_DEFAUT;
}

// Limites d'une palette de connecteurs : clés « connecteur_<nom> », valeur par défaut sinon
async function limitesConnecteurs(connexion = db) {
  const [lignes] = await connexion.query("SELECT cle, valeur FROM parametres WHERE cle LIKE 'connecteur\\_%'");
  const limites = { ...LIMITES_CONNECTEUR_DEFAUT };
  for (const { cle, valeur } of lignes) {
    const nom = cle.slice('connecteur_'.length);
    const n = Number(valeur);
    if (nom in limites && Number.isFinite(n) && n > 0) limites[nom] = n;
  }
  return limites;
}

// Délai (jours) au-delà duquel une réclamation non réglée est en retard
const DELAI_RECLAMATION_DEFAUT = 7;
async function delaiReclamation(connexion = db) {
  const [[ligne]] = await connexion.query("SELECT valeur FROM parametres WHERE cle = 'reclamation_delai_jours'");
  const n = Number(ligne?.valeur);
  return Number.isInteger(n) && n >= 1 ? n : DELAI_RECLAMATION_DEFAUT;
}

// Tout ce dont le moteur de rangement a besoin
async function parametresRangement(connexion = db) {
  return { capaciteTampon: await capaciteTampon(connexion), limites: await limitesConnecteurs(connexion) };
}

module.exports = { capaciteTampon, limitesConnecteurs, parametresRangement, delaiReclamation, TAMPON_DEFAUT };
