// Réception d'un import sur le mobile : relie les colis scannés à l'import du web.
//
//   GET  /api/mobile/receptions            imports en attente, dans l'ordre d'arrivée, avec leur avancement
//   GET  /api/mobile/receptions/:id        détail : produits reçus / attendus, écarts
//   POST /api/mobile/receptions/:id/terminer
//        - sans écart : l'import passe au stock automatiquement (dans l'ordre d'arrivée) ;
//        - avec écart : réclamations créées automatiquement (manquant, colis en trop, hors import),
//          l'import est « à valider » par le chef sur le web.
// Les colis eux-mêmes sont scannés par POST /api/mobile/reception { import_id, qr }.
const express = require('express');
const db = require('../db');
const RI = require('../reception-import');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const { ajoutsAutomatiques, importPrecedentEnAttente } = require('./imports');
const { palettesImport } = require('../palettes');

const router = express.Router();
const ARRIVEE = 'COALESCE(i.date_envoi, i.date_creation)';

async function importsEnAttente(connexion, id = null) {
  const [imports] = await connexion.query(
    `SELECT i.id, i.numero_livraison, i.statut, i.reception, i.reception_ecarts,
            DATE_FORMAT(${ARRIVEE}, '%Y-%m-%dT%H:%i:%s') AS arrivee,
            DATE_FORMAT(i.reception_fin, '%Y-%m-%dT%H:%i:%s') AS reception_fin,
            u.matricule AS reception_par
     FROM imports i LEFT JOIN utilisateurs u ON u.id = i.reception_par
     WHERE i.statut = 'en_attente' ${id ? 'OR i.id = ?' : ''}
     ORDER BY ${ARRIVEE}, i.id`,
    id ? [id] : []
  );
  const av = await RI.avancement(connexion, imports.map((i) => i.id));
  let rang = 0;
  // Réception dans l'ordre d'arrivée : seule la plus ancienne réception non terminée est ouverte
  let ouverte = null;
  return imports.map((i) => {
    const a = av.get(i.id);
    const ordre = i.statut === 'en_attente' ? ++rang : null;
    let bloquePar = null;
    if (i.statut === 'en_attente' && i.reception !== 'terminee') {
      if (ouverte) bloquePar = { id: ouverte.id, numero_livraison: ouverte.numero_livraison, arrivee: ouverte.arrivee };
      else ouverte = i;
    }
    return {
      ...i,
      ordre,
      prochain: ordre === 1, // le prochain à ajouter au stock
      bloque: !!bloquePar, // réception pas encore possible : un import plus ancien n'est pas terminé
      bloque_par: bloquePar,
      etape: RI.etape(i, a),
      avancement: { attendus: a.attendus, recus: a.recus, manquants: a.manquants, en_trop: a.en_trop, hors_import: a.hors_import },
      lignes: [...a.lignes.values()],
      // les manquants ne sont des écarts qu'une fois la réception terminée
      anomalies: i.reception === 'terminee' ? a.anomalies : a.anomalies.filter((x) => x.type !== 'manquant'),
    };
  });
}

// GET /api/mobile/receptions
router.get('/', async (req, res, next) => {
  try {
    const liste = await importsEnAttente(db);
    res.json(liste.map(({ lignes, anomalies, ...i }) => ({ ...i, produits: lignes.length })));
  } catch (err) { next(err); }
});

// GET /api/mobile/receptions/:id
router.get('/:id', async (req, res, next) => {
  try {
    const imp = (await importsEnAttente(db, Number(req.params.id))).find((i) => i.id === Number(req.params.id));
    if (!imp) return res.status(404).json({ message: 'Import introuvable' });
    res.json({ ...imp, palettes: await palettesImport(db, imp.id) });
  } catch (err) { next(err); }
});

const MESSAGES = {
  manquant: (a) => `Réception mobile : ${a.recus}/${a.attendue} reçu(s), ${a.quantite} manquant(s). Créée automatiquement.`,
  en_trop: () => 'Colis en trop à la réception mobile : mis de côté, hors stock. Créée automatiquement.',
  hors_import: () => "Produit scanné mais absent de l'import : mis de côté, hors stock. Créée automatiquement.",
};

// POST /api/mobile/receptions/:id/terminer
router.post('/:id/terminer', async (req, res, next) => {
  const id = Number(req.params.id);
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion);
    await connexion.beginTransaction();
    const [[imp]] = await connexion.query('SELECT id, statut, reception, numero_livraison FROM imports WHERE id = ? FOR UPDATE', [id]);
    if (!imp) {
      await connexion.rollback();
      return res.status(404).json({ message: 'Import introuvable' });
    }
    if (imp.statut !== 'en_attente' || imp.reception === 'terminee') {
      // déjà terminée (renvoi après coupure, autre magasinier) : on renvoie l'état
      await connexion.rollback();
      const etat = (await importsEnAttente(db, id)).find((i) => i.id === id);
      return res.json({ deja_terminee: true, etape: etat?.etape, anomalies: etat?.anomalies ?? [], ajoute: imp.statut === 'ajoute' });
    }
    // Palettes : les vides sont abandonnées ; toutes les autres doivent être posées
    await connexion.query(
      `DELETE p FROM palettes_reception p
       WHERE p.import_id = ? AND p.statut = 'ouverte' AND NOT EXISTS (SELECT 1 FROM controles_mobile c WHERE c.palette_id = p.id)`,
      [id]
    );
    const [enCours] = await connexion.query("SELECT numero FROM palettes_reception WHERE import_id = ? AND statut <> 'rangee' ORDER BY numero", [id]);
    if (enCours.length) {
      await connexion.rollback();
      const liste = enCours.map((p) => p.numero).join(', ');
      return res.status(409).json({
        message: `Palette${enCours.length > 1 ? 's' : ''} ${liste} pas encore rangée${enCours.length > 1 ? 's' : ''} : terminez-la et posez-la avant de terminer la réception.`,
        palettes: enCours.map((p) => p.numero),
      });
    }
    const av = (await RI.avancement(connexion, [id])).get(id);
    if (av.recus === 0 && av.hors_import === 0) {
      await connexion.rollback();
      return res.status(400).json({ message: "Aucun colis scanné pour cet import : scannez les tickets avant de terminer la réception." });
    }

    // Réclamations automatiques pour chaque écart
    const [existantes] = await connexion.query(
      'SELECT reception_id FROM reclamations WHERE reception_id IN (SELECT id FROM receptions WHERE import_id = ?)',
      [id]
    );
    const dejaReclame = new Set(existantes.map((r) => r.reception_id));
    let creees = 0;
    for (const a of av.anomalies) {
      if (a.type === 'manquant') {
        if (dejaReclame.has(a.reception_id)) continue; // une réclamation manuelle existe déjà sur ce produit
        const l = av.lignes.get(a.reception_id);
        await connexion.query(
          `INSERT INTO reclamations (reception_id, import_id, quantite, motif, commentaire, utilisateur_id, origine)
           VALUES (?, ?, ?, 'manquant', ?, ?, 'reception_mobile')`,
          [a.reception_id, id, a.quantite, MESSAGES.manquant({ ...l, quantite: a.quantite }), req.utilisateur.id]
        );
      } else {
        // colis en trop / hors import : pas de ligne d'import, rien n'est déduit du stock
        await connexion.query(
          `INSERT INTO reclamations (reception_id, import_id, reference, lot, quantite, motif, commentaire, utilisateur_id, origine)
           VALUES (NULL, ?, ?, ?, ?, 'non_commande', ?, ?, 'reception_mobile')`,
          [id, a.reference, a.lot, a.quantite, MESSAGES[a.type](), req.utilisateur.id]
        );
      }
      creees++;
    }

    await connexion.query(
      `UPDATE imports SET reception = 'terminee', reception_debut = COALESCE(reception_debut, NOW()), reception_fin = NOW(),
              reception_par = ?, reception_ecarts = ? WHERE id = ?`,
      [req.utilisateur.id, av.anomalies.length, id]
    );

    // Sans écart : ajout au stock automatique, dans l'ordre d'arrivée
    let ajoutes = [];
    let bloquePar = null;
    if (!av.anomalies.length) {
      ajoutes = await ajoutsAutomatiques(connexion);
      if (!ajoutes.includes(id)) bloquePar = await importPrecedentEnAttente(connexion, id);
    }
    await connexion.commit();
    res.json({
      etape: ajoutes.includes(id) ? 'ajoute' : av.anomalies.length ? 'a_valider' : 'receptionne',
      ajoute: ajoutes.includes(id),
      ajoutes_automatiquement: ajoutes,
      bloque_par: bloquePar,
      reclamations_creees: creees,
      anomalies: av.anomalies,
      avancement: { attendus: av.attendus, recus: av.recus, manquants: av.manquants, en_trop: av.en_trop, hors_import: av.hors_import },
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
