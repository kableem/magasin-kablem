const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/emplacements  (avec le contenu de chaque emplacement)
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT e.*,
              COALESCE(SUM(s.quantite), 0) AS total,
              COUNT(s.produit_id) AS nb_articles,
              JSON_ARRAYAGG(
                CASE WHEN s.produit_id IS NOT NULL THEN
                  JSON_OBJECT('produit_id', p.id, 'reference', p.reference, 'nom', p.nom,
                              'unite', p.unite, 'quantite', s.quantite)
                END
              ) AS articles
       FROM emplacements e
       LEFT JOIN stock s ON s.emplacement_id = e.id AND s.quantite > 0
       LEFT JOIN produits p ON p.id = s.produit_id
       GROUP BY e.id
       ORDER BY e.zone, e.code`
    );
    res.json(
      rows.map((r) => ({ ...r, total: Number(r.total), articles: (r.articles || []).filter(Boolean) }))
    );
  } catch (err) { next(err); }
});

function valider(body) {
  if (!body.code?.trim()) return 'Le code est obligatoire';
  if (body.capacite != null && body.capacite !== '' && Number(body.capacite) < 0) return 'Capacité invalide';
  return null;
}

function valeurs({ code, zone, description, capacite }) {
  return [
    code.trim().toUpperCase(),
    zone?.trim() || '',
    description?.trim() || null,
    capacite === '' || capacite == null ? null : Number(capacite),
  ];
}

// POST /api/emplacements
router.post('/', async (req, res, next) => {
  try {
    const erreur = valider(req.body);
    if (erreur) return res.status(400).json({ message: erreur });
    const [result] = await db.query(
      'INSERT INTO emplacements (code, zone, description, capacite) VALUES (?, ?, ?, ?)',
      valeurs(req.body)
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Ce code existe déjà' });
    next(err);
  }
});

// PUT /api/emplacements/:id
router.put('/:id', async (req, res, next) => {
  try {
    const erreur = valider(req.body);
    if (erreur) return res.status(400).json({ message: erreur });
    const [result] = await db.query(
      'UPDATE emplacements SET code = ?, zone = ?, description = ?, capacite = ? WHERE id = ?',
      [...valeurs(req.body), req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Emplacement introuvable' });
    res.json({ id: Number(req.params.id) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Ce code existe déjà' });
    next(err);
  }
});

// DELETE /api/emplacements/:id  (seulement s'il est vide et sans historique)
router.delete('/:id', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT COALESCE(SUM(quantite), 0) AS total FROM stock WHERE emplacement_id = ?',
      [req.params.id]
    );
    if (Number(rows[0].total) > 0) {
      return res.status(400).json({ message: "L'emplacement n'est pas vide" });
    }
    await db.query('DELETE FROM stock WHERE emplacement_id = ?', [req.params.id]);
    const [result] = await db.query('DELETE FROM emplacements WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Emplacement introuvable' });
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: "Impossible : cet emplacement a un historique d'import / export" });
    }
    next(err);
  }
});

module.exports = router;
