const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/categories
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await db.query('SELECT * FROM categories ORDER BY nom');
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/categories
router.post('/', async (req, res, next) => {
  try {
    const { nom } = req.body;
    if (!nom) return res.status(400).json({ message: 'Le nom est obligatoire' });
    const [result] = await db.query('INSERT INTO categories (nom) VALUES (?)', [nom]);
    res.status(201).json({ id: result.insertId, nom });
  } catch (err) { next(err); }
});

// DELETE /api/categories/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
