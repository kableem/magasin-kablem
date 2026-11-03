const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/mouvements?type=import|export
router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query;
    const filtre = type === 'import' || type === 'export' ? 'WHERE m.type = ?' : '';
    const [rows] = await db.query(
      `SELECT m.*, p.reference, p.nom AS produit, p.unite, e.code AS emplacement,
              u.matricule AS utilisateur
       FROM mouvements m
       JOIN produits p ON p.id = m.produit_id
       JOIN emplacements e ON e.id = m.emplacement_id
       LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
       ${filtre}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 500`,
      filtre ? [type] : []
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/mouvements  { type, produit_id, emplacement_id, quantite, document, tiers, lot, commentaire }
router.post('/', async (req, res, next) => {
  const { type, produit_id, emplacement_id, document, tiers, lot, commentaire } = req.body;
  const quantite = Number(req.body.quantite);

  if (type !== 'import' && type !== 'export') return res.status(400).json({ message: 'Type invalide' });
  if (!produit_id || !emplacement_id) return res.status(400).json({ message: 'Article et emplacement obligatoires' });
  if (!Number.isInteger(quantite) || quantite <= 0) {
    return res.status(400).json({ message: 'La quantité doit être un nombre entier positif' });
  }

  const connexion = await db.getConnection();
  try {
    await connexion.beginTransaction();

    const [[produit]] = await connexion.query('SELECT id, nom, unite FROM produits WHERE id = ? FOR UPDATE', [produit_id]);
    const [[emplacement]] = await connexion.query('SELECT id, code FROM emplacements WHERE id = ?', [emplacement_id]);
    if (!produit || !emplacement) {
      await connexion.rollback();
      return res.status(404).json({ message: 'Article ou emplacement introuvable' });
    }

    if (type === 'export') {
      // Vérifie le stock disponible à cet emplacement (verrouillé pendant la transaction)
      const [[ligne]] = await connexion.query(
        'SELECT quantite FROM stock WHERE produit_id = ? AND emplacement_id = ? FOR UPDATE',
        [produit_id, emplacement_id]
      );
      const disponible = ligne?.quantite ?? 0;
      if (disponible < quantite) {
        await connexion.rollback();
        return res.status(400).json({
          message: `Stock insuffisant en ${emplacement.code} : ${disponible} ${produit.unite} disponible(s)`,
        });
      }
    }

    const signe = type === 'import' ? quantite : -quantite;
    await connexion.query(
      `INSERT INTO stock (produit_id, emplacement_id, quantite) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantite = quantite + VALUES(quantite)`,
      [produit_id, emplacement_id, signe]
    );
    await connexion.query('UPDATE produits SET quantite = quantite + ? WHERE id = ?', [signe, produit_id]);
    const [result] = await connexion.query(
      `INSERT INTO mouvements (type, produit_id, emplacement_id, quantite, document, tiers, lot, commentaire, utilisateur_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        type, produit_id, emplacement_id, quantite,
        document?.trim() || null, tiers?.trim() || null, lot?.trim() || null, commentaire?.trim() || null,
        req.utilisateur.id,
      ]
    );

    await connexion.commit();
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    connexion.release();
  }
});

module.exports = router;
