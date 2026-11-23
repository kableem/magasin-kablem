const jwt = require('jsonwebtoken');

// Rôles de l'application (le rôle « planificateur » a été supprimé le 2026-11-12)
const ROLES = ['admin', 'chef_magasin', 'magasinier'];
const MESSAGE_ROLE_SUPPRIME = "Ce rôle n'existe plus dans l'application : demandez à l'administrateur de changer votre rôle.";

// Vérifie le jeton JWT envoyé dans l'en-tête Authorization: Bearer <token>
// Un jeton d'un rôle qui n'existe plus (ex. planificateur) est refusé tout de suite.
function verifierToken(req, res, next) {
  const entete = req.headers.authorization || '';
  const token = entete.startsWith('Bearer ') ? entete.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Authentification requise' });

  let utilisateur;
  try {
    utilisateur = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Session expirée, veuillez vous reconnecter' });
  }
  if (!ROLES.includes(utilisateur?.role)) return res.status(401).json({ message: MESSAGE_ROLE_SUPPRIME });
  req.utilisateur = utilisateur;
  if (!utilisateur.sm) return next();
  // Jeton du mobile : sa session doit être celle du compte (un seul téléphone à la fois, migration 043)
  const S = require('../session-mobile');
  S.verifier(utilisateur.id, utilisateur.sm)
    .then((refus) => (refus ? res.status(401).json({ message: refus, code: 'session_fermee' }) : next()))
    .catch(next);
}

// Rôles qui gèrent le magasin (emplacements, paramètres, plan de rangement) :
// l'administrateur et le chef de magasin. Seul l'administrateur gère les utilisateurs.
const GESTIONNAIRES = ['admin', 'chef_magasin'];

function estGestionnaire(utilisateur) {
  return GESTIONNAIRES.includes(utilisateur?.role);
}

// Rôles qui travaillent au magasin (stock, imports, exports, mobile…)
const ROLES_MAGASIN = ['admin', 'chef_magasin', 'magasinier'];
const LIBELLES = { admin: "l'administrateur", chef_magasin: 'au chef de magasin', magasinier: 'au magasinier' };

// Réserve une route à certains rôles (à placer après verifierToken)
function exigerRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.utilisateur?.role)) {
      const message = roles.includes('chef_magasin')
        ? "Accès réservé à l'administrateur et au chef de magasin"
        : `Accès réservé à ${roles.map((r) => LIBELLES[r]).join(' et ')}`;
      return res.status(403).json({ message });
    }
    next();
  };
}

const exigerGestionnaire = () => exigerRole(...GESTIONNAIRES);
const exigerMagasin = () => exigerRole(...ROLES_MAGASIN);

module.exports = { verifierToken, exigerRole, exigerGestionnaire, exigerMagasin, estGestionnaire, GESTIONNAIRES, ROLES_MAGASIN, ROLES, MESSAGE_ROLE_SUPPRIME };
