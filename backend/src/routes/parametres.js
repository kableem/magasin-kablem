const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { capaciteTampon, limitesConnecteurs, delaiReclamation } = require('../parametres');
const { lignesEnStock, placesReservees } = require('./stock');
const { pdfEtiquettesTampon } = require('../etiquettes');
const { exigerGestionnaire } = require('../middleware/auth');

const router = express.Router();

// GET /api/parametres : paramètres utiles à l'affichage (tous les utilisateurs connectés)
router.get('/', async (req, res, next) => {
  try {
    res.json({
      tampon_capacite: await capaciteTampon(),
      tampon_max: R.TAMPON_MAX,
      connecteurs: await limitesConnecteurs(),
      reclamation_delai_jours: await delaiReclamation(),
    });
  } catch (err) { next(err); }
});

// PUT /api/parametres/tampon  { capacite } : nombre de places de la zone tampon (administrateur, chef de magasin)
// Impossible de supprimer des places encore occupées.
router.put('/tampon', exigerGestionnaire(), async (req, res, next) => {
  try {
    const capacite = Number(req.body.capacite);
    if (!Number.isInteger(capacite) || capacite < 1 || capacite > R.TAMPON_MAX) {
      return res.status(400).json({ message: `La capacité doit être un nombre entier entre 1 et ${R.TAMPON_MAX}` });
    }
    // Places occupées, ou réservées à une palette pas encore posée
    const [lignes] = await db.query("SELECT DISTINCT emplacement FROM placements WHERE emplacement LIKE 'T%'");
    const reservees = (await placesReservees()).map((l) => l.emplacement);
    const occupees = [...new Set([...lignes.map((l) => l.emplacement), ...reservees])]
      .filter((c) => R.estTampon(c) && Number(c.slice(1)) > capacite)
      .sort();
    if (occupees.length) {
      return res.status(409).json({
        message: `Impossible de réduire à ${capacite} places : ${occupees.join(', ')} ${occupees.length > 1 ? 'sont occupées ou réservées' : 'est occupée ou réservée'}`,
      });
    }
    await db.query(
      "INSERT INTO parametres (cle, valeur) VALUES ('tampon_capacite', ?) ON DUPLICATE KEY UPDATE valeur = VALUES(valeur)",
      [String(capacite)]
    );
    res.json({ tampon_capacite: capacite });
  } catch (err) { next(err); }
});

// GET /api/parametres/tampon/etiquettes?de=31&a=40 : étiquettes QR des places de la zone tampon (PDF)
// (administrateur, chef de magasin). Sans bornes : toutes les places.
router.get('/tampon/etiquettes', exigerGestionnaire(), async (req, res, next) => {
  try {
    const capacite = await capaciteTampon();
    const de = Math.max(1, Number(req.query.de) || 1);
    const a = Math.min(capacite, Number(req.query.a) || capacite);
    if (!Number.isInteger(de) || !Number.isInteger(a) || de > a) {
      return res.status(400).json({ message: `Indiquez des places entre T01 et ${R.codeTampon(capacite)}` });
    }
    const codes = Array.from({ length: a - de + 1 }, (_, k) => R.codeTampon(de + k));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etiquettes-tampon-${codes[0]}-${codes[codes.length - 1]}.pdf"`);
    await pdfEtiquettesTampon(codes, res);
  } catch (err) { next(err); }
});

// Bornes acceptées pour chaque limite des palettes de connecteurs
const BORNES = {
  longueur: [20, 300, 'Longueur de la palette (cm)'],
  largeur: [20, 300, 'Largeur de la palette (cm)'],
  hauteur_n3: [10, 400, 'Hauteur utile du niveau 3 (cm)'],
  hauteur_n4: [10, 400, 'Hauteur utile du niveau 4 (cm)'],
  taux: [10, 100, 'Volume utilisable (%)'],
  poids_max: [1, 2000, 'Poids maximal par palette (kg)'],
};

// PUT /api/parametres/connecteurs  { longueur, largeur, hauteur_n3, hauteur_n4, taux, poids_max }
// (administrateur, chef de magasin)
// Refusé si une palette déjà rangée ne respecterait plus les nouvelles limites.
router.put('/connecteurs', exigerGestionnaire(), async (req, res, next) => {
  try {
    const limites = {};
    for (const [nom, [min, max, libelle]] of Object.entries(BORNES)) {
      const n = Number(req.body?.[nom]);
      if (!Number.isFinite(n) || n < min || n > max) {
        return res.status(400).json({ message: `${libelle} : valeur entre ${min} et ${max}` });
      }
      limites[nom] = n;
    }

    // Les palettes de connecteurs déjà rangées doivent rester dans les nouvelles limites
    const connecteurs = (await lignesEnStock()).filter((l) => l.type === 'connecteur' && l.emplacement);
    const parPlace = new Map();
    for (const l of connecteurs) parPlace.set(l.emplacement, [...(parPlace.get(l.emplacement) ?? []), l]);
    const problemes = [];
    for (const [code, cartons] of parPlace) {
      const poses = [];
      for (const c of R.deplier(cartons)) {
        const refus = R.refusConnecteur(c, code, poses, limites);
        if (refus) { problemes.push(refus); break; }
        poses.push(c);
      }
    }
    if (problemes.length) {
      return res.status(409).json({
        message: `Impossible d'appliquer ces limites : ${problemes.slice(0, 3).join(' ; ')}${problemes.length > 3 ? ` (et ${problemes.length - 3} autre(s))` : ''}`,
      });
    }

    for (const [nom, valeur] of Object.entries(limites)) {
      await db.query(
        'INSERT INTO parametres (cle, valeur) VALUES (?, ?) ON DUPLICATE KEY UPDATE valeur = VALUES(valeur)',
        [`connecteur_${nom}`, String(valeur)]
      );
    }
    res.json({ connecteurs: limites });
  } catch (err) { next(err); }
});

// PUT /api/parametres/reclamations  { delai_jours } : délai avant qu'une réclamation non réglée soit
// en retard (administrateur, chef de magasin)
router.put('/reclamations', exigerGestionnaire(), async (req, res, next) => {
  try {
    const delai = Number(req.body?.delai_jours);
    if (!Number.isInteger(delai) || delai < 1 || delai > 365) {
      return res.status(400).json({ message: 'Le délai doit être un nombre de jours entre 1 et 365' });
    }
    await db.query(
      "INSERT INTO parametres (cle, valeur) VALUES ('reclamation_delai_jours', ?) ON DUPLICATE KEY UPDATE valeur = VALUES(valeur)",
      [String(delai)]
    );
    res.json({ reclamation_delai_jours: delai });
  } catch (err) { next(err); }
});

module.exports = router;
