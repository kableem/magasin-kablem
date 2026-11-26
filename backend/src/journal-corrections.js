// Corrections de la réception mobile notées dans le Journal des alertes (migration 044, décision du 2026-11-25).
// Une ligne de contrôle « correction » par correction : qui, quand, quelle référence, quel lot, et le détail.
// Elle ne porte ni ligne d'import, ni carton, ni palette, ni ticket : aucun compte de la réception ne change.
const crypto = require('crypto');

// « K0902|202614653-2|3 » -> 3
const colisDuTicket = (ticket) => {
  const n = Number(String(ticket ?? '').split('|')[2]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Texte d'une cosse ou d'un colis : « F0411 lot 202615600 colis n° 3 »
const nomColis = (x) => [x.reference, x.lot ? `lot ${x.lot}` : null, colisDuTicket(x.ticket) ? `colis n° ${colisDuTicket(x.ticket)}` : null].filter(Boolean).join(' ');

async function noterCorrection(connexion, req, { importId = null, reference = null, lot = null, message }) {
  await connexion.query(
    `INSERT INTO controles_mobile (uuid, controle, resultat, reference, lot, import_id, message, reponse, utilisateur_id)
     VALUES (?, 'correction', 'correction', ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), reference, lot, importId, `Correction : ${message}`.slice(0, 255), JSON.stringify({ message }), req.utilisateur.id]
  );
}

module.exports = { noterCorrection, nomColis };
