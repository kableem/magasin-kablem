// Cartons de cosses à la réception mobile (import en cartons, réception séparée).
// Sur le téléphone, deux boutons Cartons / Séparées ; le mode reste jusqu'au prochain changement.
// En mode Cartons, les cosses plates scannées entrent dans le carton ouvert (POST /api/mobile/reception) ;
// « Terminer le carton » le ferme et le suivant s'ouvre au scan suivant. L'étiquette du carton s'imprime sur le web.
// Un mauvais choix se corrige : cosse séparée mise dans le carton (/cosses), cosse du carton remise en séparée (/sortir).
//
//   POST   /api/mobile/cartons/:id/cosses       { controle_id } met dans le carton une cosse reçue séparée (mauvais choix)
//   POST   /api/mobile/cartons/:id/sortir       { controle_id | uuid } la cosse était séparée : elle sort du carton, reste reçue
//   POST   /api/mobile/cartons/:id/terminer                 ferme le carton (en mode Cartons, le suivant s'ouvre au scan suivant)
//   POST   /api/mobile/cartons/:id/rouvrir                  rouvre le carton, tant que son étiquette n'est pas imprimée
//   DELETE /api/mobile/cartons/:id/cosses/:controle         retire une cosse scannée par erreur (carton ouvert)
const express = require('express');
const db = require('../db');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const C = require('../cartons');

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

// Carton d'un import dont la réception est en cours
async function cartonEnReception(connexion, id) {
  const [[c]] = await connexion.query(`${C.SELECT_CARTON} WHERE c.id = ? FOR UPDATE`, [id]);
  if (!c) throw refus(404, 'Carton introuvable');
  const [[imp]] = await connexion.query('SELECT id, statut, reception, numero_livraison FROM imports WHERE id = ? FOR UPDATE', [c.import_id]);
  if (imp.statut !== 'en_attente' || imp.reception === 'terminee') {
    throw refus(409, `La réception de l'import ${imp.numero_livraison ?? 'n° ' + imp.id} est terminée : le carton n° ${c.numero} ne se modifie plus.`);
  }
  return c;
}

// POST /:id/cosses { controle_id } : une cosse reçue séparée (oubli d'ouvrir le carton) entre dans le carton ouvert
router.post('/:id/cosses', correctionInterdite, transaction(async (connexion, req) => {
  const c = await cartonEnReception(connexion, req.params.id);
  if (c.statut !== 'ouvert') throw refus(409, `Le carton n° ${c.numero} est terminé : rouvrez-le pour le modifier.`);
  const [[x]] = await connexion.query(
    `SELECT id, reference, ticket, import_id FROM controles_mobile
     WHERE id = ? AND controle = 'reception' AND carton_id IS NULL AND resultat IN ('conforme', 'ecart_quantite', 'inconnu') FOR UPDATE`,
    [Number(req.body?.controle_id)]
  );
  if (!x || x.import_id !== c.import_id) throw refus(404, "Cette cosse n'est pas une cosse séparée de cet import");
  const lot = String(x.ticket ?? '').split('|')[1] ?? null; // « 202614653-2 »
  const vue = await C.vueCarton(connexion, c);
  if (vue.cosses && (String(c.reference).toUpperCase() !== String(x.reference).toUpperCase() || c.lot !== lot)) {
    throw refus(409, `Le carton n° ${c.numero} contient ${c.reference} lot ${c.lot} : un carton n'a qu'une référence et un lot.`);
  }
  await connexion.query('UPDATE controles_mobile SET carton_id = ?, palette_cosses_id = COALESCE(?, palette_cosses_id) WHERE id = ?', [c.id, c.palette_id ?? null, x.id]);
  await connexion.query('UPDATE cartons SET reference = ?, lot = ? WHERE id = ?', [vue.cosses ? c.reference : x.reference, vue.cosses ? c.lot : lot, c.id]);
  const [[maj]] = await connexion.query(`${C.SELECT_CARTON} WHERE c.id = ?`, [c.id]);
  const apres = await C.vueCarton(connexion, maj);
  return { carton: apres, message: `Cosse mise dans le carton n° ${c.numero} (${apres.cosses} cosse${apres.cosses > 1 ? 's' : ''}).` };
}));

// POST /:id/sortir { controle_id | uuid } : choix « Cartons » par erreur, la cosse était séparée.
// Elle reste reçue (pas de nouveau scan), seulement hors du carton.
router.post('/:id/sortir', correctionInterdite, transaction(async (connexion, req) => {
  const c = await cartonEnReception(connexion, req.params.id);
  if (c.statut !== 'ouvert') throw refus(409, `Le carton n° ${c.numero} est terminé : rouvrez-le pour le modifier.`);
  const [[x]] = await connexion.query(
    `SELECT id FROM controles_mobile WHERE carton_id = ? AND controle = 'reception' AND (id = ? OR uuid = ?) FOR UPDATE`,
    [c.id, Number(req.body?.controle_id) || 0, String(req.body?.uuid ?? '')]
  );
  if (!x) throw refus(404, "Cette cosse n'est pas dans le carton");
  // une cosse séparée n'est jamais sur une palette (la palette ne porte que des cartons)
  await connexion.query('UPDATE controles_mobile SET carton_id = NULL, palette_cosses_id = NULL WHERE id = ?', [x.id]);
  const vue = await C.vueCarton(connexion, c);
  return { carton: vue, message: `Cosse remise en séparée. Le carton n° ${c.numero} a ${vue.cosses} cosse${vue.cosses > 1 ? 's' : ''}.` };
}));

// POST /terminer-ouvert { import_id } : termine le carton ouvert de ce magasinier dans l'import, s'il y en a un.
// Envoyé depuis la file d'attente du téléphone après une coupure du Wi-Fi (le téléphone ne connaît pas le n° du carton).
router.post('/terminer-ouvert', transaction(async (connexion, req) => {
  const [[ouvert]] = await connexion.query(
    "SELECT id FROM cartons WHERE import_id = ? AND statut = 'ouvert' AND ouvert_par = ? ORDER BY numero DESC LIMIT 1 FOR UPDATE",
    [Number(req.body?.import_id), req.utilisateur.id]
  );
  if (!ouvert) return { message: 'Aucun carton ouvert : rien à terminer.' };
  return terminerCarton(connexion, await cartonEnReception(connexion, ouvert.id));
}));

// POST /:id/terminer
router.post('/:id/terminer', transaction(async (connexion, req) => {
  const c = await cartonEnReception(connexion, req.params.id);
  if (c.statut !== 'ouvert') throw refus(409, `Le carton n° ${c.numero} est déjà terminé.`);
  return terminerCarton(connexion, c);
}));

// Ferme le carton ouvert c (annulé s'il est vide)
async function terminerCarton(connexion, c) {
  const vue = await C.vueCarton(connexion, c);
  if (!vue.cosses) {
    await connexion.query('DELETE FROM cartons WHERE id = ?', [c.id]);
    return { supprime: true, message: `Le carton n° ${c.numero} était vide : il est annulé.` };
  }
  await connexion.query("UPDATE cartons SET statut = 'termine', date_termine = NOW() WHERE id = ?", [c.id]);
  return {
    carton: { ...vue, statut: 'termine' },
    message: `Carton n° ${c.numero} terminé : ${vue.cosses} cosse${vue.cosses > 1 ? 's' : ''} ${c.reference} lot ${c.lot}. Étiquette : sur le web (page Import).`,
  };
}

// POST /:id/rouvrir : cosse oubliée ; impossible une fois l'étiquette imprimée
router.post('/:id/rouvrir', correctionInterdite, transaction(async (connexion, req) => {
  const c = await cartonEnReception(connexion, req.params.id);
  if (c.statut === 'ouvert') return { carton: await C.vueCarton(connexion, c) };
  if (c.date_etiquette) throw refus(409, `L'étiquette du carton n° ${c.numero} est déjà imprimée : il ne se rouvre plus.`);
  // le carton est sur une palette : elle doit être ouverte, par ce magasinier
  if (c.palette_id) {
    const [[p]] = await connexion.query('SELECT numero, statut, ouverte_par FROM palettes_cosses WHERE id = ? FOR UPDATE', [c.palette_id]);
    if (p && (p.statut !== 'ouverte' || p.ouverte_par !== req.utilisateur.id)) {
      throw refus(409, p.statut === 'ouverte'
        ? `La palette n° ${p.numero} du carton n° ${c.numero} est ouverte par un autre magasinier.`
        : `Le carton n° ${c.numero} est sur la palette n° ${p.numero}, terminée : rouvrez d'abord la palette.`);
    }
  }
  // un seul carton ouvert par magasinier : un autre carton ouvert et vide est annulé, sinon il faut le terminer
  const [autres] = await connexion.query(
    "SELECT id, numero FROM cartons WHERE import_id = ? AND statut = 'ouvert' AND ouvert_par = ? AND id <> ? FOR UPDATE",
    [c.import_id, req.utilisateur.id, c.id]
  );
  for (const a of autres) {
    const v = await C.vueCarton(connexion, a);
    if (v.cosses) throw refus(409, `Terminez d'abord le carton n° ${a.numero}, puis rouvrez le carton n° ${c.numero}.`);
    await connexion.query('DELETE FROM cartons WHERE id = ?', [a.id]);
  }
  await connexion.query("UPDATE cartons SET statut = 'ouvert', ouvert_par = ?, date_termine = NULL WHERE id = ?", [req.utilisateur.id, c.id]);
  return { carton: { ...(await C.vueCarton(connexion, c)), statut: 'ouvert' }, message: `Carton n° ${c.numero} rouvert : scannez la cosse oubliée, puis « Terminer le carton ».` };
}));

// DELETE /:id/cosses/:controle : cosse scannée par erreur, retirée du carton ouvert (elle redevient « non reçue »)
router.delete('/:id/cosses/:controle', correctionInterdite, transaction(async (connexion, req) => {
  const c = await cartonEnReception(connexion, req.params.id);
  if (c.statut !== 'ouvert') throw refus(409, `Le carton n° ${c.numero} est terminé : rouvrez-le pour le modifier.`);
  const [[x]] = await connexion.query(
    "SELECT id, reception_id FROM controles_mobile WHERE id = ? AND carton_id = ? AND controle = 'reception' FOR UPDATE",
    [req.params.controle, c.id]
  );
  if (!x) throw refus(404, "Cette cosse n'est pas dans le carton");
  await connexion.query('DELETE FROM controles_mobile WHERE id = ?', [x.id]);
  // Import par référence : la ligne référence + lot est née des scans, elle perd cette cosse
  const [[ligne]] = await connexion.query(
    "SELECT r.id, r.quantite FROM receptions r JOIN imports i ON i.id = r.import_id WHERE r.id = ? AND i.mode = 'resume' FOR UPDATE",
    [x.reception_id]
  );
  if (ligne) {
    if (ligne.quantite > 1) await connexion.query('UPDATE receptions SET quantite = quantite - 1 WHERE id = ?', [ligne.id]);
    else await connexion.query('DELETE FROM receptions WHERE id = ?', [ligne.id]);
  }
  return { carton: await C.vueCarton(connexion, c) };
}));

module.exports = router;
