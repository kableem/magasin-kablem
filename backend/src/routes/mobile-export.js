// Sortie vers la production préparée sur le mobile : le magasinier doit prendre le bon produit
// au bon emplacement, dans l'ordre imposé par le FIFO (mêmes règles que la page Export du web).
//
//   1. POST /preparer : « 3 × F0411 vers P1 ». L'API calcule les prélèvements FIFO (lot, emplacement,
//      quantité) et les réserve : une autre sortie en préparation ne peut pas les prendre.
//   2. POST /:id/scan : QR de l'emplacement puis ticket du produit. Bon emplacement + bon lot =
//      prélèvement validé ; sinon alerte (faux emplacement, mauvais produit, lot non FIFO), journalisée.
//   3. Dernier prélèvement validé : la sortie est enregistrée exactement comme sur le web
//      (exports + export_details), les produits quittent le stock et les places sont libérées.
//      Si le stock a changé entre-temps (sortie faite depuis le web), rien ne sort.
//
// Administrateur seulement : le FIFO est proposé, mais il peut prendre un autre lot ou un autre emplacement
// de la même référence. Le produit scanné remplace autant de produits du parcours FIFO (les plus récents
// d'abord) ; la prise et la sortie sont marquées « hors FIFO ». Les autres rôles gardent le FIFO imposé.
const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { lignesEnStock } = require('./stock');
const { capaciteTampon } = require('../parametres');
const { estGestionnaire } = require('../middleware/auth');
const { calculerSortie, enregistrerSortie, lireDemande, DESTINATIONS } = require('./exports');
const { lireTicket, lireEmplacement, memeLot, messageIllisible } = require('../ticket');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const { outils } = require('./mobile');
const { expirerPreparations, retirerReserves } = require('../reservations');

const { enregistrer, operation, UUID } = outils;
const router = express.Router();

const erreur = (status, message) => Object.assign(new Error(message), { status });
const code = (e) => e ?? 'non rangé';
const estAdmin = (utilisateur) => utilisateur?.role === 'admin';

// Stock en place moins ce que les autres sorties en préparation ont déjà réservé
const stockDisponible = async (connexion) => retirerReserves(connexion, await lignesEnStock(connexion, true));

// Préparation et ses prélèvements, pour le téléphone
async function chargerPreparation(connexion, id, verrou = false) {
  const [[p]] = await connexion.query(
    `SELECT id, uuid, reference, quantite, destination, statut, motif_fin, export_id, utilisateur_id,
            DATE_FORMAT(date_creation, '%Y-%m-%dT%H:%i:%s') AS date_creation
     FROM preparations_export WHERE id = ? ${verrou ? 'FOR UPDATE' : ''}`,
    [id]
  );
  if (!p) return null;
  const [lignes] = await connexion.query(
    `SELECT id, ordre, placement_id, reception_id, lot, DATE_FORMAT(date_reception, '%Y-%m-%dT%H:%i:%s') AS date_reception,
            emplacement, quantite, preleves, valide, hors_fifo
     FROM preparation_lignes WHERE preparation_id = ? ORDER BY ordre ${verrou ? 'FOR UPDATE' : ''}`,
    [id]
  );
  const [[info]] = await connexion.query(
    `SELECT r.type, r.taille_bobine FROM preparation_lignes l JOIN receptions r ON r.id = l.reception_id
     WHERE l.preparation_id = ? LIMIT 1`,
    [id]
  );
  const prelevements = lignes.map((l) => ({ ...l, valide: !!l.valide, hors_fifo: !!l.hors_fifo }));
  return {
    ...p,
    type: info?.type ?? null,
    taille_bobine: info?.taille_bobine ?? null,
    lignes: prelevements,
    restants: prelevements.filter((l) => !l.valide).length,
  };
}

// La vue du téléphone ne contient pas les identifiants internes
const pourTelephone = (p) => p && {
  ...p,
  uuid: undefined,
  utilisateur_id: undefined,
  lignes: p.lignes.map(({ placement_id, reception_id, ...l }) => l),
};

function verifierProprietaire(p, utilisateur) {
  if (!p) throw erreur(404, 'Sortie introuvable');
  if (p.utilisateur_id !== utilisateur.id && !estGestionnaire(utilisateur)) {
    throw erreur(403, "Cette sortie est préparée par un autre magasinier");
  }
}

// POST /api/mobile/export/preparer  { uuid, reference, quantite, destination }
router.post('/preparer', async (req, res, next) => {
  const uuid = String(req.body?.uuid ?? '');
  if (!UUID.test(uuid)) return res.status(400).json({ message: "Identifiant d'opération (uuid) manquant ou invalide" });
  const demande = lireDemande(req.body || {});
  if (demande.erreur) return res.status(400).json({ message: demande.erreur });
  const destination = String(req.body.destination || '').trim().toUpperCase();
  if (!DESTINATIONS.includes(destination)) {
    return res.status(400).json({ message: `La destination est obligatoire : ${DESTINATIONS.join(', ')}` });
  }
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion);
    await connexion.beginTransaction();
    // Même uuid renvoyé (coupure Wi-Fi) : la même préparation
    const [[deja]] = await connexion.query('SELECT id FROM preparations_export WHERE uuid = ?', [uuid]);
    if (deja) {
      await connexion.rollback();
      return res.json({ ...pourTelephone(await chargerPreparation(db, deja.id)), rejoue: true });
    }
    await expirerPreparations(connexion);
    const [[enCours]] = await connexion.query(
      "SELECT id, reference, quantite FROM preparations_export WHERE statut = 'en_cours' AND utilisateur_id = ? LIMIT 1",
      [req.utilisateur.id]
    );
    if (enCours) {
      await connexion.rollback();
      return res.status(409).json({
        message: `Terminez ou annulez d'abord la sortie en cours (${enCours.quantite} × ${enCours.reference})`,
        preparation_id: enCours.id,
      });
    }

    const disponible = await stockDisponible(connexion);
    const sortie = calculerSortie(disponible, demande.reference, demande.quantite);
    if (sortie.erreur) {
      const reel = (await lignesEnStock(connexion)).filter((l) => l.reference.toUpperCase() === demande.reference)
        .reduce((t, l) => t + l.quantite, 0);
      const reserve = reel - (sortie.disponible ?? 0);
      await connexion.rollback();
      return res.status(409).json({
        message: sortie.erreur + (reserve > 0 && sortie.disponible !== undefined ? ` (${reserve} réservé(s) par une autre sortie en préparation)` : ''),
        disponible: sortie.disponible ?? 0,
      });
    }

    const [p] = await connexion.query(
      'INSERT INTO preparations_export (uuid, reference, quantite, destination, utilisateur_id) VALUES (?, ?, ?, ?, ?)',
      [uuid, demande.reference, demande.quantite, destination, req.utilisateur.id]
    );
    let ordre = 0;
    for (const { ligne, quantite } of sortie.prelevements) {
      await connexion.query(
        `INSERT INTO preparation_lignes (preparation_id, ordre, placement_id, reception_id, lot, date_reception, emplacement, quantite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.insertId, ++ordre, ligne.id, ligne.reception_id, ligne.lot, ligne.date_reception.replace('T', ' '), ligne.emplacement, quantite]
      );
    }
    await connexion.commit();
    res.status(201).json(pourTelephone(await chargerPreparation(db, p.insertId)));
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

// GET /api/mobile/export/en-cours : la sortie en cours du magasinier (pour la reprendre)
router.get('/en-cours', async (req, res, next) => {
  try {
    await expirerPreparations(db);
    const [[p]] = await db.query(
      "SELECT id FROM preparations_export WHERE statut = 'en_cours' AND utilisateur_id = ? ORDER BY id DESC LIMIT 1",
      [req.utilisateur.id]
    );
    res.json(p ? pourTelephone(await chargerPreparation(db, p.id)) : null);
  } catch (err) { next(err); }
});

// GET /api/mobile/export/:id
router.get('/:id', async (req, res, next) => {
  try {
    const p = await chargerPreparation(db, Number(req.params.id));
    verifierProprietaire(p, req.utilisateur);
    res.json(pourTelephone(p));
  } catch (err) { next(err); }
});

// POST /api/mobile/export/:id/annuler : rien ne sort, les produits réservés sont libérés
router.post('/:id/annuler', async (req, res, next) => {
  try {
    const p = await chargerPreparation(db, Number(req.params.id));
    verifierProprietaire(p, req.utilisateur);
    if (p.statut !== 'en_cours') return res.status(409).json({ message: 'Cette sortie est déjà close' });
    await db.query(
      "UPDATE preparations_export SET statut = 'annulee', date_fin = NOW(), motif_fin = ? WHERE id = ? AND statut = 'en_cours'",
      [`Annulée par ${req.utilisateur.matricule}`, p.id]
    );
    res.json(pourTelephone(await chargerPreparation(db, p.id)));
  } catch (err) { next(err); }
});

// Administrateur : le produit scanné (même référence, mais autre lot ou autre emplacement que le FIFO)
// est-il libre ici ? Si oui, il est pris et remplace autant de produits du parcours FIFO, les plus récents
// d'abord. Renvoie { quantite, lot, remplaces } ou null (rien de libre : les contrôles habituels s'appliquent).
async function prendreHorsFifo(connexion, p, ticket, scanne) {
  const aPrendre = p.lignes.filter((l) => !l.valide).reduce((t, l) => t + l.quantite - l.preleves, 0);
  if (aPrendre <= 0) return null;

  // Déjà dans cette sortie, ou réservé par une autre sortie en préparation
  const pris = new Map();
  for (const l of p.lignes) pris.set(l.placement_id, (pris.get(l.placement_id) ?? 0) + l.quantite);
  const [autres] = await connexion.query(
    `SELECT l.placement_id, SUM(l.quantite) AS quantite
     FROM preparation_lignes l JOIN preparations_export x ON x.id = l.preparation_id AND x.statut = 'en_cours' AND x.id <> ?
     GROUP BY l.placement_id`,
    [p.id]
  );
  for (const r of autres) pris.set(r.placement_id, (pris.get(r.placement_id) ?? 0) + Number(r.quantite));
  const choisi = (await lignesEnStock(connexion, true))
    .filter((l) => l.reference.toUpperCase() === p.reference && l.emplacement === scanne && memeLot(l.lot, ticket))
    .map((l) => ({ ...l, libre: l.quantite - (pris.get(l.id) ?? 0) }))
    .filter((l) => l.libre > 0)
    .sort((a, b) => a.date_reception.localeCompare(b.date_reception))[0];
  if (!choisi) return null;
  const quantite = Math.min(ticket.cle ? 1 : ticket.quantite, choisi.libre, aPrendre);

  // Le parcours FIFO est réduit d'autant, en commençant par les produits les plus récents
  const remplaces = [];
  let reste = quantite;
  for (const l of p.lignes.filter((x) => !x.valide && x.placement_id !== choisi.id).sort((a, b) => b.ordre - a.ordre)) {
    const retire = Math.min(reste, l.quantite - l.preleves);
    if (retire <= 0) continue;
    reste -= retire;
    remplaces.push(`${retire} × lot ${l.lot} en ${code(l.emplacement)}`);
    const nouvelle = l.quantite - retire;
    if (nouvelle === 0) {
      await connexion.query('DELETE FROM preparation_lignes WHERE id = ?', [l.id]);
    } else {
      // Les colis déjà pris de cette ligne suffisent : elle est terminée
      await connexion.query(
        'UPDATE preparation_lignes SET quantite = ?, valide = ?, date_validation = IF(?, NOW(), date_validation) WHERE id = ?',
        [nouvelle, nouvelle === l.preleves ? 1 : 0, nouvelle === l.preleves, l.id]
      );
    }
    if (reste <= 0) break;
  }

  // La prise de l'administrateur : ajoutée au même placement s'il est déjà dans la sortie, sinon une nouvelle ligne
  const meme = p.lignes.find((l) => l.placement_id === choisi.id);
  if (meme) {
    await connexion.query(
      'UPDATE preparation_lignes SET quantite = quantite + ?, preleves = preleves + ?, hors_fifo = 1 WHERE id = ?',
      [quantite, quantite, meme.id]
    );
  } else {
    await connexion.query(
      `INSERT INTO preparation_lignes
         (preparation_id, ordre, placement_id, reception_id, lot, date_reception, emplacement, quantite, preleves, valide, hors_fifo, date_validation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NOW())`,
      [p.id, Math.max(0, ...p.lignes.map((l) => l.ordre)) + 1, choisi.id, choisi.reception_id, choisi.lot,
        choisi.date_reception.replace('T', ' '), choisi.emplacement, quantite, quantite]
    );
  }
  return { quantite, lot: choisi.lot, remplaces };
}

// POST /api/mobile/export/:id/scan  { uuid, emplacement, qr, sans_emplacement?, saisie_manuelle? }
// emplacement = QR de l'emplacement (scanné en premier) ; sans_emplacement = produit pas encore rangé
router.post('/:id/scan', operation('export', async (connexion, req) => {
  let p = await chargerPreparation(connexion, Number(req.params.id), true);
  verifierProprietaire(p, req.utilisateur);
  const ticket = lireTicket(req.body.qr);
  const base = {
    preparation_id: p.id,
    reference: ticket?.reference ?? null, lot: ticket?.lot ?? null, quantite_ticket: ticket?.quantite ?? null,
    ticket: ticket?.cle ?? null,
  };
  const restants = () => p.lignes.filter((l) => !l.valide);
  const prevus = () => restants().map((l) => ({ code: l.emplacement, quantite: l.quantite }));
  const repondre = (resultat, donnees) =>
    enregistrer(connexion, req, 'export', resultat, {
      ...base, emplacements_prevus: prevus(), ...donnees, extra: { preparation: pourTelephone(p), ...(donnees.extra ?? {}) },
    });

  if (p.statut !== 'en_cours') {
    return repondre('preparation_close', {
      message: p.statut === 'terminee' ? 'Cette sortie est déjà terminée.' : `Cette sortie est annulée${p.motif_fin ? ' : ' + p.motif_fin : ''}. Recommencez la sortie.`,
    });
  }

  // Emplacement scanné
  let scanne = null;
  if (!req.body.sans_emplacement) {
    scanne = lireEmplacement(req.body.emplacement);
    if (!scanne || !R.emplacementValide(scanne, await capaciteTampon(connexion))) {
      return repondre('emplacement_inconnu', {
        emplacement_scanne: String(req.body.emplacement ?? '').trim().slice(0, 20) || null,
        message: "Ce QR ne correspond à aucun emplacement du magasin. Rescannez l'étiquette de l'emplacement.",
      });
    }
  }
  const donneesScan = { emplacement_scanne: scanne };
  if (!ticket) {
    return repondre('ticket_illisible', { ...donneesScan, message: messageIllisible(req.body.qr) });
  }

  const memeProduit = (l) => ticket.reference === p.reference && memeLot(l.lot, ticket);

  // Ticket de colis : un même colis n'est pris qu'une fois
  if (ticket.cle) {
    const [[pris]] = await connexion.query(
      `SELECT 1 AS ok FROM controles_mobile
       WHERE preparation_id = ? AND ticket = ? AND resultat IN ('prelevement_ok', 'sortie_terminee') LIMIT 1`,
      [p.id, ticket.cle]
    );
    if (pris) {
      return repondre('deja_traite', { ...donneesScan, message: `Le colis n° ${ticket.colis} est déjà pris pour cette sortie : prenez un autre colis.` });
    }
  }
  const ici = restants().filter((l) => l.emplacement === scanne);
  const ou = (liste) => [...new Set(liste.map((l) => code(l.emplacement)))].join(', ');

  // Tout est prélevé : la sortie est enregistrée comme sur le web, si le stock n'a pas changé
  const terminer = async (avant = '') => {
    const enStock = new Map((await lignesEnStock(connexion, true)).map((l) => [l.id, l]));
    const manquant = p.lignes.find((l) => {
      const s = enStock.get(l.placement_id);
      return !s || s.emplacement !== l.emplacement || s.quantite < l.quantite;
    });
    if (manquant) {
      await connexion.query(
        "UPDATE preparations_export SET statut = 'annulee', date_fin = NOW(), motif_fin = ? WHERE id = ?",
        [`Stock modifié pendant la préparation (${code(manquant.emplacement)}, lot ${manquant.lot})`, p.id]
      );
      p.statut = 'annulee';
      return repondre('stock_modifie', {
        ...donneesScan,
        message: `Le stock a changé pendant la préparation (${code(manquant.emplacement)}, lot ${manquant.lot} : sortie faite depuis le web ?). Rien n'est sorti : remettez les produits et recommencez la sortie.`,
      });
    }
    const prelevements = p.lignes.map((l) => ({ ligne: enStock.get(l.placement_id), quantite: l.quantite }));
    const horsFifo = p.lignes.some((l) => l.hors_fifo);
    const exportId = await enregistrerSortie(connexion, prelevements, {
      quantite: p.quantite, destination: p.destination, utilisateurId: req.utilisateur.id, origine: 'mobile', horsFifo,
    });
    await connexion.query(
      "UPDATE preparations_export SET statut = 'terminee', date_fin = NOW(), export_id = ? WHERE id = ?",
      [exportId, p.id]
    );
    p.statut = 'terminee';
    p.export_id = exportId;
    const restantParPlace = new Map();
    for (const l of enStock.values()) if (l.emplacement) restantParPlace.set(l.emplacement, (restantParPlace.get(l.emplacement) ?? 0) + l.quantite);
    for (const l of p.lignes) if (l.emplacement) restantParPlace.set(l.emplacement, restantParPlace.get(l.emplacement) - l.quantite);
    const liberees = [...new Set(p.lignes.map((l) => l.emplacement).filter((e) => e && restantParPlace.get(e) === 0))];
    return repondre('sortie_terminee', {
      ...donneesScan,
      message: `${avant}Sortie terminée${horsFifo ? ' (hors FIFO)' : ''} : ${p.quantite} × ${p.reference} vers ${p.destination} (export n° ${exportId}).` +
        (liberees.length ? ` Place(s) libérée(s) : ${liberees.join(', ')}.` : ''),
      extra: { export_id: exportId, places_liberees: liberees },
    });
  };

  // Administrateur : un autre lot ou un autre emplacement de la même référence, à la place du FIFO
  const priseAdmin = async () => {
    if (!estAdmin(req.utilisateur) || ticket.reference !== p.reference) return null;
    const prise = await prendreHorsFifo(connexion, p, ticket, scanne);
    if (!prise) return null;
    p = await chargerPreparation(connexion, p.id, true);
    donneesScan.reception_id = p.lignes.find((l) => l.hors_fifo && l.emplacement === scanne && l.lot === prise.lot)?.reception_id ?? null;
    const choix = `Hors FIFO : ${prise.quantite} × ${p.reference} lot ${prise.lot} pris en ${code(scanne)}` +
      (prise.remplaces.length ? ` à la place de ${prise.remplaces.join(', ')}. ` : '. ');
    if (p.restants > 0) {
      return repondre('prelevement_ok', { ...donneesScan, message: `${choix}Encore ${p.restants} prélèvement(s) : ${ou(restants())}.` });
    }
    return terminer(choix);
  };

  // Aucun prélèvement prévu à cet emplacement
  if (!ici.length) {
    const prise = await priseAdmin();
    if (prise) return prise;
    const ailleurs = restants().find(memeProduit);
    if (ailleurs) {
      return repondre('faux_emplacement', {
        ...donneesScan,
        message: `Ce n'est pas son emplacement : ${ticket.reference} lot ${ticket.lot} est enregistré en ${code(ailleurs.emplacement)}, pas en ${code(scanne)}. Rien n'est sorti.`,
      });
    }
    if (p.lignes.some((l) => l.valide && l.emplacement === scanne && memeProduit(l))) {
      return repondre('deja_traite', { ...donneesScan, message: `Ce prélèvement (${code(scanne)}, lot ${ticket.lot}) est déjà validé.` });
    }
    return repondre('faux_emplacement', {
      ...donneesScan,
      message: `Ce n'est pas le bon emplacement : rien à prendre en ${code(scanne)} pour cette sortie. Allez en ${ou(restants())}.`,
    });
  }

  // Bon emplacement : est-ce le bon produit, et le lot imposé par le FIFO ?
  const ligne = ici.find(memeProduit);
  if (!ligne) {
    const prise = await priseAdmin();
    if (prise) return prise;
    const attendus = [...new Set(ici.map((l) => l.lot))].join(' ou ');
    const message = ticket.reference !== p.reference
      ? `Mauvais produit : ${ticket.reference} au lieu de ${p.reference}. En ${code(scanne)}, prenez ${p.reference} lot ${attendus}.`
      : `FIFO : le lot ${ticket.lot} n'est pas celui à sortir. En ${code(scanne)}, prenez le lot ${attendus} (le plus ancien).`;
    return repondre('mauvais_produit', { ...donneesScan, message });
  }

  // Ticket de colis : un scan = un produit pris ; ticket par lot : le prélèvement entier
  const preleves = ticket.cle ? ligne.preleves + 1 : ligne.quantite;
  const complet = preleves >= ligne.quantite;
  await connexion.query(
    'UPDATE preparation_lignes SET preleves = ?, valide = ?, date_validation = IF(?, NOW(), NULL) WHERE id = ?',
    [preleves, complet ? 1 : 0, complet, ligne.id]
  );
  ligne.preleves = preleves;
  ligne.valide = complet;
  donneesScan.reception_id = ligne.reception_id; // quel colis est sorti (consultation d'un emplacement)
  p.restants = restants().length;

  if (!complet) {
    return repondre('prelevement_ok', {
      ...donneesScan,
      message: `Colis n° ${ticket.colis} pris : ${preleves}/${ligne.quantite} en ${code(scanne)}. Prenez encore ${ligne.quantite - preleves} colis du lot ${ligne.lot} ici.`,
    });
  }

  if (p.restants > 0) {
    return repondre('prelevement_ok', {
      ...donneesScan,
      message: `Prenez ${ligne.quantite} × ${p.reference} lot ${ligne.lot} en ${code(scanne)}. Encore ${p.restants} prélèvement(s) : ${ou(restants())}.`,
    });
  }

  return terminer();
}));

module.exports = router;
