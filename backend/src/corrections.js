// Réception mobile : plus aucune correction d'une erreur de carton, de cosse séparée ou de palette
// (décision du 2026-11-23), pour tout le monde, chef de magasin et administrateur compris.
// Refusés : mettre dans le carton une cosse reçue séparée, sortir ou retirer une cosse d'un carton,
// rouvrir un carton ou une palette, retirer un colis d'une palette.
const MESSAGE_CORRECTION =
  "Correction impossible : une erreur de carton, de cosse séparée ou de palette ne se corrige plus pendant la réception. Continuez la réception.";

function correctionInterdite(req, res) {
  res.status(403).json({ message: MESSAGE_CORRECTION, code: 'correction_interdite' });
}

module.exports = { correctionInterdite, MESSAGE_CORRECTION };
