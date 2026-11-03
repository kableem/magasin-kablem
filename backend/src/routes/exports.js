const express = require('express');
const db = require('../db');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const R = require('../rangement');
const { lignesEnStock } = require('./stock');
const { estGestionnaire } = require('../middleware/auth');
const { expirerPreparations, retirerReserves } = require('../reservations');

// Stock disponible pour une sortie : en place, moins ce que les sorties du mobile ont réservé
async function stockSortie(connexion, verrou = false) {
  await expirerPreparations(connexion);
  return retirerReserves(connexion, await lignesEnStock(connexion, verrou));
}

const router = express.Router();

// Lit et contrôle { reference, quantite } (query ou body)
function lireDemande(source) {
  const reference = String(source.reference || '').trim().toUpperCase();
  const quantite = Number(source.quantite);
  if (!reference) return { erreur: 'La référence est obligatoire' };
  if (!Number.isInteger(quantite) || quantite <= 0) return { erreur: 'La quantité doit être un nombre entier positif' };
  return { reference, quantite };
}

// Prélèvements FIFO pour une référence ; { erreur } si impossible
function calculerSortie(lignes, reference, quantite) {
  const stock = lignes.filter((l) => l.reference.toUpperCase() === reference);
  const disponible = stock.reduce((s, l) => s + l.quantite, 0);
  if (!stock.length) return { erreur: `La référence ${reference} n'est pas en stock` };
  if (new Set(stock.map((l) => l.type)).size > 1) {
    return { erreur: `La référence ${reference} existe sous plusieurs types : sortie impossible` };
  }
  const prelevements = R.planSortie(stock, quantite, lignes);
  if (!prelevements) {
    return { erreur: `Stock insuffisant pour ${reference} : ${disponible} disponible(s), ${quantite} demandé(s)`, disponible };
  }
  marquerLiberees(prelevements, lignes);
  return { stock, disponible, prelevements };
}

// Places qui seront vides après la sortie (tous produits confondus, toutes références)
function marquerLiberees(prelevements, lignes) {
  const restant = new Map();
  for (const l of lignes) if (l.emplacement) restant.set(l.emplacement, (restant.get(l.emplacement) ?? 0) + l.quantite);
  for (const p of prelevements) if (p.ligne.emplacement) restant.set(p.ligne.emplacement, restant.get(p.ligne.emplacement) - p.quantite);
  for (const p of prelevements) p.libere = !!p.ligne.emplacement && restant.get(p.ligne.emplacement) === 0;
}

// Sortie choisie par l'administrateur : choix = [{ ids: [placements], quantite }].
// Renvoie { prelevements, quantite, horsFifo } ou { erreur }.
function calculerChoix(lignes, reference, choix) {
  const stock = lignes.filter((l) => l.reference.toUpperCase() === reference);
  if (!stock.length) return { erreur: `La référence ${reference} n'est pas en stock` };
  if (!Array.isArray(choix) || !choix.length) return { erreur: 'Choisissez au moins un lot à sortir' };
  const prelevements = [];
  const pris = new Set();
  for (const c of choix) {
    const q = Number(c?.quantite);
    if (!Number.isInteger(q) || q <= 0) return { erreur: 'Chaque quantité choisie doit être un nombre entier positif' };
    const ids = Array.isArray(c.ids) ? c.ids.map(Number) : [];
    const sources = stock.filter((l) => ids.includes(l.id) && !pris.has(l.id));
    sources.forEach((l) => pris.add(l.id));
    const dispo = sources.reduce((s, l) => s + l.quantite, 0);
    if (q > dispo) {
      return { erreur: `Stock insuffisant pour ${reference} sur ce lot : ${dispo} disponible(s), ${q} demandé(s). Rechargez la liste.` };
    }
    let reste = q;
    for (const l of sources) {
      if (reste <= 0) break;
      const n = Math.min(reste, l.quantite);
      prelevements.push({ ligne: l, quantite: n });
      reste -= n;
    }
  }
  const quantite = prelevements.reduce((s, p) => s + p.quantite, 0);
  // Hors FIFO si ce n'est pas exactement ce que le FIFO aurait sorti
  const cle = (p) => `${p.ligne.reception_id}|${p.ligne.emplacement}`;
  const compter = (liste) => {
    const m = new Map();
    for (const p of liste) m.set(cle(p), (m.get(cle(p)) ?? 0) + p.quantite);
    return m;
  };
  const fifo = compter(R.planSortie(stock, quantite, lignes) || []);
  const choisi = compter(prelevements);
  const horsFifo = fifo.size !== choisi.size || [...choisi].some(([k, q]) => fifo.get(k) !== q);
  marquerLiberees(prelevements, lignes);
  return { prelevements, quantite, horsFifo };
}

// Prélèvements à afficher : un même lot pris au même emplacement est regroupé en une ligne
function versJson(prelevements) {
  const lignes = [];
  for (const { ligne, quantite, libere } of prelevements) {
    const meme = lignes.find(
      (x) => x.lot === ligne.lot && x.date_reception === ligne.date_reception && x.emplacement === ligne.emplacement
    );
    if (meme) {
      meme.quantite += quantite;
      meme.place_liberee = meme.place_liberee || libere;
    } else {
      lignes.push({
        lot: ligne.lot,
        date_reception: ligne.date_reception,
        emplacement: ligne.emplacement,
        quantite,
        place_liberee: libere, // l'emplacement sera vide après la sortie
      });
    }
  }
  return lignes;
}

// GET /api/exports  -> historique des sorties, avec le détail (lot, emplacement)
router.get('/', async (req, res, next) => {
  try {
    const [exports] = await db.query(
      `SELECT e.id, DATE_FORMAT(e.date_export, '%Y-%m-%dT%H:%i:%s') AS date_export, e.reference, e.type,
              e.taille_bobine, e.quantite, e.destination, e.origine, e.motif_force, e.hors_fifo = 1 AS hors_fifo,
              u.matricule AS utilisateur
       FROM exports e LEFT JOIN utilisateurs u ON u.id = e.utilisateur_id
       ORDER BY e.date_export DESC, e.id DESC`
    );
    const [details] = await db.query(
      `SELECT export_id, lot, DATE_FORMAT(date_reception, '%Y-%m-%dT%H:%i:%s') AS date_reception, emplacement,
              CAST(SUM(quantite) AS SIGNED) AS quantite
       FROM export_details
       GROUP BY export_id, lot, date_reception, emplacement
       ORDER BY MIN(id)`
    );
    for (const e of exports) e.details = details.filter((d) => d.export_id === e.id);
    res.json(exports);
  } catch (err) { next(err); }
});

// GET /api/exports/apercu?reference=F0411&quantite=3
// Ce que le FIFO fera sortir (lot, date, emplacement), sans rien modifier.
router.get('/apercu', async (req, res, next) => {
  try {
    const demande = lireDemande(req.query);
    if (demande.erreur) return res.status(400).json({ message: demande.erreur });
    const sortie = calculerSortie(await stockSortie(db), demande.reference, demande.quantite);
    if (sortie.erreur) return res.status(409).json({ message: sortie.erreur, disponible: sortie.disponible ?? 0 });
    res.json({
      reference: demande.reference,
      quantite: demande.quantite,
      disponible: sortie.disponible,
      prelevements: versJson(sortie.prelevements),
    });
  } catch (err) { next(err); }
});

// GET /api/exports/disponible?reference=F0411  (administrateur : sortie sans FIFO)
// Tous les lots disponibles de la référence, dans l'ordre du FIFO ; ids = placements regroupés
router.get('/disponible', async (req, res, next) => {
  try {
    if (req.utilisateur.role !== 'admin') return res.status(403).json({ message: "Réservé à l'administrateur" });
    const reference = String(req.query.reference || '').trim().toUpperCase();
    if (!reference) return res.status(400).json({ message: 'La référence est obligatoire' });
    const lignes = await stockSortie(db);
    const stock = lignes.filter((l) => l.reference.toUpperCase() === reference);
    const total = stock.reduce((s, l) => s + l.quantite, 0);
    const groupes = [];
    for (const { ligne: l } of R.planSortie(stock, total, lignes) || []) {
      const meme = groupes.find((g) => g.lot === l.lot && g.date_reception === l.date_reception && g.emplacement === l.emplacement);
      if (meme) {
        meme.ids.push(l.id);
        meme.quantite += l.quantite;
      } else {
        groupes.push({ ids: [l.id], lot: l.lot, date_reception: l.date_reception, emplacement: l.emplacement, quantite: l.quantite });
      }
    }
    res.json({ reference, disponible: total, lignes: groupes });
  } catch (err) { next(err); }
});

// Destinations possibles (obligatoire)
const DESTINATIONS = ['P1', 'P2', 'P3', 'CET', 'MCW'];

// Écrit la sortie (dans la transaction en cours) : export + détail, produits retirés du stock.
// prelevements : [{ ligne (placement en stock), quantite }]. Renvoie l'identifiant de l'export.
// origine : 'mobile' (sortie contrôlée au scan) ou 'web_secours' (motif obligatoire)
// horsFifo : l'administrateur a pris au moins un produit à la place de celui proposé par le FIFO
async function enregistrerSortie(connexion, prelevements, { quantite, destination, utilisateurId, origine = 'web', motifForce = null, horsFifo = false }) {
  const premiere = prelevements[0].ligne;
  const [resultat] = await connexion.query(
    `INSERT INTO exports (reference, type, taille_bobine, quantite, destination, origine, motif_force, hors_fifo, utilisateur_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [premiere.reference, premiere.type, premiere.taille_bobine, quantite, destination, origine, motifForce, horsFifo ? 1 : 0, utilisateurId]
  );
  for (const { ligne, quantite: q } of prelevements) {
    await connexion.query(
      `INSERT INTO export_details (export_id, reception_id, lot, date_reception, emplacement, quantite)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [resultat.insertId, ligne.reception_id, ligne.lot, ligne.date_reception.replace('T', ' '), ligne.emplacement, q]
    );
    if (q === ligne.quantite) {
      await connexion.query('DELETE FROM placements WHERE id = ?', [ligne.id]);
    } else {
      await connexion.query('UPDATE placements SET quantite = quantite - ? WHERE id = ?', [q, ligne.id]);
    }
  }
  return resultat.insertId;
}

// POST /api/exports  { reference, quantite, destination, force: true, motif_force }
// Les sorties se font sur le mobile (FIFO contrôlé au scan : bon produit, bon emplacement).
// Depuis le web, c'est un secours réservé à l'administrateur et au chef, avec un motif obligatoire.
// FIFO imposé par le serveur ; les produits réservés par une sortie en cours sur le mobile sont exclus.
router.post('/', async (req, res, next) => {
  if (!estGestionnaire(req.utilisateur) || req.body?.force !== true) {
    return res.status(409).json({
      code: 'sortie_mobile_requise',
      message: "Les sorties vers la production se font sur l'application mobile (Export) : le FIFO est contrôlé au scan. Depuis le web, seul le chef peut faire une sortie de secours, avec un motif.",
    });
  }
  // Sortie choisie (sans FIFO) : administrateur seulement
  const avecChoix = req.body.choix !== undefined;
  if (avecChoix && req.utilisateur.role !== 'admin') {
    return res.status(403).json({ message: "Seul l'administrateur peut choisir les lots à sortir (sans FIFO)" });
  }
  // Motif obligatoire pour le chef ; facultatif pour l'administrateur
  const saisi = String(req.body.motif_force ?? '').trim();
  const motifForce = saisi || (req.utilisateur.role === 'admin' ? "Sortie par l'administrateur" : '');
  if (motifForce.length < 3) return res.status(400).json({ message: 'Indiquez le motif de la sortie sans contrôle mobile (ex. téléphone en panne)' });
  if (motifForce.length > 255) return res.status(400).json({ message: 'Le motif ne doit pas dépasser 255 caractères' });
  const demande = avecChoix
    ? { reference: String(req.body.reference || '').trim().toUpperCase() }
    : lireDemande(req.body || {});
  if (!demande.reference && !demande.erreur) return res.status(400).json({ message: 'La référence est obligatoire' });
  if (demande.erreur) return res.status(400).json({ message: demande.erreur });
  const destination = String(req.body.destination || '').trim().toUpperCase();
  if (!DESTINATIONS.includes(destination)) {
    return res.status(400).json({ message: 'La destination est obligatoire : P1, P2, P3, CET ou MCW' });
  }

  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion); // une opération sur le stock à la fois
    await connexion.beginTransaction();
    const lignes = await stockSortie(connexion, true);
    const sortie = avecChoix
      ? calculerChoix(lignes, demande.reference, req.body.choix)
      : { ...calculerSortie(lignes, demande.reference, demande.quantite), quantite: demande.quantite, horsFifo: false };
    if (sortie.erreur) {
      await connexion.rollback();
      return res.status(409).json({ message: sortie.erreur, disponible: sortie.disponible ?? 0 });
    }

    const premiere = sortie.prelevements[0].ligne;
    const exportId = await enregistrerSortie(connexion, sortie.prelevements, {
      quantite: sortie.quantite, destination, utilisateurId: req.utilisateur.id, origine: 'web_secours', motifForce,
      horsFifo: sortie.horsFifo,
    });

    await connexion.commit();
    res.status(201).json({
      id: exportId,
      reference: premiere.reference,
      quantite: sortie.quantite,
      hors_fifo: sortie.horsFifo,
      placesLiberees: [...new Set(sortie.prelevements.filter((p) => p.libere).map((p) => p.ligne.emplacement))],
      prelevements: versJson(sortie.prelevements),
    });
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

module.exports = router;
module.exports.calculerSortie = calculerSortie;
module.exports.calculerChoix = calculerChoix;
module.exports.enregistrerSortie = enregistrerSortie;
module.exports.lireDemande = lireDemande;
module.exports.DESTINATIONS = DESTINATIONS;
