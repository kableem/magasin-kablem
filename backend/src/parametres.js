// Lecture des paramètres de l'application (table « parametres »)
const db = require('./db');

const TAMPON_DEFAUT = 20;

async function capaciteTampon(connexion = db) {
  const [[ligne]] = await connexion.query("SELECT valeur FROM parametres WHERE cle = 'tampon_capacite'");
  const n = Number(ligne?.valeur);
  return Number.isInteger(n) && n >= 0 ? n : TAMPON_DEFAUT;
}

// Délai (jours) au-delà duquel une réclamation non réglée est en retard
const DELAI_RECLAMATION_DEFAUT = 7;
async function delaiReclamation(connexion = db) {
  const [[ligne]] = await connexion.query("SELECT valeur FROM parametres WHERE cle = 'reclamation_delai_jours'");
  const n = Number(ligne?.valeur);
  return Number.isInteger(n) && n >= 1 ? n : DELAI_RECLAMATION_DEFAUT;
}

// Import résumé : plus de tolérance (décision du 2026-11-06) : tout écart de pièces devient une réclamation
const TOLERANCE_PIECES_DEFAUT = 0;
async function tolerancePieces() {
  return TOLERANCE_PIECES_DEFAUT;
}

// Déroulement de la réception mobile :
//   'separee' (par défaut) : 1) Réception : contrôle des produits, lots et écarts, sans emplacement ;
//                            2) Rangement : une fois la réception validée, chaque produit est rescanné puis
//                               posé sur son emplacement (page Rangement du mobile).
//   'palette' : ancienne réception palette par palette, rangée pendant la réception.
const MODES_RECEPTION = ['separee', 'palette'];
async function modeReception(connexion = db) {
  const [[ligne]] = await connexion.query("SELECT valeur FROM parametres WHERE cle = 'reception_mode'");
  return MODES_RECEPTION.includes(ligne?.valeur) ? ligne.valeur : 'separee';
}

// Tout ce dont le moteur de rangement a besoin
async function parametresRangement(connexion = db) {
  return { capaciteTampon: await capaciteTampon(connexion) };
}

module.exports = { capaciteTampon, parametresRangement, delaiReclamation, tolerancePieces, modeReception, MODES_RECEPTION, TAMPON_DEFAUT, TOLERANCE_PIECES_DEFAUT };
