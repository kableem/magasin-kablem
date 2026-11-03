// Réception des bobines et des cosses palette par palette, sur le mobile (étude n° 2, version 1.2).
// Une palette porte des bobines (une seule taille) ou des cosses (10 au maximum), jamais les deux.
//
//   POST   /api/mobile/palettes                         { import_id }  ouvrir une palette
//   DELETE /api/mobile/palettes/:id                      annuler une palette vide
//   DELETE /api/mobile/palettes/:id/bobines/:controle    retirer un colis scanné par erreur (palette ouverte)
//   POST   /api/mobile/palettes/:id/terminer             l'application choisit où va la palette
//   POST   /api/mobile/palettes/:id/ranger               { uuid, emplacement }  palette entière posée : 1 scan
//   POST   /api/mobile/palettes/:id/rouvrir              ajouter un colis oublié (réception pas terminée)
// Les colis (bobines, cosses) sont scannés par POST /api/mobile/reception { import_id, palette_id, qr }.
// Une palette divisée se range colis par colis par POST /api/mobile/rangement (ticket + emplacement).
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const { poserQuantite } = require('./stock');
const { receptionPrecedenteNonTerminee, messageOrdreReception } = require('./imports');
const { bobinesPalette, vuePalette, placerPalette, typePalette, nommer } = require('../palettes');
const { lireEmplacement } = require('../ticket');
const { enregistrer, operation } = require('./mobile').outils;

const router = express.Router();
const refus = (status, message) => Object.assign(new Error(message), { status });

// Transaction sous le verrou du stock ; le traitement renvoie le JSON de la réponse
function transaction(traitement) {
  return async (req, res, next) => {
    const connexion = await db.getConnection();
    try {
      await verrouillerStock(connexion);
      await connexion.beginTransaction();
      const reponse = await traitement(connexion, req);
      await connexion.commit();
      res.status(reponse?.codeHttp ?? 200).json(reponse?.codeHttp ? reponse.corps : reponse);
    } catch (err) {
      await connexion.rollback();
      next(err);
    } finally {
      await libererStock(connexion);
      connexion.release();
    }
  };
}

// Import dont la réception est ouverte (en attente, pas terminée, dans l'ordre d'arrivée)
async function importEnReception(connexion, importId) {
  const [[imp]] = await connexion.query('SELECT id, statut, reception, numero_livraison FROM imports WHERE id = ? FOR UPDATE', [importId]);
  if (!imp) throw refus(404, 'Import introuvable');
  if (imp.statut !== 'en_attente' || imp.reception === 'terminee') {
    throw refus(409, `La réception de l'import ${imp.numero_livraison ?? 'n° ' + imp.id} est terminée.`);
  }
  const avant = await receptionPrecedenteNonTerminee(connexion, imp.id);
  if (avant) throw refus(409, messageOrdreReception(avant));
  return imp;
}

async function paletteVerrouillee(connexion, id) {
  const [[p]] = await connexion.query('SELECT * FROM palettes_reception WHERE id = ? FOR UPDATE', [id]);
  if (!p) throw refus(404, 'Palette introuvable');
  return p;
}

// POST / : ouvrir une palette (ou reprendre la palette vide déjà ouverte par cet utilisateur)
router.post('/', transaction(async (connexion, req) => {
  const imp = await importEnReception(connexion, Number(req.body?.import_id));
  const [[vide]] = await connexion.query(
    `SELECT p.* FROM palettes_reception p
     WHERE p.import_id = ? AND p.statut = 'ouverte' AND p.ouverte_par = ?
       AND NOT EXISTS (SELECT 1 FROM controles_mobile c WHERE c.palette_id = p.id)
     ORDER BY p.numero LIMIT 1`,
    [imp.id, req.utilisateur.id]
  );
  if (vide) return vuePalette(connexion, vide);
  const [[{ suivant }]] = await connexion.query('SELECT COALESCE(MAX(numero), 0) + 1 AS suivant FROM palettes_reception WHERE import_id = ?', [imp.id]);
  const [r] = await connexion.query(
    'INSERT INTO palettes_reception (import_id, numero, ouverte_par) VALUES (?, ?, ?)',
    [imp.id, suivant, req.utilisateur.id]
  );
  await connexion.query(
    "UPDATE imports SET reception = 'en_cours', reception_debut = NOW() WHERE id = ? AND reception = 'non_commencee'",
    [imp.id]
  );
  return { codeHttp: 201, corps: await vuePalette(connexion, await paletteVerrouillee(connexion, r.insertId)) };
}));

// DELETE /:id : annuler une palette encore vide
router.delete('/:id', transaction(async (connexion, req) => {
  const p = await paletteVerrouillee(connexion, req.params.id);
  if ((await bobinesPalette(connexion, p.id)).length) throw refus(409, `La palette ${p.numero} n'est pas vide : retirez d'abord ses colis.`);
  await connexion.query('DELETE FROM palettes_reception WHERE id = ?', [p.id]);
  return { supprimee: true };
}));

// DELETE /:id/bobines/:controle : colis (bobine ou cosse) scanné par erreur, retiré de la palette ouverte.
// Il redevient « non reçu » : il se scannera sur sa vraie palette.
router.delete('/:id/bobines/:controle', transaction(async (connexion, req) => {
  const p = await paletteVerrouillee(connexion, req.params.id);
  if (p.statut !== 'ouverte') throw refus(409, `La palette ${p.numero} est terminée : rouvrez-la pour la modifier.`);
  const [[c]] = await connexion.query(
    "SELECT id FROM controles_mobile WHERE id = ? AND palette_id = ? AND controle = 'reception' AND resultat = 'conforme'",
    [req.params.controle, p.id]
  );
  if (!c) throw refus(404, "Ce colis n'est pas sur la palette");
  const bobines = await bobinesPalette(connexion, p.id);
  if (bobines.find((b) => b.controle_id === c.id)?.range) throw refus(409, 'Ce colis est déjà au stock : il ne se retire plus de la palette.');
  await connexion.query('DELETE FROM controles_mobile WHERE id = ?', [c.id]);
  // Palette de nouveau vide : elle pourra recevoir des bobines comme des cosses
  if (bobines.length === 1 && !p.emplacement) await connexion.query('UPDATE palettes_reception SET type = NULL, taille = NULL WHERE id = ?', [p.id]);
  return vuePalette(connexion, await paletteVerrouillee(connexion, p.id));
}));

// POST /:id/terminer : la palette est complète, l'application choisit où la mettre
router.post('/:id/terminer', transaction(async (connexion, req) => {
  const p = await paletteVerrouillee(connexion, req.params.id);
  await importEnReception(connexion, p.import_id);
  if (p.statut !== 'ouverte') throw refus(409, `La palette ${p.numero} est déjà terminée.`);
  // Recalcul complet si la palette a été rouverte avant d'être posée
  await connexion.query('DELETE FROM affectations_colis WHERE palette_id = ? AND range_le IS NULL', [p.id]);
  const bobines = await bobinesPalette(connexion, p.id);
  if (!bobines.length) throw refus(409, `La palette ${p.numero} est vide : scannez ses colis.`);
  if (!bobines.some((b) => !b.range)) {
    await connexion.query("UPDATE palettes_reception SET statut = 'rangee' WHERE id = ?", [p.id]);
    return vuePalette(connexion, await paletteVerrouillee(connexion, p.id));
  }
  const choix = await placerPalette(connexion, p, bobines);
  if (!choix) {
    throw refus(409, "Plus aucune place, même en zone tampon : le chef de magasin doit agrandir la zone tampon, ou rangez le magasin pour libérer des emplacements.");
  }
  for (const { bobine, emplacement } of choix.places) {
    await connexion.query(
      'INSERT INTO affectations_colis (reception_id, palette_id, ticket, colis, emplacement) VALUES (?, ?, ?, ?, ?)',
      [bobine.reception_id, p.id, bobine.ticket, bobine.colis, emplacement]
    );
  }
  await connexion.query(
    "UPDATE palettes_reception SET statut = 'terminee', mode = ?, emplacement = ?, date_terminee = NOW() WHERE id = ?",
    [choix.mode, choix.emplacement, p.id]
  );
  const vue = await vuePalette(connexion, await paletteVerrouillee(connexion, p.id));
  const motifs = new Map(choix.places.map((x) => [x.bobine.controle_id, x.motif]));
  return {
    ...vue,
    tampon: choix.emplacement ? R.estTampon(choix.emplacement) : choix.places.some((x) => R.estTampon(x.emplacement)),
    motif: choix.places[0]?.motif ?? null,
    bobines: vue.bobines.map((b) => ({ ...b, motif: motifs.get(b.controle_id) ?? null })),
  };
}));

// POST /:id/ranger { uuid, emplacement } : palette entière posée, un scan d'emplacement pour toute la palette
router.post('/:id/ranger', operation('rangement', async (connexion, req) => {
  const p = await paletteVerrouillee(connexion, req.params.id);
  if (p.statut !== 'terminee' || p.mode !== 'entiere') {
    throw refus(409, p.statut === 'rangee'
      ? `La palette ${p.numero} est déjà rangée.`
      : `La palette ${p.numero} ne se pose pas en un bloc : rangez ses ${typePalette(p) === 'cosse' ? 'cosses' : 'bobines'} une par une.`);
  }
  const code = lireEmplacement(req.body.emplacement);
  const aPoser = (await bobinesPalette(connexion, p.id)).filter((b) => b.emplacement && !b.range);
  const premiere = aPoser[0];
  const base = { reference: premiere?.reference ?? null, lot: premiere?.lot ?? null, import_id: p.import_id, palette_id: p.id, emplacement_scanne: code };
  if (code !== p.emplacement) {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
      ...base, emplacement_scanne: code ?? String(req.body.emplacement ?? '').slice(0, 20), reception_id: premiere?.reception_id ?? null,
      emplacements_prevus: [{ code: p.emplacement, quantite: aPoser.length }],
      message: `La palette ${p.numero} va en ${p.emplacement}, pas en ${code ?? req.body.emplacement}. Rien n'est enregistré.`,
    });
  }
  // Tous les colis entrent au stock à cet emplacement, chacun avec sa référence, son lot et son n° de colis
  let reponse = null;
  for (const [k, b] of aPoser.entries()) {
    await poserQuantite(connexion, b.reception_id, code, 1);
    await connexion.query('UPDATE affectations_colis SET range_le = NOW() WHERE id = ?', [b.affectation_id]);
    const r = await enregistrer(
      connexion,
      { ...req, body: { ...req.body, uuid: k === 0 ? req.body.uuid : crypto.randomUUID(), qr: b.ticket } },
      'rangement', 'bon_emplacement',
      {
        reference: b.reference, lot: b.lot, ticket: b.ticket, reception_id: b.reception_id, import_id: p.import_id, palette_id: p.id,
        emplacement_scanne: code, emplacements_prevus: [{ code, quantite: aPoser.length }],
        extra: { palette: { id: p.id, numero: p.numero, bobines: aPoser.length } },
        message: `Palette ${p.numero} rangée en ${code} : ${nommer(typePalette(p), aPoser.length)} ajoutée${aPoser.length > 1 ? 's' : ''} au stock.`,
      }
    );
    if (k === 0) reponse = r;
  }
  await connexion.query("UPDATE palettes_reception SET statut = 'rangee', date_rangee = NOW() WHERE id = ?", [p.id]);
  return reponse;
}));

// POST /:id/rouvrir : ajouter un colis oublié, tant que la réception n'est pas terminée
router.post('/:id/rouvrir', transaction(async (connexion, req) => {
  const p = await paletteVerrouillee(connexion, req.params.id);
  await importEnReception(connexion, p.import_id);
  if (p.statut === 'ouverte') return vuePalette(connexion, p);
  // Colis pas encore posés : leur emplacement sera recalculé à la fin de la palette
  await connexion.query('DELETE FROM affectations_colis WHERE palette_id = ? AND range_le IS NULL', [p.id]);
  await connexion.query("UPDATE palettes_reception SET statut = 'ouverte' WHERE id = ?", [p.id]);
  return vuePalette(connexion, await paletteVerrouillee(connexion, p.id));
}));

module.exports = router;
