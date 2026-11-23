const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { verifierToken, ROLES, MESSAGE_ROLE_SUPPRIME } = require('../middleware/auth');

const router = express.Router();
const S = require('../session-mobile');

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { matricule, motDePasse } = req.body;
    if (!matricule || !motDePasse) {
      return res.status(400).json({ message: 'Matricule et mot de passe obligatoires' });
    }

    const [rows] = await db.query('SELECT * FROM utilisateurs WHERE matricule = ?', [matricule]);
    const utilisateur = rows[0];
    const valide = utilisateur && (await bcrypt.compare(motDePasse, utilisateur.mot_de_passe));
    if (!valide) return res.status(401).json({ message: 'Matricule ou mot de passe incorrect' });
    if (!utilisateur.actif) return res.status(403).json({ message: 'Compte désactivé, contactez l\'administrateur' });
    if (!ROLES.includes(utilisateur.role)) return res.status(403).json({ message: MESSAGE_ROLE_SUPPRIME });

    await db.query('UPDATE utilisateurs SET derniere_connexion = NOW() WHERE id = ?', [utilisateur.id]);

    const profil = {
      id: utilisateur.id,
      matricule: utilisateur.matricule,
      nom: utilisateur.nom,
      prenom: utilisateur.prenom,
      role: utilisateur.role,
    };
    // Téléphone (appareil = 'mobile') : un seul à la fois par compte ; refusé si le compte est déjà connecté sur un téléphone
    const sm = req.body.appareil === 'mobile' ? await S.ouvrir(utilisateur.id) : null;
    const token = jwt.sign(sm ? { ...profil, sm } : profil, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    });
    res.json({ token, utilisateur: profil });
  } catch (err) { next(err); }
});


// POST /api/auth/deconnexion : le téléphone libère son compte tout de suite
router.post('/deconnexion', verifierToken, async (req, res, next) => {
  try {
    if (req.utilisateur.sm) await S.fermer(req.utilisateur.id, req.utilisateur.sm);
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', verifierToken, (req, res) => {
  const { id, matricule, nom, prenom, role } = req.utilisateur;
  res.json({ id, matricule, nom, prenom, role });
});

module.exports = router;
