// Sortie urgente vers la production (migration 039, décision de la direction du 2026-11-11).
// La production a besoin d'une pièce tout de suite : elle n'attend pas la fin de la réception ni le rangement.
//
//   1. POST /api/mobile/urgence  { qr, destination, saisie_manuelle?, autoriser?, autorisation?: { matricule, mot_de_passe } }
//      Ticket du colis + destination. Le colis est contrôlé comme à la réception (dans un import en réception,
//      sans doublon) ; s'il n'était pas encore scanné, il est reçu maintenant (ni carton ni palette).
//      FIFO : si la même référence est déjà en stock, il faut l'accord du chef de magasin ou de l'administrateur
//      (autoriser: true s'il est connecté lui-même, sinon son matricule et son mot de passe) ; la sortie sera « hors FIFO ».
//      L'application indique l'emplacement vide le plus proche de la porte, au bon niveau (sinon la zone tampon).
//   2. POST /api/mobile/urgence/:id/poser  { uuid, emplacement, saisie_manuelle? }
//      Colis posé : il entre au stock à cet emplacement (rangé), et sa sortie est préparée.
//      Si le colis était dans un carton ou sur une palette de cosses, il en est retiré.
//   3. La sortie : POST /api/mobile/export/:preparation_id/scan (emplacement puis ticket), comme une sortie normale.
//
//   GET  /api/mobile/urgence/en-cours      sortie urgente commencée par ce magasinier (à reprendre)
//   POST /api/mobile/urgence/:id/annuler   le colis n'est pas sorti : il reste reçu (et au stock s'il est posé)
//
// Le reste de l'import continue normalement ; à l'ajout au stock, le colis posé n'est plus à ranger.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { avecNumeros } = require('../plan');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const { lignesEnStock, occupation, poserQuantite } = require('./stock');
const { capaciteTampon } = require('../parametres');
const { estGestionnaire, GESTIONNAIRES } = require('../middleware/auth');
const { DESTINATIONS } = require('./exports');
const { lireTicket, lireEmplacement, lotsDuTicket, messageIllisible } = require('../ticket');
const { expirerPreparations, retirerReserves } = require('../reservations');
const { enregistrer, operation, controleReception } = require('./mobile').outils;
const D = require('../descentes');

const router = express.Router();
const refus = (status, message, code = null) => Object.assign(new Error(avecNumeros(message)), { status, ...(code ? { codeMetier: code } : {}) });
const LIBELLE = { bobine: 'bobine', cosse: 'cosse', connecteur: 'connecteur' };

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

// Sortie urgente pour le téléphone
async function vueUrgence(connexion, id) {
  const [[u]] = await connexion.query(
    `SELECT u.id, u.ticket, u.colis, u.reference, u.lot, u.destination, u.statut, u.emplacement_propose, u.emplacement,
            u.stock_existant, u.preparation_id, u.export_id, u.import_id, i.numero_livraison, r.type, r.taille_bobine, r.type_cosse,
            a.matricule AS autorise_par,
            DATE_FORMAT(u.date_demande, '%Y-%m-%dT%H:%i:%s') AS date_demande,
            DATE_FORMAT(u.date_posee, '%Y-%m-%dT%H:%i:%s') AS date_posee,
            DATE_FORMAT(u.date_sortie, '%Y-%m-%dT%H:%i:%s') AS date_sortie
     FROM sorties_urgentes u
     JOIN imports i ON i.id = u.import_id
     JOIN receptions r ON r.id = u.reception_id
     LEFT JOIN utilisateurs a ON a.id = u.autorise_par
     WHERE u.id = ?`,
    [id]
  );
  return u ?? null;
}

// Emplacement vide le plus proche de la porte pour ce type de produit (niveau des bobines, des cosses ou des
// connecteurs), sinon une place tampon vide. Les places déjà proposées à une autre sortie urgente sont évitées.
async function placeVide(connexion, type, sauf = null) {
  const occ = await occupation(connexion, true);
  const pris = new Set(occ.filter((l) => l.emplacement && Number(l.quantite) > 0).map((l) => l.emplacement));
  const [proposees] = await connexion.query(
    "SELECT emplacement_propose FROM sorties_urgentes WHERE statut = 'a_poser' AND emplacement_propose IS NOT NULL AND id <> ?",
    [sauf ?? 0]
  );
  const evitees = new Set(proposees.map((p) => p.emplacement_propose));
  const libres = (liste) => liste.filter((c) => !pris.has(c));
  const rayon = libres(R.emplacementsDuType(type));
  const tampon = libres(R.placesTampon(await capaciteTampon(connexion)));
  const choix = rayon.find((c) => !evitees.has(c)) ?? tampon.find((c) => !evitees.has(c)) ?? rayon[0] ?? tampon[0] ?? null;
  return choix ? { code: choix, tampon: R.estTampon(choix), pris } : { code: null, tampon: false, pris };
}

// Scan de réception du colis (le premier enregistré), avec sa ligne et son import
async function receptionDuColis(connexion, cle) {
  const [[c]] = await connexion.query(
    `SELECT c.id, c.resultat, c.reception_id, c.carton_id, c.palette_cosses_id, c.palette_id, r.import_id, r.type, i.statut AS statut_import,
            i.numero_livraison
     FROM controles_mobile c
     JOIN receptions r ON r.id = c.reception_id
     JOIN imports i ON i.id = r.import_id
     WHERE c.ticket = ? AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite')
     ORDER BY c.id LIMIT 1 FOR UPDATE`,
    [cle]
  );
  return c ?? null;
}

// Import en réception qui attend ce colis (le plus ancien), ou null
async function importQuiAttend(connexion, ticket) {
  const [[imp]] = await connexion.query(
    `SELECT i.id FROM imports i
     WHERE i.statut = 'en_attente' AND i.reception <> 'terminee'
       AND ((i.mode = 'resume' AND EXISTS (SELECT 1 FROM imports_attendus a WHERE a.import_id = i.id AND UPPER(TRIM(a.reference)) = ?))
         OR (COALESCE(i.mode, '') <> 'resume' AND EXISTS (SELECT 1 FROM receptions r WHERE r.import_id = i.id AND UPPER(TRIM(r.reference)) = ? AND TRIM(r.lot) IN (?))))
     ORDER BY COALESCE(i.date_envoi, i.date_creation), i.id LIMIT 1`,
    [ticket.reference, ticket.reference, lotsDuTicket(ticket)]
  );
  return imp ?? null;
}

// Accord du chef de magasin ou de l'administrateur : identifiant de celui qui autorise, ou null (pas d'accord envoyé)
async function autorisation(connexion, req) {
  if (estGestionnaire(req.utilisateur) && req.body?.autoriser === true) return req.utilisateur.id;
  const a = req.body?.autorisation;
  if (!a || !String(a.matricule ?? '').trim()) return null;
  const [[u]] = await connexion.query('SELECT id, role, actif, mot_de_passe FROM utilisateurs WHERE matricule = ?', [String(a.matricule).trim()]);
  const valide = u && (await bcrypt.compare(String(a.mot_de_passe ?? ''), u.mot_de_passe));
  if (!valide || !u.actif) throw refus(409, "Matricule ou mot de passe du chef incorrect : la sortie urgente n'est pas autorisée.", 'autorisation_refusee');
  if (!GESTIONNAIRES.includes(u.role)) throw refus(409, "Seul le chef de magasin ou l'administrateur peut autoriser cette sortie.", 'autorisation_refusee');
  return u.id;
}

// Sortie en cours (normale ou urgente) de ce magasinier : une seule à la fois
async function sortieEnCours(connexion, utilisateurId, sauf = null) {
  await expirerPreparations(connexion);
  const [[p]] = await connexion.query(
    "SELECT id, reference, quantite FROM preparations_export WHERE statut = 'en_cours' AND utilisateur_id = ? AND id <> ? LIMIT 1",
    [utilisateurId, sauf ?? 0]
  );
  return p ?? null;
}

// Sortie préparée du colis posé : la sortie mobile (1 × référence vers la destination) sur son emplacement.
// Recréée si l'ancienne a été annulée ou a expiré et que le colis est toujours à sa place.
// Renvoie l'identifiant de la sortie, ou null si le colis n'est plus à sa place (sortie urgente annulée).
async function preparerSortie(connexion, u, utilisateurId) {
  if (u.preparation_id) {
    const [[p]] = await connexion.query('SELECT statut, export_id FROM preparations_export WHERE id = ?', [u.preparation_id]);
    if (p?.statut === 'en_cours') return u.preparation_id;
    if (p?.statut === 'terminee') {
      await connexion.query("UPDATE sorties_urgentes SET statut = 'sortie', export_id = ?, date_sortie = COALESCE(date_sortie, NOW()) WHERE id = ?", [p.export_id, u.id]);
      return u.preparation_id;
    }
  }
  const [[pl]] = await connexion.query(
    `SELECT p.id, r.lot, DATE_FORMAT(r.date_reception, '%Y-%m-%d %H:%i:%s') AS date_reception
     FROM placements p JOIN receptions r ON r.id = p.reception_id
     WHERE p.reception_id = ? AND p.emplacement = ? AND p.quantite > 0 FOR UPDATE`,
    [u.reception_id, u.emplacement]
  );
  if (!pl) {
    await connexion.query("UPDATE sorties_urgentes SET statut = 'annulee' WHERE id = ?", [u.id]);
    return null;
  }
  const autre = await sortieEnCours(connexion, utilisateurId);
  if (autre) throw refus(409, `Terminez ou annulez d'abord la sortie en cours (${autre.quantite} × ${autre.reference}) dans « Export ».`);
  const [p] = await connexion.query(
    'INSERT INTO preparations_export (uuid, reference, quantite, destination, utilisateur_id) VALUES (?, ?, 1, ?, ?)',
    [crypto.randomUUID(), u.reference, u.destination, utilisateurId]
  );
  await connexion.query(
    `INSERT INTO preparation_lignes (preparation_id, ordre, placement_id, reception_id, lot, date_reception, emplacement, quantite, hors_fifo)
     VALUES (?, 1, ?, ?, ?, ?, ?, 1, ?)`,
    [p.insertId, pl.id, u.reception_id, pl.lot, pl.date_reception, u.emplacement, u.autorise_par ? 1 : 0]
  );
  await connexion.query('UPDATE sorties_urgentes SET preparation_id = ? WHERE id = ?', [p.insertId, u.id]);
  return p.insertId;
}

const consignePoser = (place, type) =>
  place.code
    ? `posez-le en ${place.code}${place.tampon ? ' (zone tampon : plus d’emplacement vide)' : ', l’emplacement vide le plus proche de la porte'}, puis scannez l’étiquette de l’emplacement.`
    : 'aucun emplacement vide ni place tampon libre : appelez le chef.';

// Colis pas encore posé dont l'import est entré au stock entre-temps : la sortie urgente n'est plus possible
// (le colis a reçu son emplacement imposé) ; elle est annulée. Renvoie le message à afficher, ou null.
// (l'ajout au stock de l'import annule déjà ses sorties urgentes pas encore posées : routes/imports.js)
async function annulerSiImportAuStock(connexion, u) {
  if (u.date_posee || !['a_poser', 'annulee'].includes(u.statut)) return null;
  const [[imp]] = await connexion.query('SELECT statut, numero_livraison FROM imports WHERE id = ?', [u.import_id]);
  if (imp?.statut === 'en_attente') return null;
  if (u.statut === 'a_poser') await connexion.query("UPDATE sorties_urgentes SET statut = 'annulee' WHERE id = ?", [u.id]);
  return avecNumeros(`Sortie urgente du colis n° ${u.colis} (${u.reference}) annulée : l'import ${imp?.numero_livraison ?? 'n° ' + u.import_id} est entré au stock avant que le colis soit posé. Rangez-le à sa place (Rangement), puis sortez-le avec « Export ».`);
}

// GET /en-cours : la sortie urgente commencée par ce magasinier (colis à poser, ou posé et pas encore sorti)
router.get('/en-cours', transaction(async (connexion, req) => {
  const [[u]] = await connexion.query(
    "SELECT * FROM sorties_urgentes WHERE utilisateur_id = ? AND statut IN ('a_poser', 'posee') ORDER BY date_demande DESC, id DESC LIMIT 1 FOR UPDATE",
    [req.utilisateur.id]
  );
  if (!u) return { urgence: null };
  const annulee = await annulerSiImportAuStock(connexion, u);
  if (annulee) return { urgence: null, message: annulee };
  let message = null;
  if (u.statut === 'posee') {
    try {
      await preparerSortie(connexion, u, req.utilisateur.id);
    } catch (err) {
      if (!err.status) throw err;
      message = err.message; // une autre sortie est en cours : la sortie urgente attend
    }
  }
  const urgence = await vueUrgence(connexion, u.id);
  return { urgence: ['a_poser', 'posee'].includes(urgence.statut) ? urgence : null, message };
}));

// POST / : 1re étape, ticket du colis et destination
router.post('/', transaction(async (connexion, req) => {
  const destination = String(req.body?.destination ?? '').trim().toUpperCase();
  if (!DESTINATIONS.includes(destination)) throw refus(400, `Choisissez la destination : ${DESTINATIONS.join(', ')}.`);
  const ticket = lireTicket(req.body?.qr);
  if (!ticket) throw refus(400, messageIllisible(req.body?.qr));
  if (!ticket.cle) throw refus(409, 'Scannez le QR du bas du ticket vert : il porte le n° du colis (une sortie urgente se fait colis par colis).');
  const nom = `Le colis n° ${ticket.colis} de ${ticket.reference} lot ${ticket.lot}${ticket.suffixe ? '-' + ticket.suffixe : ''}`;

  const [[deja]] = await connexion.query('SELECT * FROM sorties_urgentes WHERE ticket = ? FOR UPDATE', [ticket.cle]);
  if (deja?.statut === 'sortie') throw refus(409, `${nom} est déjà sorti en urgence vers ${deja.destination}.`);
  if (deja?.statut === 'posee') {
    if (deja.utilisateur_id !== req.utilisateur.id && !estGestionnaire(req.utilisateur)) {
      throw refus(409, `${nom} est déjà posé en ${deja.emplacement} pour la sortie urgente d'un autre magasinier.`);
    }
    await preparerSortie(connexion, deja, req.utilisateur.id);
    const vue = await vueUrgence(connexion, deja.id);
    if (vue.statut !== 'posee') throw refus(409, `${nom} n'est plus en ${deja.emplacement} : il a été déplacé ou sorti. Consultez l'emplacement.`);
    return { urgence: vue, message: avecNumeros(`${nom} est déjà posé en ${deja.emplacement} : scannez l'emplacement puis le ticket pour le sortir vers ${deja.destination}.`) };
  }
  const autre = await sortieEnCours(connexion, req.utilisateur.id);
  if (autre) throw refus(409, `Terminez ou annulez d'abord la sortie en cours (${autre.quantite} × ${autre.reference}) dans « Export ».`);
  const descente = await D.descenteEnCours(connexion, req.utilisateur.id);
  if (descente) throw refus(409, `D'abord : ${D.texteDescente(descente)} (écran Export).`);
  const [[sorti]] = await connexion.query(
    "SELECT 1 AS oui FROM controles_mobile WHERE ticket = ? AND controle = 'export' AND resultat IN ('prelevement_ok', 'sortie_terminee') LIMIT 1",
    [ticket.cle]
  );
  if (sorti) throw refus(409, `${nom} est déjà sorti du magasin.`);

  // Le colis : déjà reçu (il doit attendre au quai, pas encore au stock), sinon attendu par un import en réception
  let recu = await receptionDuColis(connexion, ticket.cle);
  let imp = null;
  if (recu) {
    if (recu.resultat !== 'conforme') throw refus(409, `${nom} est en trop (l'import en annonce moins) : pas de sortie urgente. Appelez le chef.`);
    if (recu.statut_import !== 'en_attente') {
      throw refus(409, `${nom} est déjà entré au stock (import ${recu.numero_livraison ?? 'n° ' + recu.import_id}) : rangez-le à sa place, puis sortez-le avec « Export ».`);
    }
    if (recu.palette_id) throw refus(409, `${nom} est sur une palette de réception : retirez-le de la palette, puis recommencez la sortie urgente.`);
    const [[range]] = await connexion.query(
      "SELECT emplacement_scanne FROM controles_mobile WHERE ticket = ? AND controle = 'rangement' AND resultat = 'bon_emplacement' LIMIT 1",
      [ticket.cle]
    );
    if (range) throw refus(409, `${nom} est déjà rangé en ${range.emplacement_scanne} : sortez-le avec « Export ».`);
  } else {
    imp = await importQuiAttend(connexion, ticket);
    if (!imp) throw refus(409, `${nom} n'est attendu dans aucun import en réception : pas de sortie urgente. Vérifiez le ticket ou appelez le chef.`);
  }

  // FIFO : la même référence déjà en stock (hors produits réservés par une sortie en préparation) se sort d'abord
  const stock = (await retirerReserves(connexion, await lignesEnStock(connexion, true))).filter((l) => l.reference.toUpperCase() === ticket.reference);
  const enStock = stock.reduce((t, l) => t + Number(l.quantite), 0);
  let autorisePar = null;
  if (enStock > 0) {
    autorisePar = await autorisation(connexion, req);
    if (!autorisePar) {
      const ou = [...new Set(stock.map((l) => l.emplacement ?? 'non rangé'))].slice(0, 4).join(', ');
      throw refus(409,
        `Il y a déjà ${enStock} × ${ticket.reference} en stock (${ou}) : FIFO, prenez-les d'abord avec « Export ». ` +
        "Pour sortir ce colis quand même, le chef de magasin ou l'administrateur doit autoriser.",
        'autorisation_requise');
    }
  }

  // Pas encore scanné à la réception : contrôlé et reçu maintenant (ni carton ni palette)
  let recuMaintenant = false;
  if (!recu) {
    const scan = { body: { uuid: crypto.randomUUID(), qr: req.body.qr, import_id: imp.id, saisie_manuelle: !!req.body.saisie_manuelle }, utilisateur: req.utilisateur, urgence: true };
    const r = await controleReception(connexion, scan);
    if (r.resultat !== 'conforme') throw refus(409, `${r.message} Pas de sortie urgente pour ce colis.`);
    recu = await receptionDuColis(connexion, ticket.cle);
    recuMaintenant = true;
  }

  const [[ligne]] = await connexion.query('SELECT type, lot FROM receptions WHERE id = ?', [recu.reception_id]);
  const place = await placeVide(connexion, ligne.type, deja?.id);
  if (!place.code) throw refus(409, 'Aucun emplacement vide ni place tampon libre : appelez le chef (agrandir la zone tampon ou ranger le magasin).');
  const valeurs = [recu.reception_id, recu.import_id, destination, place.code, enStock, autorisePar, req.utilisateur.id];
  let id = deja?.id;
  if (deja) {
    await connexion.query(
      `UPDATE sorties_urgentes SET reception_id = ?, import_id = ?, destination = ?, statut = 'a_poser', emplacement_propose = ?, emplacement = NULL,
              stock_existant = ?, autorise_par = ?, utilisateur_id = ?, preparation_id = NULL, date_demande = NOW(), date_posee = NULL WHERE id = ?`,
      [...valeurs, deja.id]
    );
  } else {
    const [n] = await connexion.query(
      `INSERT INTO sorties_urgentes (reception_id, import_id, destination, emplacement_propose, stock_existant, autorise_par, utilisateur_id, ticket, colis, reference, lot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...valeurs, ticket.cle, ticket.colis, ticket.reference, ligne.lot]
    );
    id = n.insertId;
  }
  // Une seule sortie urgente à poser à la fois : la précédente de ce magasinier est abandonnée (le colis reste reçu)
  await connexion.query("UPDATE sorties_urgentes SET statut = 'annulee' WHERE utilisateur_id = ? AND statut = 'a_poser' AND id <> ?", [req.utilisateur.id, id]);

  const dans = recu.carton_id ? ' Il sera retiré de son carton.' : recu.palette_cosses_id ? ' Il sera retiré de sa palette.' : '';
  const hors = autorisePar ? ' Sortie hors FIFO autorisée.' : '';
  return {
    urgence: await vueUrgence(connexion, id),
    message: avecNumeros(`${recuMaintenant ? 'Colis reçu, conforme à l’import. ' : ''}Sortie urgente vers ${destination} : ${consignePoser(place, ligne.type)}${dans}${hors}`),
  };
}));

// Colis retiré de son carton ou de sa palette de cosses (réception pas terminée) : ce qu'il faut dire au magasinier
async function retirerDuCarton(connexion, controle) {
  await connexion.query('UPDATE controles_mobile SET carton_id = NULL, palette_cosses_id = NULL WHERE id = ?', [controle.id]);
  const notes = [];
  if (controle.carton_id) {
    const [[k]] = await connexion.query('SELECT id, numero, statut, date_etiquette FROM cartons WHERE id = ? FOR UPDATE', [controle.carton_id]);
    const [[{ n }]] = await connexion.query("SELECT COUNT(*) AS n FROM controles_mobile WHERE carton_id = ? AND controle = 'reception'", [k.id]);
    if (!Number(n) && k.statut !== 'ouvert') {
      await connexion.query('DELETE FROM cartons WHERE id = ?', [k.id]);
      notes.push(`Le carton n° ${k.numero} est maintenant vide : il est annulé.`);
    } else if (k.date_etiquette) {
      // l'ancienne étiquette compte une cosse de trop : elle devient inconnue, la nouvelle s'imprime sur le web
      await connexion.query('UPDATE cartons SET date_etiquette = NULL WHERE id = ?', [k.id]);
      notes.push(`Retiré du carton n° ${k.numero} : réimprimez son étiquette (web, page Import).`);
    } else {
      notes.push(`Retiré du carton n° ${k.numero}.`);
    }
  }
  if (controle.palette_cosses_id) {
    const [[p]] = await connexion.query('SELECT id, numero, statut FROM palettes_cosses WHERE id = ? FOR UPDATE', [controle.palette_cosses_id]);
    const [[{ n }]] = await connexion.query("SELECT COUNT(*) AS n FROM controles_mobile WHERE palette_cosses_id = ? AND controle = 'reception'", [p.id]);
    if (!Number(n) && p.statut === 'terminee') {
      await connexion.query('DELETE FROM cartons WHERE palette_id = ?', [p.id]);
      await connexion.query('DELETE FROM palettes_cosses WHERE id = ?', [p.id]);
      notes.push(`La palette n° ${p.numero} est maintenant vide : elle est annulée.`);
    } else if (!controle.carton_id) {
      notes.push(`Retiré de la palette n° ${p.numero}.`);
    }
  }
  return notes.length ? ' ' + notes.join(' ') : '';
}

// POST /:id/poser { uuid, emplacement } : 2e étape, le colis est posé (il entre au stock) et sa sortie est préparée
router.post('/:id/poser', operation('rangement', async (connexion, req) => {
  const [[u]] = await connexion.query('SELECT * FROM sorties_urgentes WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
  if (!u) throw refus(404, 'Sortie urgente introuvable');
  if (u.utilisateur_id !== req.utilisateur.id && !estGestionnaire(req.utilisateur)) throw refus(409, "Cette sortie urgente est celle d'un autre magasinier.");
  // Import entré au stock avant que le colis soit posé : la sortie urgente est annulée, le téléphone revient au début
  const fin = await annulerSiImportAuStock(connexion, u);
  if (fin) {
    return {
      uuid: req.body.uuid, controle: 'rangement', resultat: 'urgence_annulee', couleur: 'rouge', titre: 'Sortie urgente annulée', message: fin,
      produit: { reference: u.reference, lot: u.lot }, quantite_ticket: 1, quantite_attendue: null, ecart: null, emplacements_prevus: [],
      emplacement_scanne: null, saisie_manuelle: !!req.body.saisie_manuelle, date: new Date().toISOString(),
      urgence: await vueUrgence(connexion, u.id),
    };
  }
  if (u.statut === 'posee') throw refus(409, `Le colis est déjà posé en ${u.emplacement} : scannez l'emplacement puis le ticket pour le sortir.`);
  if (u.statut !== 'a_poser') throw refus(409, u.statut === 'sortie' ? 'Ce colis est déjà sorti.' : 'Cette sortie urgente est annulée : recommencez.');
  const [[ligne]] = await connexion.query('SELECT type FROM receptions WHERE id = ?', [u.reception_id]);
  const code = lireEmplacement(req.body.emplacement);
  const base = {
    reference: u.reference, lot: u.lot, ticket: u.ticket, quantite_ticket: 1, reception_id: u.reception_id, import_id: u.import_id, emplacement_scanne: code,
    emplacements_prevus: [{ code: u.emplacement_propose, quantite: 1 }],
  };
  if (!code || !R.emplacementValide(code, await capaciteTampon(connexion))) {
    return enregistrer(connexion, req, 'rangement', 'emplacement_inconnu', {
      ...base, emplacement_scanne: String(req.body.emplacement ?? '').trim().slice(0, 20) || null,
      message: `Ce QR ne correspond à aucun emplacement du magasin. Scannez l'étiquette de ${u.emplacement_propose}.`,
    });
  }
  if (!R.estTampon(code) && R.typeEmplacement(code) !== ligne.type) {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
      ...base, message: `${code} n'est pas un emplacement de ${LIBELLE[ligne.type]}s : posez le colis en ${u.emplacement_propose}. Rien n'est enregistré.`,
    });
  }
  // Seul l'emplacement proposé est accepté. S'il a été pris entre-temps, l'application en propose un nouveau.
  const place = await placeVide(connexion, ligne.type, u.id);
  let cible = u.emplacement_propose;
  if (!cible || place.pris.has(cible)) {
    cible = place.code;
    if (cible) await connexion.query('UPDATE sorties_urgentes SET emplacement_propose = ? WHERE id = ?', [cible, u.id]);
  }
  if (!cible) {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', { ...base, emplacements_prevus: [], message: "Aucun emplacement vide près de la porte : appelez le chef. Rien n'est enregistré." });
  }
  if (code !== cible) {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
      ...base, emplacements_prevus: [{ code: cible, quantite: 1 }],
      message: `Posez le colis en ${cible}, pas en ${code}${cible !== u.emplacement_propose ? ` (${u.emplacement_propose} a été pris entre-temps)` : ''}. Rien n'est enregistré.`,
    });
  }
  const [[imp]] = await connexion.query('SELECT statut, numero_livraison FROM imports WHERE id = ? FOR UPDATE', [u.import_id]);
  if (imp.statut !== 'en_attente') {
    throw refus(409, `L'import ${imp.numero_livraison ?? 'n° ' + u.import_id} est entré au stock entre-temps : rangez le colis à sa place, puis sortez-le avec « Export ».`);
  }
  const recu = await receptionDuColis(connexion, u.ticket);
  if (!recu || recu.resultat !== 'conforme') throw refus(409, "Ce colis n'est plus reçu (retiré de la réception ?) : recommencez la sortie urgente.");
  const autre = await sortieEnCours(connexion, req.utilisateur.id);
  if (autre) throw refus(409, `Terminez ou annulez d'abord la sortie en cours (${autre.quantite} × ${autre.reference}) dans « Export ».`);

  const note = recu.carton_id || recu.palette_cosses_id ? await retirerDuCarton(connexion, recu) : '';
  // Le colis entre au stock à cet emplacement, rangé (il ne sera plus à ranger à l'ajout de l'import au stock)
  await poserQuantite(connexion, u.reception_id, code, 1);
  await connexion.query(
    `INSERT INTO affectations_colis (reception_id, ticket, colis, emplacement, range_le) VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE reception_id = VALUES(reception_id), emplacement = VALUES(emplacement), range_le = NOW()`,
    [u.reception_id, u.ticket, u.colis, code]
  );
  await connexion.query("UPDATE sorties_urgentes SET statut = 'posee', emplacement = ?, date_posee = NOW() WHERE id = ?", [code, u.id]);
  await preparerSortie(connexion, { ...u, statut: 'posee', emplacement: code, preparation_id: null }, req.utilisateur.id);
  return enregistrer(connexion, req, 'rangement', 'bon_emplacement', {
    ...base, emplacements_prevus: [{ code, quantite: 1 }],
    extra: { urgence: await vueUrgence(connexion, u.id) },
    message: `Colis n° ${u.colis} posé en ${code}. Pour le sortir vers ${u.destination} : scannez l'étiquette de ${code}, puis le ticket.${note}`,
  });
}));

// POST /:id/annuler : la sortie urgente n'a pas lieu. Le colis reste reçu ; s'il est posé, il reste au stock à sa place.
router.post('/:id/annuler', transaction(async (connexion, req) => {
  const [[u]] = await connexion.query('SELECT * FROM sorties_urgentes WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
  if (!u) throw refus(404, 'Sortie urgente introuvable');
  if (u.utilisateur_id !== req.utilisateur.id && !estGestionnaire(req.utilisateur)) throw refus(409, "Cette sortie urgente est celle d'un autre magasinier.");
  if (u.statut === 'sortie') throw refus(409, 'Ce colis est déjà sorti : la sortie ne s’annule plus.');
  if (u.preparation_id) {
    await connexion.query(
      "UPDATE preparations_export SET statut = 'annulee', date_fin = NOW(), motif_fin = ? WHERE id = ? AND statut = 'en_cours'",
      [`Sortie urgente annulée par ${req.utilisateur.matricule}`, u.preparation_id]
    );
  }
  await connexion.query("UPDATE sorties_urgentes SET statut = 'annulee' WHERE id = ?", [u.id]);
  return {
    urgence: await vueUrgence(connexion, u.id),
    message: avecNumeros(u.statut === 'posee'
      ? `Sortie urgente annulée : le colis n° ${u.colis} reste au stock en ${u.emplacement}.`
      : `Sortie urgente annulée : le colis n° ${u.colis} reste reçu, il sera rangé avec son import.`),
  };
}));

module.exports = router;
