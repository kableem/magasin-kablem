// Descente des cosses restantes d'un carton ouvert à l'export (migration 040, voir src/descentes.js).
//
//   GET  /api/mobile/descente/en-cours     la descente à faire par ce magasinier (ou null)
//   POST /api/mobile/descente/:id/scan     { uuid, emplacement, qr } : l'emplacement imposé puis le ticket d'une cosse
// Chaque cosse posée quitte la palette du haut et entre au stock en cosse séparée à cet emplacement.
const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { poserQuantite } = require('./stock');
const { capaciteTampon } = require('../parametres');
const { estGestionnaire } = require('../middleware/auth');
const { lireTicket, lireEmplacement, messageIllisible } = require('../ticket');
const { enregistrerMouvements } = require('../historique');
const D = require('../descentes');
const { enregistrer, operation } = require('./mobile').outils;

const router = express.Router();
const refus = (status, message) => Object.assign(new Error(message), { status });

router.get('/en-cours', async (req, res, next) => {
  try {
    res.json({ descente: await D.descenteEnCours(db, req.utilisateur.id) });
  } catch (err) { next(err); }
});

router.post('/:id/scan', operation('rangement', async (connexion, req) => {
  const [[d]] = await connexion.query('SELECT * FROM descentes_carton WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
  if (!d) throw refus(404, 'Descente introuvable');
  if (d.utilisateur_id !== req.utilisateur.id && !estGestionnaire(req.utilisateur)) throw refus(409, "Ce carton est à descendre par un autre magasinier.");
  if (d.statut !== 'en_cours') throw refus(409, 'Ce carton est déjà descendu.');
  const avant = await D.vueDescente(connexion, d.id);
  const repondre = async (resultat, donnees) => enregistrer(connexion, req, 'rangement', resultat, {
    reference: avant.reference, lot: avant.lot, carton_id: d.carton_id, ...donnees,
    extra: { descente: await D.vueDescente(connexion, d.id), ...(donnees.extra ?? {}) },
  });

  const code = lireEmplacement(req.body.emplacement);
  if (!code || !R.emplacementValide(code, await capaciteTampon(connexion))) {
    return repondre('emplacement_inconnu', {
      emplacement_scanne: String(req.body.emplacement ?? '').trim().slice(0, 20) || null,
      emplacements_prevus: avant.emplacements.map((c) => ({ code: c, quantite: 1 })),
      message: `Ce QR ne correspond à aucun emplacement : scannez l'étiquette de ${avant.emplacements.join(', ')}.`,
    });
  }
  const ticket = lireTicket(req.body.qr);
  if (!ticket?.cle) return repondre('ticket_illisible', { emplacement_scanne: code, message: ticket ? 'Scannez le QR du bas du ticket vert (il porte le n° du colis).' : messageIllisible(req.body.qr) });
  const [[x]] = await connexion.query('SELECT * FROM descentes_carton_cosses WHERE descente_id = ? AND ticket = ? FOR UPDATE', [d.id, ticket.cle]);
  const base = { reference: ticket.reference, lot: ticket.lot, ticket: ticket.cle, emplacement_scanne: code };
  if (!x) {
    return repondre('mauvais_produit', { ...base, message: `Cette cosse n'est pas une cosse restante du carton n° ${avant.carton} : scannez les tickets des cosses du carton.` });
  }
  if (x.pose_le) return repondre('deja_traite', { ...base, reception_id: x.reception_id, message: `Le colis n° ${x.colis} est déjà posé en ${x.emplacement} : scannez la cosse suivante.` });
  if (x.emplacement && code !== x.emplacement) {
    return repondre('faux_emplacement', {
      ...base, reception_id: x.reception_id, emplacements_prevus: [{ code: x.emplacement, quantite: 1 }],
      message: `Le colis n° ${x.colis} va en ${x.emplacement}, pas en ${code} : posez-le en ${x.emplacement}. Rien n'est enregistré.`,
    });
  }

  // La cosse quitte la palette du haut et devient une cosse séparée à cet emplacement
  const [[ligne]] = await connexion.query(
    'SELECT id, quantite FROM placements WHERE reception_id = ? AND emplacement = ? AND quantite > 0 FOR UPDATE',
    [x.reception_id, d.depuis]
  );
  if (ligne) {
    if (Number(ligne.quantite) <= 1) await connexion.query('DELETE FROM placements WHERE id = ?', [ligne.id]);
    else await connexion.query('UPDATE placements SET quantite = quantite - 1 WHERE id = ?', [ligne.id]);
  }
  await poserQuantite(connexion, x.reception_id, code, 1);
  await connexion.query('UPDATE descentes_carton_cosses SET pose_le = NOW(), emplacement = ? WHERE id = ?', [code, x.id]);
  const [[r]] = await connexion.query('SELECT id, reference, lot, type, taille_bobine FROM receptions WHERE id = ?', [x.reception_id]);
  const [[{ reste }]] = await connexion.query('SELECT COUNT(*) AS reste FROM placements WHERE emplacement = ? AND quantite > 0', [d.depuis]);
  await enregistrerMouvements(connexion, [{
    origine: 'deplacement', ligne: { ...r, reception_id: r.id }, quantite: 1, colis: x.colis, depuis: d.depuis, vers: code,
    commentaire: `Carton n° ${avant.carton} ouvert à l'export : cosse descendue en cosse séparée`, depuisLiberee: !Number(reste), utilisateurId: req.utilisateur.id,
  }]);
  const apres = await D.vueDescente(connexion, d.id);
  if (!apres.restantes) {
    await connexion.query("UPDATE descentes_carton SET statut = 'terminee', date_fin = NOW() WHERE id = ?", [d.id]);
  }
  return repondre('bon_emplacement', {
    ...base, reception_id: x.reception_id, emplacements_prevus: [{ code, quantite: 1 }],
    message: apres.restantes
      ? `Colis n° ${x.colis} posé en ${code}. Encore ${apres.restantes} cosse${apres.restantes > 1 ? 's' : ''} à descendre${apres.emplacements.length ? ' en ' + apres.emplacements.join(', ') : ''}.`
      : `Carton n° ${avant.carton} descendu : ${apres.cosses.length} cosse${apres.cosses.length > 1 ? 's' : ''} en cosses séparées. Vous pouvez faire la sortie suivante.`,
  });
}));

module.exports = router;
