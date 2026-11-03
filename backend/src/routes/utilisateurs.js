const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

const ROLES = ['admin', 'chef_magasin', 'magasinier', 'planificateur'];
const COLONNES = 'id, matricule, nom, prenom, role, actif, derniere_connexion, created_at';

function valider({ matricule, nom, prenom, role }, motDePasse, creation) {
  if (!matricule?.trim() || !nom?.trim() || !prenom?.trim()) {
    return 'Matricule, nom et prénom sont obligatoires';
  }
  if (!/^\d{1,20}$/.test(String(matricule).trim())) return 'Le matricule doit contenir uniquement des chiffres';
  if (!ROLES.includes(role)) return 'Rôle invalide';
  if (creation && !motDePasse) return 'Le mot de passe est obligatoire';
  if (motDePasse && motDePasse.length < 4) return 'Le mot de passe doit contenir au moins 4 caractères';
  return null;
}

// Empêche de retirer le dernier administrateur actif
async function dernierAdmin(id) {
  const [rows] = await db.query(
    "SELECT COUNT(*) AS n FROM utilisateurs WHERE role = 'admin' AND actif = 1 AND id <> ?",
    [id]
  );
  return rows[0].n === 0;
}

// GET /api/utilisateurs
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await db.query(`SELECT ${COLONNES} FROM utilisateurs ORDER BY created_at DESC`);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/utilisateurs
router.post('/', async (req, res, next) => {
  try {
    const { matricule, nom, prenom, role, motDePasse, actif = true } = req.body;
    const erreur = valider(req.body, motDePasse, true);
    if (erreur) return res.status(400).json({ message: erreur });

    const hash = await bcrypt.hash(motDePasse, 10);
    const [result] = await db.query(
      'INSERT INTO utilisateurs (matricule, nom, prenom, mot_de_passe, role, actif) VALUES (?, ?, ?, ?, ?, ?)',
      [matricule.trim(), nom.trim(), prenom.trim(), hash, role, actif ? 1 : 0]
    );
    const [rows] = await db.query(`SELECT ${COLONNES} FROM utilisateurs WHERE id = ?`, [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Ce matricule existe déjà' });
    next(err);
  }
});

// PUT /api/utilisateurs/:id  (mot de passe modifié seulement s'il est fourni)
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { matricule, nom, prenom, role, motDePasse, actif = true } = req.body;
    const erreur = valider(req.body, motDePasse, false);
    if (erreur) return res.status(400).json({ message: erreur });

    const [existant] = await db.query('SELECT role, actif FROM utilisateurs WHERE id = ?', [id]);
    if (!existant.length) return res.status(404).json({ message: 'Utilisateur introuvable' });

    const perdAdmin = existant[0].role === 'admin' && (role !== 'admin' || !actif);
    if (perdAdmin && (await dernierAdmin(id))) {
      return res.status(400).json({ message: 'Impossible : il doit rester au moins un administrateur actif' });
    }

    const champs = [matricule.trim(), nom.trim(), prenom.trim(), role, actif ? 1 : 0];
    let sql = 'UPDATE utilisateurs SET matricule = ?, nom = ?, prenom = ?, role = ?, actif = ?';
    if (motDePasse) {
      sql += ', mot_de_passe = ?';
      champs.push(await bcrypt.hash(motDePasse, 10));
    }
    await db.query(`${sql} WHERE id = ?`, [...champs, id]);

    const [rows] = await db.query(`SELECT ${COLONNES} FROM utilisateurs WHERE id = ?`, [id]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Ce matricule existe déjà' });
    next(err);
  }
});

// DELETE /api/utilisateurs/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.utilisateur.id) {
      return res.status(400).json({ message: 'Vous ne pouvez pas supprimer votre propre compte' });
    }
    const [existant] = await db.query('SELECT role FROM utilisateurs WHERE id = ?', [id]);
    if (!existant.length) return res.status(404).json({ message: 'Utilisateur introuvable' });
    if (existant[0].role === 'admin' && (await dernierAdmin(id))) {
      return res.status(400).json({ message: 'Impossible : il doit rester au moins un administrateur actif' });
    }

    await db.query('DELETE FROM utilisateurs WHERE id = ?', [id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
