// Palettes de cosses à la réception mobile (import avec des cosses plates, réception séparée).
// Une palette porte des cartons (références mélangées possibles) et des cosses séparées, sans limite.
// En mode Cartons, la palette s'ouvre seule au 1er scan si le magasinier n'en a pas d'ouverte ; on peut aussi
// l'ouvrir d'avance (pour y mettre des cosses séparées). « Terminer la palette » ferme aussi son carton ouvert.
//
//   POST /api/mobile/palettes-cosses               { import_id }  ouvre une palette (ou renvoie celle déjà ouverte)
//   POST /api/mobile/palettes-cosses/:id/terminer                 termine la palette (annulée si elle est vide)
//   POST /api/mobile/palettes-cosses/:id/rouvrir                  rouvre la palette (oubli), tant que la réception n'est pas terminée
const express = require('express');
const db = require('../db');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const P = require('../palettes-cosses');
const R = require('../rangement');
const K = require('../deplacer-cartons');
const { capaciteTampon } = require('../parametres');
const { lireEmplacement } = require('../ticket');
const { avecNumeros } = require('../plan');

const router = express.Router();
const { correctionInterdite } = require('../corrections'); // plus de correction à la réception (2026-11-23)
const refus = (status, message) => Object.assign(new Error(message), { status });

function transaction(traitement) {
  return async (req, res, next) => {
    const connexion = await db.getConnection();
    try {
      await verrouillerStock(connexion);
      await connexion.beginTransaction();
      const reponse = await traitement(connexion, req);
      await connexion.commit();
      res.json(reponse);
    } catch (err) {
      await connexion.rollback();
      next(err);
    } finally {
      await libererStock(connexion);
      connexion.release();
    }
  };
}

// Import dont la réception mobile est en cours
async function importEnReception(connexion, id) {
  const [[imp]] = await connexion.query('SELECT id, statut, reception, numero_livraison FROM imports WHERE id = ? FOR UPDATE', [id]);
  if (!imp) throw refus(404, 'Import introuvable');
  if (imp.statut !== 'en_attente' || imp.reception === 'terminee') {
    throw refus(409, `La réception de l'import ${imp.numero_livraison ?? 'n° ' + imp.id} est terminée : ses palettes ne se modifient plus.`);
  }
  return imp;
}

async function paletteEnReception(connexion, id) {
  const [[p]] = await connexion.query(`${P.SELECT_PALETTE} WHERE p.id = ? FOR UPDATE`, [id]);
  if (!p) throw refus(404, 'Palette introuvable');
  await importEnReception(connexion, p.import_id);
  return p;
}

// POST / { import_id } : nouvelle palette ; celle déjà ouverte par ce magasinier est renvoyée
router.post('/', transaction(async (connexion, req) => {
  const imp = await importEnReception(connexion, Number(req.body?.import_id));
  const deja = await P.paletteOuverte(connexion, imp.id, req.utilisateur.id);
  if (deja) return { palette: await P.vuePalette(connexion, deja), message: `La palette n° ${deja.numero} est déjà ouverte : terminez-la avant d'en ouvrir une autre.` };
  const p = await P.ouvrirPalette(connexion, imp.id, req.utilisateur.id);
  await connexion.query("UPDATE imports SET reception = 'en_cours', reception_debut = COALESCE(reception_debut, NOW()) WHERE id = ? AND reception = 'non_commencee'", [imp.id]);
  return { palette: await P.vuePalette(connexion, p), message: `Palette n° ${p.numero} ouverte : les cartons et les cosses séparées scannés vont dessus.` };
}));

// POST /terminer-ouverte { import_id } : termine la palette ouverte de ce magasinier dans l'import, s'il y en a une
// (envoyé depuis la file d'attente du téléphone après une coupure du Wi-Fi)
router.post('/terminer-ouverte', transaction(async (connexion, req) => {
  const imp = await importEnReception(connexion, Number(req.body?.import_id));
  const p = await P.paletteOuverte(connexion, imp.id, req.utilisateur.id);
  if (!p) return { message: 'Aucune palette ouverte : rien à terminer.' };
  return terminer(connexion, p);
}));

// POST /:id/terminer
router.post('/:id/terminer', transaction(async (connexion, req) => {
  const p = await paletteEnReception(connexion, req.params.id);
  if (p.statut !== 'ouverte') throw refus(409, `La palette n° ${p.numero} est déjà terminée.`);
  return terminer(connexion, p);
}));

async function terminer(connexion, p) {
  const r = await P.terminerPalette(connexion, p);
  if (r.supprimee) return { supprimee: true, message: `La palette n° ${p.numero} était vide : elle est annulée.` };
  const aImprimer = r.vue.etiquettes_a_imprimer;
  return {
    palette: r.vue,
    message: `Palette n° ${p.numero} terminée : ${r.vue.contenu}.${aImprimer ? ` Étiquette${aImprimer > 1 ? 's' : ''} des cartons : sur le web (page Import).` : ''} La palette suivante s'ouvre au prochain carton.`,
  };
}

// ---------- Compléter une palette de connecteurs du magasin pendant la réception (migration 041) ----------
// POST /completer { import_id, emplacement } : le magasinier a scanné l'étiquette de la place de la palette ;
// elle est « descendue » : les cartons de connecteurs qu'il scanne ensuite vont dessus. Une seule à la fois.
router.post('/completer', transaction(async (connexion, req) => {
  const imp = await importEnReception(connexion, Number(req.body?.import_id));
  const code = lireEmplacement(req.body?.emplacement);
  if (!code || !R.emplacementValide(code, await capaciteTampon(connexion))) throw refus(400, "Ce QR n'est pas l'étiquette d'un emplacement : scannez l'étiquette jaune de la place de la palette.");
  const deja = await P.paletteDescendue(connexion, req.utilisateur.id, true);
  if (deja) throw refus(409, avecNumeros(`Vous avez déjà descendu la palette de ${deja.emplacement} : remettez-la à sa place avant d'en descendre une autre.`));
  const [ici] = await connexion.query(
    `SELECT DISTINCT pl.palette_cosses_id AS id, r.type FROM placements pl JOIN receptions r ON r.id = pl.reception_id
     WHERE pl.emplacement = ? AND pl.quantite > 0`,
    [code]
  );
  const [[p]] = ici.length === 1 && ici[0].id ? await connexion.query(`${P.SELECT_PALETTE} WHERE p.id = ? FOR UPDATE`, [ici[0].id]) : [[null]];
  if (!p || p.famille !== 'connecteur' || p.statut !== 'rangee') {
    throw refus(409, avecNumeros(ici.length ? `${code} ne porte pas une palette de connecteurs : on ne complète qu'une palette de connecteurs.` : `${code} est vide : scannez l'étiquette de la place d'une palette de connecteurs.`));
  }
  if (p.descendue_par) throw refus(409, avecNumeros(`La palette de ${code} est déjà descendue par un autre magasinier.`));
  const ouverte = await P.paletteOuverte(connexion, imp.id, req.utilisateur.id);
  if (ouverte?.famille === 'connecteur' && (await P.cossesDeLaPalette(connexion, ouverte.id)).length) {
    throw refus(409, `Terminez d'abord votre palette n° ${ouverte.numero}, puis descendez la palette à compléter.`);
  }
  const lignes = (await connexion.query('SELECT DISTINCT reception_id FROM placements WHERE palette_cosses_id = ?', [p.id]))[0].map((l) => l.reception_id);
  const sortie = await K.sortieSurLeParcours(connexion, code, lignes);
  if (sortie) throw refus(409, avecNumeros(`La palette de ${code} est sur le parcours d'une sortie en cours (${sortie.quantite} × ${sortie.reference}) : attendez la fin de cette sortie.`));
  await connexion.query('UPDATE palettes_cosses SET descendue_par = ?, descendue_import = ?, descendue_le = NOW() WHERE id = ?', [req.utilisateur.id, imp.id, p.id]);
  const vue = await P.vuePalette(connexion, { ...p, descendue_par: req.utilisateur.id, descendue_import: imp.id });
  return {
    palette: vue,
    message: avecNumeros(`Palette de ${code} descendue (${vue.contenu}) : scannez les tickets des cartons de connecteurs à ajouter, puis « Terminer » et remettez-la en ${code}.`),
  };
}));

// POST /:id/remettre { emplacement } : la palette complétée est remise à sa place (obligatoirement la même)
router.post('/:id/remettre', transaction(async (connexion, req) => {
  const [[p]] = await connexion.query(`${P.SELECT_PALETTE} WHERE p.id = ? FOR UPDATE`, [Number(req.params.id)]);
  if (!p || !p.descendue_par) throw refus(404, "Cette palette n'est pas descendue.");
  if (p.descendue_par !== req.utilisateur.id) throw refus(409, 'Cette palette a été descendue par un autre magasinier.');
  const code = lireEmplacement(req.body?.emplacement);
  if (code !== p.emplacement) {
    throw Object.assign(refus(409, avecNumeros(`La palette se remet à sa place, en ${p.emplacement}${code ? `, pas en ${code}` : ''} : posez-la en ${p.emplacement} et scannez cette étiquette.`)), { codeMetier: 'faux_emplacement' });
  }
  const vue = await P.vuePalette(connexion, p);
  await connexion.query('UPDATE palettes_cosses SET descendue_par = NULL, descendue_import = NULL, descendue_le = NULL WHERE id = ?', [p.id]);
  const n = vue.a_ajouter;
  return {
    palette: { ...vue, descendue: false },
    message: avecNumeros(`Palette remise en ${p.emplacement}${n ? ` avec ${n} carton${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} : ils entrent au stock à la fin de la réception` : ''}.`),
  };
}));

// POST /:id/rouvrir : carton ou cosse oubliés ; une seule palette ouverte par magasinier
router.post('/:id/rouvrir', correctionInterdite, transaction(async (connexion, req) => {
  const p = await paletteEnReception(connexion, req.params.id);
  if (p.statut === 'ouverte') {
    if (p.ouverte_par !== req.utilisateur.id) throw refus(409, `La palette n° ${p.numero} est ouverte par un autre magasinier.`);
    return { palette: await P.vuePalette(connexion, p) };
  }
  if (p.statut === 'rangee') throw refus(409, `La palette n° ${p.numero} est déjà rangée : elle ne se rouvre plus.`);
  const autre = await P.paletteOuverte(connexion, p.import_id, req.utilisateur.id);
  if (autre) {
    if ((await P.cossesDeLaPalette(connexion, autre.id)).length) {
      throw refus(409, `Terminez d'abord la palette n° ${autre.numero}, puis rouvrez la palette n° ${p.numero}.`);
    }
    await connexion.query('DELETE FROM cartons WHERE palette_id = ?', [autre.id]);
    await connexion.query('DELETE FROM palettes_cosses WHERE id = ?', [autre.id]);
  }
  await connexion.query("UPDATE palettes_cosses SET statut = 'ouverte', ouverte_par = ?, date_terminee = NULL WHERE id = ?", [req.utilisateur.id, p.id]);
  return {
    palette: await P.vuePalette(connexion, { ...p, statut: 'ouverte', ouverte_par: req.utilisateur.id }),
    message: `Palette n° ${p.numero} rouverte : scannez ce qui manque, puis « Terminer la palette ».`,
  };
}));

module.exports = router;
