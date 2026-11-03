const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { verifierToken } = require('../middleware/auth');

const router = express.Router();

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

    await db.query('UPDATE utilisateurs SET derniere_connexion = NOW() WHERE id = ?', [utilisateur.id]);

    const profil = {
      id: utilisateur.id,
      matricule: utilisateur.matricule,
      nom: utilisateur.nom,
      prenom: utilisateur.prenom,
      role: utilisateur.role,
    };
    const token = jwt.sign(profil, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    });
    res.json({ token, utilisateur: profil });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', verifierToken, (req, res) => {
  const { id, matricule, nom, prenom, role } = req.utilisateur;
  res.json({ id, matricule, nom, prenom, role });
});

module.exports = router;
