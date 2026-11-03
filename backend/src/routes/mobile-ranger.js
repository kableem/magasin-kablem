// « Ranger le magasin » sur le mobile, sans suggestion du système (décision du directeur, 2026-10-29).
// Le magasinier range librement : il scanne le produit (ticket), l'emplacement où il le prend, puis
// l'emplacement d'arrivée de son choix. L'application CONTRÔLE chaque déplacement (le produit est bien
// à cet emplacement ; l'arrivée respecte les règles du magasin : niveau, taille, capacité, places
// réservées) et l'ENREGISTRE avec le matricule : stock, historique des emplacements (origine
// « Ranger le magasin ») et journal des contrôles. Les déplacements refusés sont notés aussi.
//
//   GET  /api/mobile/ranger/produit?qr=          où se trouve ce produit (lecture seule)
//   GET  /api/mobile/ranger/emplacement/:code    contenu d'un emplacement (lecture seule)
//   POST /api/mobile/ranger/deplacer             { uuid, qr, depuis, vers }  un produit (un colis)
//   POST /api/mobile/ranger/palette              { uuid, depuis, vers }      toute la palette, sur un emplacement vide
//   GET  /api/mobile/ranger/mes-deplacements     mes déplacements du jour
const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { occupation, poserQuantite } = require('./stock');
const { parametresRangement, capaciteTampon } = require('../parametres');
const { enregistrerMouvements } = require('../historique');
const { lireTicket, lireEmplacement, lotsDuTicket, messageIllisible } = require('../ticket');
const { enregistrer, operation } = require('./mobile').outils;

const router = express.Router();
const refus = (status, message) => Object.assign(new Error(message), { status });
const nombre = (v) => (v === null || v === undefined ? null : Number(v));

// Produits en stock à un emplacement (verrouillés pendant un déplacement)
async function contenuDe(connexion, code, verrou = false) {
  const [lignes] = await connexion.query(
    `SELECT r.id, r.type, r.taille_bobine, r.type_cosse, r.reference, r.lot, r.longueur, r.largeur, r.hauteur, r.poids,
            p.id AS placement_id, p.quantite
     FROM placements p JOIN receptions r ON r.id = p.reception_id
     WHERE p.emplacement = ? AND p.quantite > 0
     ORDER BY r.reference, r.lot, r.id
     ${verrou ? 'FOR UPDATE' : ''}`,
    [code]
  );
  return lignes.map((l) => ({
    ...l, quantite: Number(l.quantite),
    longueur: nombre(l.longueur), largeur: nombre(l.largeur), hauteur: nombre(l.hauteur), poids: nombre(l.poids),
  }));
}

// Remplissage d'un emplacement : « 4/6 petites bobines », « 7/10 cosses », « 2 cartons »
function remplissage(lignes) {
  const n = lignes.reduce((t, l) => t + Number(l.quantite), 0);
  if (!n) return { n: 0, capacite: null, libelle: 'vide' };
  const premier = lignes[0];
  if (premier.type === 'connecteur') return { n, capacite: null, libelle: `${n} carton${n > 1 ? 's' : ''}` };
  if (premier.type === 'cosse') {
    const axiales = lignes.filter(R.estAxiale).reduce((t, l) => t + Number(l.quantite), 0);
    const plates = n - axiales;
    const morceaux = [plates && `${plates}/${R.COSSES_PAR_PALETTE} cosses plates`, axiales && `${axiales}/${R.COSSES_AXIALES_PAR_PALETTE} axiales`].filter(Boolean);
    return { n, capacite: null, plates, axiales, libelle: morceaux.join(' · ') };
  }
  const capacite = R.capacite(premier);
  const quoi = premier.type === 'cosse' ? 'cosses' : R.LIBELLE_TAILLE[premier.taille_bobine];
  return { n, capacite, libelle: `${n}/${capacite} ${quoi}` };
}

// Code d'emplacement lu dans un QR ; null s'il n'existe pas dans le magasin
async function codeDuMagasin(connexion, brut) {
  const code = lireEmplacement(brut);
  return code && R.emplacementValide(code, await capaciteTampon(connexion)) ? code : null;
}

// Emplacement connu d'un colis (ticket fournisseur) : rangé à la réception, ou compté à l'inventaire,
// et toujours présent à cet emplacement. null si l'application ne le sait pas.
async function placeDuColis(connexion, cle) {
  if (!cle) return null;
  const [[connu]] = await connexion.query(
    `SELECT x.emplacement, x.reception_id FROM (
       SELECT a.emplacement, a.reception_id, 1 AS ordre FROM affectations_colis a WHERE a.ticket = ? AND a.range_le IS NOT NULL
       UNION ALL
       SELECT s.emplacement, s.reception_id, 2 AS ordre FROM inventaire_scans s WHERE s.ticket = ?
     ) x
     WHERE EXISTS (SELECT 1 FROM placements p WHERE p.reception_id = x.reception_id AND p.emplacement = x.emplacement AND p.quantite > 0)
     ORDER BY x.ordre LIMIT 1`,
    [cle, cle]
  );
  return connu ?? null;
}

// Colis déjà sorti vers la production (scan d'export) : il n'est plus dans le magasin
async function colisSorti(connexion, cle) {
  if (!cle) return false;
  const [[sortie]] = await connexion.query(
    "SELECT 1 AS oui FROM controles_mobile WHERE ticket = ? AND controle = 'export' AND resultat IN ('prelevement_ok', 'sortie_terminee') LIMIT 1",
    [cle]
  );
  return !!sortie;
}

// La destination peut-elle recevoir ces produits (règles du magasin, stock et places réservées) ?
// Les produits déplacés quittent d'abord leur place de départ. Renvoie le refus en clair, ou null.
async function refusDestination(connexion, produits, vers, retirer) {
  const { capaciteTampon: capacite, limites } = await parametresRangement(connexion);
  const etat = (await occupation(connexion, true))
    .filter((l) => l.emplacement)
    .map((l) => {
      const retire = retirer.get(l.id) ?? 0;
      return retire ? { ...l, quantite: Number(l.quantite) - retire } : l;
    })
    .filter((l) => Number(l.quantite) > 0);
  return R.verifierPlan(produits.map((p) => ({ id: p.id, emplacement: vers, quantite: p.quantite })), produits, etat, capacite, limites);
}

async function deplacer(connexion, ligne, depuis, vers, quantite) {
  await connexion.query('UPDATE placements SET quantite = quantite - ? WHERE reception_id = ? AND emplacement = ?', [quantite, ligne.id, depuis]);
  await connexion.query('DELETE FROM placements WHERE reception_id = ? AND emplacement = ? AND quantite <= 0', [ligne.id, depuis]);
  await poserQuantite(connexion, ligne.id, vers, quantite);
}

// GET /produit?qr= : où se trouve ce produit, pour guider le scan de son emplacement
router.get('/produit', async (req, res, next) => {
  try {
    const ticket = lireTicket(req.query.qr);
    if (!ticket) return res.status(400).json({ message: messageIllisible(req.query.qr) });
    const [places] = await db.query(
      `SELECT p.emplacement AS code, SUM(p.quantite) AS quantite, MIN(r.type) AS type, MIN(r.taille_bobine) AS taille_bobine, MIN(r.type_cosse) AS type_cosse
       FROM placements p JOIN receptions r ON r.id = p.reception_id
       WHERE UPPER(TRIM(r.reference)) = ? AND TRIM(r.lot) IN (?) AND p.quantite > 0 AND p.emplacement IS NOT NULL
       GROUP BY p.emplacement ORDER BY p.emplacement`,
      [ticket.reference, lotsDuTicket(ticket)]
    );
    if (!places.length) {
      return res.status(404).json({ message: `${ticket.reference} lot ${ticket.lot} n'est rangé à aucun emplacement : rien à déplacer.` });
    }
    if (await colisSorti(db, ticket.cle)) {
      return res.status(409).json({ message: `Le colis n° ${ticket.colis} de ${ticket.reference} est déjà sorti vers la production.` });
    }
    const connu = await placeDuColis(db, ticket.cle);
    res.json({
      reference: ticket.reference, lot: ticket.lot, colis: ticket.colis, type: places[0].type, taille_bobine: places[0].taille_bobine, type_cosse: places[0].type_cosse,
      emplacements: places.map((p) => ({ code: p.code, quantite: Number(p.quantite) })),
      ici: connu?.emplacement ?? null, // emplacement exact du colis, s'il est connu
    });
  } catch (err) { next(err); }
});

// GET /emplacement/:code : contenu d'un emplacement (départ choisi en premier, arrivée)
router.get('/emplacement/:code', async (req, res, next) => {
  try {
    const code = await codeDuMagasin(db, req.params.code);
    if (!code) return res.status(404).json({ message: `« ${req.params.code} » n'est pas un emplacement du magasin.` });
    const lignes = await contenuDe(db, code);
    res.json({
      code, niveau: R.lireCode(code)?.niveau ?? null, tampon: R.estTampon(code),
      produits: lignes.map((l) => ({ reference: l.reference, lot: l.lot, type: l.type, taille_bobine: l.taille_bobine, type_cosse: l.type_cosse, quantite: l.quantite })),
      remplissage: remplissage(lignes),
    });
  } catch (err) { next(err); }
});

// Contrôle refusé : noté dans le journal (rien ne bouge), le téléphone affiche le message en rouge
const refuser = (connexion, req, donnees) => enregistrer(connexion, req, 'ranger', 'deplacement_refuse', donnees);

// POST /deplacer { uuid, qr, depuis, vers } : un produit (un colis) passe d'un emplacement à un autre
router.post('/deplacer', operation('ranger', async (connexion, req) => {
  const ticket = lireTicket(req.body.qr);
  if (!ticket) return enregistrer(connexion, req, 'ranger', 'ticket_illisible', { message: messageIllisible(req.body.qr) });
  const base = { reference: ticket.reference, lot: ticket.lot, ticket: ticket.cle, quantite_ticket: 1 };
  const depuis = await codeDuMagasin(connexion, req.body.depuis);
  const vers = await codeDuMagasin(connexion, req.body.vers);
  if (!depuis || !vers) {
    return enregistrer(connexion, req, 'ranger', 'emplacement_inconnu', {
      ...base, emplacement_scanne: String((depuis ? req.body.vers : req.body.depuis) ?? '').trim().slice(0, 20) || null,
      message: "Ce QR ne correspond à aucun emplacement du magasin. Rescannez l'étiquette.",
    });
  }
  const trajet = { ...base, emplacements_prevus: [{ code: depuis }], emplacement_scanne: vers };
  if (depuis === vers) return refuser(connexion, req, { ...trajet, message: `Départ et arrivée identiques (${vers}) : scannez l'emplacement où vous posez le produit.` });
  if (await colisSorti(connexion, ticket.cle)) {
    return refuser(connexion, req, { ...trajet, message: `Le colis n° ${ticket.colis} est déjà sorti vers la production : il n'est plus dans le magasin.` });
  }
  // Colis dont l'application connaît la place : il ne part que de cette place
  const connu = await placeDuColis(connexion, ticket.cle);
  if (connu && connu.emplacement !== depuis) {
    return refuser(connexion, req, {
      ...trajet, message: `Le colis n° ${ticket.colis} est en ${connu.emplacement}, pas en ${depuis}. Rien n'est enregistré.`,
    });
  }
  const contenu = await contenuDe(connexion, depuis, true);
  const lots = lotsDuTicket(ticket);
  const ligne = contenu.find((l) => (connu ? l.id === connu.reception_id : l.reference.trim().toUpperCase() === ticket.reference && lots.includes(l.lot.trim())));
  if (!ligne) {
    return refuser(connexion, req, {
      ...trajet, message: `${ticket.reference} lot ${ticket.lot} n'est pas en ${depuis} : prenez un produit posé à cet emplacement. Rien n'est enregistré.`,
    });
  }
  const erreur = await refusDestination(connexion, [{ ...ligne, quantite: 1 }], vers, new Map([[ligne.placement_id, 1]]));
  if (erreur) return refuser(connexion, req, { ...trajet, ligne, message: `${erreur.replace(/\.$/, '')}. Rien n'est enregistré.` });

  await deplacer(connexion, ligne, depuis, vers, 1);
  if (ticket.cle) {
    await connexion.query('UPDATE affectations_colis SET emplacement = ? WHERE ticket = ? AND range_le IS NOT NULL', [vers, ticket.cle]);
    await connexion.query('UPDATE inventaire_scans SET emplacement = ? WHERE ticket = ?', [vers, ticket.cle]);
  }
  const resteDepuis = await contenuDe(connexion, depuis);
  const libre = !resteDepuis.length;
  await enregistrerMouvements(connexion, [{
    origine: 'regroupement', ligne: { ...ligne, reception_id: ligne.id }, quantite: 1, depuis, vers, motif: 'regroupement',
    colis: ticket.colis, depuisLiberee: libre, utilisateurId: req.utilisateur.id,
  }]);
  const arrivee = remplissage(await contenuDe(connexion, vers));
  return enregistrer(connexion, req, 'ranger', 'deplace', {
    ...trajet, ligne,
    message: `${ticket.reference}${ticket.colis ? ` (colis n° ${ticket.colis})` : ''} : ${depuis} → ${vers}. ${libre ? `${depuis} est libre.` : `Reste en ${depuis} : ${remplissage(resteDepuis).libelle}.`}`,
    extra: { deplacement: { depuis, vers, depuis_libre: libre, depuis_remplissage: remplissage(resteDepuis), vers_remplissage: arrivee, palette: false } },
  });
}));

// POST /palette { uuid, depuis, vers } : toute la palette d'un emplacement, posée sur un emplacement vide
router.post('/palette', operation('ranger', async (connexion, req) => {
  const depuis = await codeDuMagasin(connexion, req.body.depuis);
  const vers = await codeDuMagasin(connexion, req.body.vers);
  if (!depuis || !vers) {
    return enregistrer(connexion, req, 'ranger', 'emplacement_inconnu', {
      emplacement_scanne: String((depuis ? req.body.vers : req.body.depuis) ?? '').trim().slice(0, 20) || null,
      message: "Ce QR ne correspond à aucun emplacement du magasin. Rescannez l'étiquette.",
    });
  }
  const trajet = { emplacements_prevus: [{ code: depuis }], emplacement_scanne: vers };
  if (depuis === vers) return refuser(connexion, req, { ...trajet, message: `Départ et arrivée identiques (${vers}) : scannez l'emplacement où vous posez la palette.` });
  const contenu = await contenuDe(connexion, depuis, true);
  if (!contenu.length) return refuser(connexion, req, { ...trajet, message: `${depuis} est vide : rien à déplacer.` });
  const premier = { ...trajet, reference: contenu[0].reference, lot: contenu[0].lot, ligne: contenu[0] };
  // 1 emplacement = 1 palette : la palette entière ne va que sur un emplacement vide (ni stock, ni place réservée)
  const occupeVers = (await occupation(connexion, true)).filter((l) => l.emplacement === vers && Number(l.quantite) > 0);
  if (occupeVers.length) {
    const quoi = occupeVers.some((l) => l.reserve) ? 'réservé pour un import' : remplissage(occupeVers).libelle;
    return refuser(connexion, req, {
      ...premier, message: `${vers} n'est pas vide (${quoi}) : une palette entière ne va que sur un emplacement vide. Rien n'est enregistré.`,
    });
  }
  const erreur = await refusDestination(connexion, contenu, vers, new Map(contenu.map((l) => [l.placement_id, l.quantite])));
  if (erreur) return refuser(connexion, req, { ...premier, message: `${erreur.replace(/\.$/, '')}. Rien n'est enregistré.` });

  for (const l of contenu) await deplacer(connexion, l, depuis, vers, l.quantite);
  await connexion.query(
    'UPDATE affectations_colis SET emplacement = ? WHERE emplacement = ? AND range_le IS NOT NULL AND reception_id IN (?)',
    [vers, depuis, contenu.map((l) => l.id)]
  );
  await connexion.query('UPDATE inventaire_scans SET emplacement = ? WHERE emplacement = ?', [vers, depuis]);
  await enregistrerMouvements(connexion, contenu.map((l, k) => ({
    origine: 'regroupement', ligne: { ...l, reception_id: l.id }, quantite: l.quantite, depuis, vers, motif: 'regroupement',
    commentaire: 'Palette entière', depuisLiberee: k === contenu.length - 1, utilisateurId: req.utilisateur.id,
  })));
  const plein = remplissage(contenu);
  return enregistrer(connexion, req, 'ranger', 'deplace', {
    ...premier, quantite_ticket: plein.n,
    message: `Palette entière ${depuis} → ${vers} (${plein.libelle}). ${depuis} est libre.`,
    extra: { deplacement: { depuis, vers, depuis_libre: true, depuis_remplissage: remplissage([]), vers_remplissage: plein, palette: true } },
  });
}));

// GET /mes-deplacements : ce que j'ai rangé aujourd'hui
router.get('/mes-deplacements', async (req, res, next) => {
  try {
    const [mouvements] = await db.query(
      `SELECT m.id, DATE_FORMAT(m.date_mouvement, '%Y-%m-%dT%H:%i:%s') AS date, m.reference, m.lot, m.type, m.taille_bobine,
              m.quantite, m.colis, m.depuis, m.vers, m.depuis_liberee, m.commentaire
       FROM mouvements_emplacement m
       WHERE m.origine = 'regroupement' AND m.utilisateur_id = ? AND m.date_mouvement >= CURDATE()
       ORDER BY m.date_mouvement DESC, m.id DESC LIMIT 60`,
      [req.utilisateur.id]
    );
    const [[compte]] = await db.query(
      `SELECT SUM(resultat = 'deplace') AS deplacements, SUM(resultat <> 'deplace') AS refus FROM controles_mobile
       WHERE controle = 'ranger' AND utilisateur_id = ? AND date_controle >= CURDATE()`,
      [req.utilisateur.id]
    );
    res.json({
      deplacements: Number(compte.deplacements ?? 0),
      refus: Number(compte.refus ?? 0),
      produits: mouvements.reduce((t, m) => t + Number(m.quantite), 0),
      liberes: mouvements.filter((m) => m.depuis_liberee).length,
      mouvements: mouvements.map((m) => ({ ...m, depuis_liberee: !!m.depuis_liberee })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
