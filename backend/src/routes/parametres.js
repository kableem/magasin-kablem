const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { capaciteTampon, delaiReclamation, modeReception, MODES_RECEPTION } = require('../parametres');
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
      reclamation_delai_jours: await delaiReclamation(),
      reception_mode: await modeReception(),
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

// PUT /api/parametres/reception  { mode } (administrateur, chef de magasin)
//   mode : 'separee' (réception puis rangement, séparés) ou 'palette' (rangement pendant la réception)
router.put('/reception', exigerGestionnaire(), async (req, res, next) => {
  try {
    if (!MODES_RECEPTION.includes(req.body?.mode)) return res.status(400).json({ message: 'Mode de réception : separee ou palette' });
    await db.query(
      "INSERT INTO parametres (cle, valeur) VALUES ('reception_mode', ?) ON DUPLICATE KEY UPDATE valeur = VALUES(valeur)",
      [req.body.mode]
    );
    res.json({ reception_mode: req.body.mode });
  } catch (err) { next(err); }
});

// ---------- Mails d'alerte au service logistique (administrateur) ----------
// Une sortie urgente pas terminée depuis plus de N minutes (2 h par défaut) : un seul mail aux adresses réglées ici.
const M = require('../mails');
const exigerAdmin = (req, res, next) => (req.utilisateur?.role === 'admin' ? next() : res.status(403).json({ message: "Réservé à l'administrateur" }));

// GET /api/parametres/mails
router.get('/mails', exigerAdmin, async (req, res, next) => {
  try {
    const r = await M.reglages();
    res.json({ ...r, compte: M.nomCompte() });
  } catch (err) { next(err); }
});

// PUT /api/parametres/mails  { destinataires: "a@x.tn, b@x.tn", minutes: 120 }
router.put('/mails', exigerAdmin, async (req, res, next) => {
  try {
    const { adresses, erreur } = M.lireAdresses(req.body?.destinataires);
    if (erreur) return res.status(400).json({ message: erreur });
    const minutes = Number(req.body?.minutes ?? M.MINUTES_DEFAUT);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return res.status(400).json({ message: 'La durée doit être entre 1 et 1440 minutes' });
    await db.query(
      "INSERT INTO parametres (cle, valeur) VALUES ('mail_logistique', ?), ('mail_urgence_minutes', ?) ON DUPLICATE KEY UPDATE valeur = VALUES(valeur)",
      [adresses.join(', '), String(minutes)]
    );
    res.json({ destinataires: adresses, minutes });
  } catch (err) { next(err); }
});

// POST /api/parametres/mails/essai : mail d'essai aux adresses enregistrées
router.post('/mails/essai', exigerAdmin, async (req, res, next) => {
  try {
    const { destinataires } = await M.reglages();
    if (!destinataires.length) return res.status(400).json({ message: "Enregistrez d'abord au moins une adresse du service logistique" });
    try {
      await M.envoyerEssai(destinataires);
    } catch (err) {
      if (err.status) throw err;
      return res.status(502).json({ message: `Mail non envoyé : ${err.message}` });
    }
    res.json({ message: `Mail d'essai envoyé à ${destinataires.join(', ')}` });
  } catch (err) { next(err); }
});

module.exports = router;
