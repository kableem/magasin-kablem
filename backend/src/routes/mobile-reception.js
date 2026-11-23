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
const { nombre } = require('../import-resume');
const { modeReception } = require('../parametres');
const C = require('../cartons');
const P = require('../palettes-cosses');
const { avecNumeros } = require('../plan');
const { integrerEnTrop, integrerHorsImport } = require('../surplus');

const router = express.Router();
const ARRIVEE = 'COALESCE(i.date_envoi, i.date_creation)';

async function importsEnAttente(connexion, id = null) {
  const [imports] = await connexion.query(
    `SELECT i.id, i.numero_livraison, i.mode, i.emballage, i.statut, i.reception, i.reception_ecarts,
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
      avancement: { attendus: a.attendus, recus: a.recus, manquants: a.manquants, en_trop: a.en_trop, hors_import: a.hors_import, colis_recus: a.colis_recus },
      lignes: [...a.lignes.values()],
      // import résumé : références annoncées, pièces reçues / annoncées, colis et lots
      pieces: a.pieces ?? null,
      // les manquants ne sont des écarts qu'une fois la réception terminée
      anomalies: RI.anomaliesAffichees(i, a),
    };
  });
}

// GET /api/mobile/receptions
router.get('/', async (req, res, next) => {
  try {
    const liste = await importsEnAttente(db);
    // import résumé : le nombre de références annoncées (les lignes naissent au scan)
    res.json(liste.map(({ lignes, anomalies, ...i }) => ({ ...i, produits: i.pieces ? i.pieces.references.length : lignes.length })));
  } catch (err) { next(err); }
});

// GET /api/mobile/receptions/:id
router.get('/:id', async (req, res, next) => {
  try {
    const imp = (await importsEnAttente(db, Number(req.params.id))).find((i) => i.id === Number(req.params.id));
    if (!imp) return res.status(404).json({ message: 'Import introuvable' });
    // mode de réception : 'separee' (réception puis rangement) ou 'palette'
    // cartons de l'import (cosses plates reçues en cartons) ; carton_ouvert : celui de ce magasinier
    const [cartons] = await db.query(`${C.SELECT_CARTON} WHERE c.import_id = ? ORDER BY c.numero`, [imp.id]);
    const vues = [];
    for (const c of cartons) vues.push({ ...(await C.vueCarton(db, c)), ouvert_par_moi: c.statut === 'ouvert' && c.ouvert_par === req.utilisateur.id });
    // palettes de cosses (cartons et cosses séparées) ; palette_ouverte : celle de ce magasinier
    const [palettesC] = await db.query(`${P.SELECT_PALETTE} WHERE p.import_id = ? ORDER BY p.numero`, [imp.id]);
    const vuesP = [];
    for (const p of palettesC) vuesP.push({ ...(await P.vuePalette(db, p)), ouverte_par_moi: p.statut === 'ouverte' && p.ouverte_par === req.utilisateur.id });
    res.json({
      ...imp, mode_reception: await modeReception(db), palettes: await palettesImport(db, imp.id),
      cartons: vues, carton_ouvert: vues.find((v) => v.ouvert_par_moi) ?? null,
      palettes_cosses: vuesP, palette_ouverte: vuesP.find((v) => v.ouverte_par_moi) ?? null,
      // palette de connecteurs du magasin que ce magasinier a descendue pour la compléter (une seule à la fois)
      palette_descendue: await (async () => { const d = await P.paletteDescendue(db, req.utilisateur.id); return d ? P.vuePalette(db, d) : null; })(),
      // l'import a des connecteurs : leurs cartons se reçoivent sur palette
      a_des_connecteurs: (await db.query("SELECT 1 FROM receptions WHERE import_id = ? AND type = 'connecteur' UNION SELECT 1 FROM imports_attendus WHERE import_id = ? AND type = 'connecteur' LIMIT 1", [imp.id, imp.id]))[0].length > 0,
    });
  } catch (err) { next(err); }
});

const MESSAGES = {
  manquant: (a) => `Réception mobile : ${a.recus}/${a.attendue} reçu(s), ${a.quantite} manquant(s). Créée automatiquement.`,
  pieces_manquantes: (a) => `Import résumé : ${nombre(a.recues)} pièces reçues sur ${nombre(a.attendues)} annoncées (${a.colis} colis), ${nombre(a.quantite)} manquantes. Créée automatiquement.`,
  pieces_en_trop: (a) => `Import résumé : ${nombre(a.recues)} pièces reçues pour ${nombre(a.attendues)} annoncées (${a.colis} colis), ${nombre(a.quantite)} en trop (au stock). Créée automatiquement.`,
  en_trop: (a, separee) => `Colis en trop à la réception mobile : ${separee ? 'entré au stock' : 'mis de côté, hors stock'}. Créée automatiquement.`,
  hors_import: (a, separee) => `Produit scanné mais absent de l'import : ${separee ? 'entré au stock (si sa référence est au catalogue Articles)' : 'mis de côté, hors stock'}. Créée automatiquement.`,
};

// POST /api/mobile/receptions/:id/terminer
router.post('/:id/terminer', async (req, res, next) => {
  const id = Number(req.params.id);
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion);
    await connexion.beginTransaction();
    const [[imp]] = await connexion.query('SELECT id, statut, mode, reception, numero_livraison FROM imports WHERE id = ? FOR UPDATE', [id]);
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
    // Palette de connecteurs du magasin descendue pour être complétée : d'abord la remettre à sa place
    const [[descendue]] = await connexion.query('SELECT numero, emplacement FROM palettes_cosses WHERE descendue_import = ? LIMIT 1', [id]);
    if (descendue) {
      await connexion.rollback();
      return res.status(409).json({
        code: 'palette_descendue',
        message: avecNumeros(`La palette descendue de ${descendue.emplacement} n'est pas remise à sa place : touchez « Terminer », remettez-la en ${descendue.emplacement} et scannez son étiquette, puis terminez la réception.`),
      });
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
    // Réception séparée : réclamations automatiques, et tout ce qui est reçu entre au stock sans validation du chef
    const separee = (await modeReception(connexion)) === 'separee';
    if (separee) {
      // Cartons : ceux qui contiennent des cosses sont terminés (ils attendent leur étiquette), les vides annulés
      await connexion.query(
        `UPDATE cartons c SET c.statut = 'termine', c.date_termine = NOW()
         WHERE c.import_id = ? AND c.statut = 'ouvert' AND EXISTS (SELECT 1 FROM controles_mobile x WHERE x.carton_id = c.id)`,
        [id]
      );
      await connexion.query("DELETE FROM cartons WHERE import_id = ? AND statut = 'ouvert'", [id]);
      // Palettes de cosses : celles qui portent des cosses sont terminées (prêtes à ranger), les vides annulées
      await connexion.query(
        `UPDATE palettes_cosses p SET p.statut = 'terminee', p.date_terminee = NOW()
         WHERE p.import_id = ? AND p.statut = 'ouverte' AND EXISTS (SELECT 1 FROM controles_mobile x WHERE x.palette_cosses_id = p.id)`,
        [id]
      );
      await connexion.query("DELETE FROM palettes_cosses WHERE import_id = ? AND statut = 'ouverte'", [id]);
    }
    if (imp.mode === 'resume') {
      // Import résumé : chaque ligne référence + lot compte exactement les colis reçus (colis retirés d'une palette compris)
      await connexion.query(
        `UPDATE receptions r SET r.quantite = (SELECT COUNT(*) FROM controles_mobile c
                                               WHERE c.reception_id = r.id AND c.controle = 'reception' AND c.resultat = 'conforme')
         WHERE r.import_id = ?`,
        [id]
      );
      await connexion.query('DELETE FROM receptions WHERE import_id = ? AND quantite = 0', [id]);
    }
    const av = (await RI.avancement(connexion, [id])).get(id);
    if (av.colis_recus === 0 && av.hors_import === 0) {
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
      } else if (a.unite === 'pieces') {
        // import résumé : écart de pièces d'une référence, au-delà de la tolérance
        await connexion.query(
          `INSERT INTO reclamations (reception_id, import_id, reference, lot, quantite, unite, motif, commentaire, utilisateur_id, origine)
           VALUES (NULL, ?, ?, NULL, ?, 'pieces', ?, ?, ?, 'reception_mobile')`,
          [id, a.reference, a.quantite, a.type === 'pieces_en_trop' ? 'non_commande' : 'manquant', MESSAGES[a.type](a), req.utilisateur.id]
        );
      } else {
        // colis en trop / hors import : pas de ligne d'import, rien n'est déduit du stock
        await connexion.query(
          `INSERT INTO reclamations (reception_id, import_id, reference, lot, quantite, motif, commentaire, utilisateur_id, origine)
           VALUES (NULL, ?, ?, ?, ?, 'non_commande', ?, ?, 'reception_mobile')`,
          [id, a.reference, a.lot, a.quantite, MESSAGES[a.type](a, separee), req.utilisateur.id]
        );
      }
      creees++;
    }

    // Réception séparée : les colis en trop et les produits hors import (au catalogue) entrent au stock
    let horsImport = { integres: [], en_attente: [] };
    if (separee) {
      await integrerEnTrop(connexion, av);
      horsImport = await integrerHorsImport(connexion, id, req.utilisateur.id);
    }

    await connexion.query(
      `UPDATE imports SET reception = 'terminee', reception_debut = COALESCE(reception_debut, NOW()), reception_fin = NOW(),
              reception_par = ?, reception_ecarts = ? WHERE id = ?`,
      [req.utilisateur.id, av.anomalies.length, id]
    );

    // Ajout au stock automatique, dans l'ordre d'arrivée : sans écart, ou toujours en réception séparée
    let ajoutes = [];
    let bloquePar = null;
    if (!av.anomalies.length || separee) {
      ajoutes = await ajoutsAutomatiques(connexion);
      if (!ajoutes.includes(id)) bloquePar = await importPrecedentEnAttente(connexion, id);
    }
    await connexion.commit();
    res.json({
      etape: ajoutes.includes(id) ? 'ajoute' : av.anomalies.length && !separee ? 'a_valider' : 'receptionne',
      hors_import_en_attente: horsImport.en_attente, // références absentes du catalogue : pas encore au stock
      ajoute: ajoutes.includes(id),
      ajoutes_automatiquement: ajoutes,
      bloque_par: bloquePar,
      reclamations_creees: creees,
      anomalies: av.anomalies,
      avancement: { attendus: av.attendus, recus: av.recus, manquants: av.manquants, en_trop: av.en_trop, hors_import: av.hors_import, colis_recus: av.colis_recus },
      pieces: av.pieces ?? null,
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
