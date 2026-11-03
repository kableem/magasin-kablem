const express = require('express');
const db = require('../db');

const router = express.Router();

// La quantité n'est jamais saisie ici : elle évolue uniquement par les mouvements (import / export)
function champs(body) {
  const { reference, nom, description, unite, seuil_min, prix, categorie_id } = body;
  return [
    reference?.trim() || null,
    nom.trim(),
    description || null,
    unite || 'pièce',
    Number(seuil_min) || 0,
    Number(prix) || 0,
    categorie_id || null,
  ];
}

// GET /api/produits  (avec la répartition par emplacement)
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT p.*, c.nom AS categorie,
              (SELECT JSON_ARRAYAGG(JSON_OBJECT('code', e.code, 'quantite', s.quantite))
                 FROM stock s JOIN emplacements e ON e.id = s.emplacement_id
                WHERE s.produit_id = p.id AND s.quantite > 0) AS emplacements
       FROM produits p LEFT JOIN categories c ON c.id = p.categorie_id
       ORDER BY p.nom`
    );
    res.json(rows.map((r) => ({ ...r, emplacements: r.emplacements || [] })));
  } catch (err) { next(err); }
});

// GET /api/produits/:id
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await db.query('SELECT * FROM produits WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Article introuvable' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/produits
router.post('/', async (req, res, next) => {
  try {
    if (!req.body.nom?.trim()) return res.status(400).json({ message: 'La désignation est obligatoire' });
    const [result] = await db.query(
      `INSERT INTO produits (reference, nom, description, unite, seuil_min, prix, categorie_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      champs(req.body)
    );
    res.status(201).json({ id: result.insertId, ...req.body, quantite: 0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Cette référence existe déjà' });
    next(err);
  }
});

// PUT /api/produits/:id
router.put('/:id', async (req, res, next) => {
  try {
    if (!req.body.nom?.trim()) return res.status(400).json({ message: 'La désignation est obligatoire' });
    const [result] = await db.query(
      `UPDATE produits SET reference = ?, nom = ?, description = ?, unite = ?, seuil_min = ?, prix = ?, categorie_id = ?
       WHERE id = ?`,
      [...champs(req.body), req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Article introuvable' });
    res.json({ id: Number(req.params.id), ...req.body });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Cette référence existe déjà' });
    next(err);
  }
});

// DELETE /api/produits/:id  (interdit s'il reste du stock ou un historique de mouvements)
router.delete('/:id', async (req, res, next) => {
  try {
    const [rows] = await db.query('SELECT quantite FROM produits WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Article introuvable' });
    if (rows[0].quantite > 0) {
      return res.status(400).json({ message: 'Article encore en stock : faites une sortie avant de le supprimer' });
    }
    await db.query('DELETE FROM produits WHERE id = ?', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: "Impossible : cet article a un historique d'import / export" });
    }
    next(err);
  }
});

module.exports = router;
