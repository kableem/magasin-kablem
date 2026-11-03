const jwt = require('jsonwebtoken');

// Vérifie le jeton JWT envoyé dans l'en-tête Authorization: Bearer <token>
function verifierToken(req, res, next) {
  const entete = req.headers.authorization || '';
  const token = entete.startsWith('Bearer ') ? entete.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Authentification requise' });

  try {
    req.utilisateur = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Session expirée, veuillez vous reconnecter' });
  }
}

// Rôles qui gèrent le magasin (emplacements, paramètres, plan de rangement) :
// l'administrateur et le chef de magasin. Seul l'administrateur gère les utilisateurs.
const GESTIONNAIRES = ['admin', 'chef_magasin'];

function estGestionnaire(utilisateur) {
  return GESTIONNAIRES.includes(utilisateur?.role);
}

// Rôles qui travaillent au magasin (stock, imports, exports, mobile…).
// Le planificateur n'y a pas accès : il ne gère que le catalogue des articles.
const ROLES_MAGASIN = ['admin', 'chef_magasin', 'magasinier'];
const LIBELLES = { admin: "l'administrateur", chef_magasin: 'au chef de magasin', magasinier: 'au magasinier', planificateur: 'au planificateur' };

// Réserve une route à certains rôles (à placer après verifierToken)
function exigerRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.utilisateur?.role)) {
      const message = req.utilisateur?.role === 'planificateur'
        ? 'Le planificateur a accès uniquement à la gestion des articles'
        : roles.includes('chef_magasin')
          ? "Accès réservé à l'administrateur et au chef de magasin"
          : `Accès réservé à ${roles.map((r) => LIBELLES[r]).join(' et ')}`;
      return res.status(403).json({ message });
    }
    next();
  };
}

const exigerGestionnaire = () => exigerRole(...GESTIONNAIRES);
const exigerMagasin = () => exigerRole(...ROLES_MAGASIN);

module.exports = { verifierToken, exigerRole, exigerGestionnaire, exigerMagasin, estGestionnaire, GESTIONNAIRES, ROLES_MAGASIN };
