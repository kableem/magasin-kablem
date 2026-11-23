// Un seul téléphone à la fois par compte (migration 043, décisions du 2026-11-19).
// Chaque personne a son matricule : quand un compte est connecté sur un téléphone, une 2e connexion mobile est
// toujours refusée. Le compte se libère seulement par « Se déconnecter » sur ce téléphone, ou par l'administrateur
// sur le web (page Utilisateurs → « Libérer »), ou tout seul après 30 minutes sans aucune action sur le téléphone
// (aucun scan, aucun écran ouvert) : le téléphone est alors déconnecté et revient à l'écran de connexion.
//   utilisateurs.session_mobile    : numéro de la session mobile en cours (NULL : aucune)
//   utilisateurs.session_mobile_vu : dernière action du téléphone
const crypto = require('crypto');
const db = require('./db');

const INACTIVITE_MINUTES = 30; // sans aucune action : déconnecté
const MAJ_SECONDES = 20; // la dernière action n'est réécrite qu'au plus toutes les 20 s

// Durée d'une connexion, en minutes (« 8h », « 30m », « 3600 » secondes) : au-delà, le jeton du téléphone est expiré
function dureeMinutes(texte = process.env.JWT_EXPIRES_IN || '8h') {
  const m = /^(\d+)\s*([smhd]?)$/i.exec(String(texte).trim());
  if (!m) return 8 * 60;
  const n = Number(m[1]);
  const unite = (m[2] || 's').toLowerCase();
  return Math.max(1, Math.ceil(unite === 'd' ? n * 1440 : unite === 'h' ? n * 60 : unite === 'm' ? n : n / 60));
}

// Compte connecté en ce moment sur un téléphone (session ouverte, une action il y a moins de 30 min)
const SQL_EN_LIGNE = () => `(session_mobile IS NOT NULL AND session_mobile_vu > NOW() - INTERVAL ${Math.min(INACTIVITE_MINUTES, dureeMinutes())} MINUTE)`;

const heure = (d) => new Date(d).toLocaleTimeString('fr-FR', { timeZone: 'Africa/Tunis', hour: '2-digit', minute: '2-digit' });

// Nouvelle session mobile ; erreur 409 si le compte est déjà connecté sur un téléphone
async function ouvrir(utilisateurId) {
  const [[u]] = await db.query(`SELECT session_mobile_vu, ${SQL_EN_LIGNE()} AS en_ligne FROM utilisateurs WHERE id = ?`, [utilisateurId]);
  if (u && Number(u.en_ligne)) {
    throw Object.assign(
      new Error(`Ce compte est déjà connecté sur un autre téléphone (dernière action à ${heure(u.session_mobile_vu)}). Touchez « Se déconnecter » sur ce téléphone, ou demandez à l'administrateur de libérer le compte sur le web. Sans action pendant ${INACTIVITE_MINUTES} minutes, il se déconnecte tout seul.`),
      { status: 409, codeMetier: 'session_en_ligne' }
    );
  }
  const session = crypto.randomBytes(24).toString('hex');
  await db.query('UPDATE utilisateurs SET session_mobile = ?, session_mobile_vu = NOW() WHERE id = ?', [session, utilisateurId]);
  return session;
}

// La session du jeton est-elle toujours valable ? null si oui, sinon le message pour le téléphone.
// Chaque appel du téléphone (scan, écran ouvert) compte comme une action.
async function verifier(utilisateurId, session) {
  const [[u]] = await db.query(
    'SELECT session_mobile, TIMESTAMPDIFF(SECOND, session_mobile_vu, NOW()) AS depuis FROM utilisateurs WHERE id = ?',
    [utilisateurId]
  );
  if (!u || u.session_mobile !== session) return MESSAGE_REMPLACEE;
  const depuis = u.depuis === null ? Infinity : Number(u.depuis);
  if (depuis >= INACTIVITE_MINUTES * 60) {
    await fermer(utilisateurId, session);
    return MESSAGE_INACTIF;
  }
  if (depuis >= MAJ_SECONDES) {
    await db.query('UPDATE utilisateurs SET session_mobile_vu = NOW() WHERE id = ? AND session_mobile = ?', [utilisateurId, session]);
  }
  return null;
}

// « Se déconnecter » sur le téléphone : seulement sa propre session
async function fermer(utilisateurId, session) {
  await db.query('UPDATE utilisateurs SET session_mobile = NULL, session_mobile_vu = NULL WHERE id = ? AND session_mobile = ?', [utilisateurId, session]);
}

// Administrateur (web) : libère le compte (téléphone perdu, déchargé, cassé…)
async function liberer(utilisateurId) {
  const [r] = await db.query('UPDATE utilisateurs SET session_mobile = NULL, session_mobile_vu = NULL WHERE id = ?', [utilisateurId]);
  return r.affectedRows > 0;
}

const MESSAGE_REMPLACEE = "Votre compte a été libéré par l'administrateur : reconnectez-vous.";
const MESSAGE_INACTIF = `Déconnecté après ${INACTIVITE_MINUTES} minutes sans action : reconnectez-vous.`;

module.exports = { ouvrir, verifier, fermer, liberer, SQL_EN_LIGNE, dureeMinutes, INACTIVITE_MINUTES, MESSAGE_REMPLACEE, MESSAGE_INACTIF };
