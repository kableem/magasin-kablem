// API de l'application mobile : contrôle du travail du magasinier au scan du ticket vert.
//
//   Contrôle 1 (POST /reception) : le produit reçu correspond-il à une ligne d'import ?
//   Contrôle 2 (POST /rangement) : le produit est-il posé sur l'emplacement prévu ?
//
// Option (a) : le stock reste alimenté par « Ajouter au stock » dans l'application web.
// Le mobile contrôle et trace ; il n'écrit jamais dans placements. L'emplacement prévu est
// celui que l'application a calculé : plan proposé (import en attente) ou emplacement réel
// du produit (import ajouté au stock).
//
// Toutes les règles sont ici, jamais dans le téléphone. Chaque opération porte un uuid généré
// par le téléphone : si le même uuid revient (renvoi après coupure Wi-Fi), la réponse
// enregistrée est renvoyée telle quelle, sans nouveau contrôle.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { avecNumeros } = require('../plan');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const { lignesEnStock, occupation, poserQuantite } = require('./stock');
const { parametresRangement, capaciteTampon } = require('../parametres');
const { exigerGestionnaire } = require('../middleware/auth');
const { lireTicket, lireEmplacement, lotsDuTicket, messageIllisible } = require('../ticket');
const { affectationDuColis } = require('../affectations');
const { TYPES_PALETTE, typePalette, nommer } = require('../palettes');
const { receptionPrecedenteNonTerminee, messageOrdreReception } = require('./imports');
const { tolerancePieces, modeReception } = require('../parametres');
const { nombre } = require('../import-resume');
const { typesDuCatalogue } = require('../articles');
const C = require('../cartons');
const P = require('../palettes-cosses');

const refus = (status, message) => Object.assign(new Error(message), { status });

const router = express.Router();

const COULEURS = {
  conforme: 'vert',
  bon_emplacement: 'vert',
  ecart_quantite: 'orange',
  import_en_attente: 'orange',
  inconnu: 'rouge',
  deja_traite: 'rouge',
  emplacement_complet: 'rouge',
  non_recu: 'rouge',
  faux_emplacement: 'rouge',
  emplacement_inconnu: 'rouge',
  ticket_illisible: 'rouge',
  prelevement_ok: 'vert',
  sortie_terminee: 'vert',
  mauvais_produit: 'rouge',
  stock_modifie: 'rouge',
  preparation_close: 'rouge',
  a_ranger: 'vert',
  sans_emplacement: 'orange',
  deplace: 'vert',
  deplacement_refuse: 'rouge',
  carton: 'orange',
  correction: 'orange', // correction d'une erreur à la réception (migration 044)
};
const TITRES = {
  conforme: 'Conforme',
  ecart_quantite: 'Écart de quantité',
  inconnu: 'Produit inconnu',
  deja_traite: 'Ticket déjà traité',
  non_recu: 'Réception non contrôlée',
  import_en_attente: 'Import pas encore au stock',
  bon_emplacement: 'Ajouté au stock',
  faux_emplacement: "Ce n'est pas son emplacement",
  emplacement_complet: 'Emplacement déjà complet',
  emplacement_inconnu: 'Emplacement inconnu',
  ticket_illisible: 'Ticket illisible',
  prelevement_ok: 'Bon produit, bon emplacement',
  sortie_terminee: 'Sortie terminée',
  mauvais_produit: 'Mauvais produit',
  stock_modifie: 'Stock modifié : sortie refusée',
  preparation_close: 'Sortie déjà close',
  a_ranger: 'Produit à ranger',
  sans_emplacement: "Pas d'emplacement prévu",
  deplace: 'Déplacé',
  deplacement_refuse: 'Déplacement refusé',
  carton: 'Cosse dans un carton',
  correction: 'Correction du magasinier',
};
const ALERTES = ['ecart_quantite', 'faux_emplacement', 'inconnu', 'mauvais_produit', 'stock_modifie', 'deplacement_refuse', 'correction'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// Lignes d'import ayant cette référence et ce lot, avec leur avancement (verrouillées)
async function lignesDuTicket(connexion, reference, lots) {
  const [lignes] = await connexion.query(
    `SELECT r.id, r.import_id, i.statut AS statut_import, i.numero_livraison, r.type, r.taille_bobine, r.type_cosse,
            r.reference, r.lot, r.quantite - COALESCE(rc.quantite, 0) AS attendue,
            EXISTS (SELECT 1 FROM controles_mobile c WHERE c.reception_id = r.id AND c.controle = 'reception'
                    AND c.resultat IN ('conforme', 'ecart_quantite')) AS recue,
            IF(EXISTS (SELECT 1 FROM plans_rangement pr WHERE pr.reception_id = r.id),
               NOT EXISTS (SELECT 1 FROM plans_rangement pr WHERE pr.reception_id = r.id AND pr.ranges < pr.quantite),
               EXISTS (SELECT 1 FROM placements p WHERE p.reception_id = r.id AND p.emplacement IS NOT NULL)) AS rangee
     FROM receptions r
     JOIN imports i ON i.id = r.import_id
     LEFT JOIN reclamations rc ON rc.reception_id = r.id
     WHERE UPPER(TRIM(r.reference)) = ? AND TRIM(r.lot) IN (?)
     ORDER BY i.date_creation, i.id, r.id
     FOR UPDATE OF r`,
    [reference, lots]
  );
  return lignes.map((l) => ({ ...l, attendue: Number(l.attendue), recue: !!l.recue, rangee: !!l.rangee }));
}

// Emplacement(s) prévu(s) pour une ligne : son plan de rangement (places réservées, avec ce qui est
// déjà rangé) une fois la réception validée, sinon le plan que l'application calculera
async function emplacementsPrevus(connexion, ligne) {
  if (ligne.statut_import === 'ajoute') {
    const [plan] = await connexion.query(
      'SELECT emplacement, quantite, ranges FROM plans_rangement WHERE reception_id = ? ORDER BY id',
      [ligne.id]
    );
    if (plan.length) return plan.map((x) => ({ code: x.emplacement, quantite: x.quantite, ranges: x.ranges }));
    // Ligne entrée au stock sans plan (non rangée, ou avant cette règle)
    const [p] = await connexion.query(
      'SELECT emplacement, quantite FROM placements WHERE reception_id = ? ORDER BY emplacement',
      [ligne.id]
    );
    return p.map((x) => ({ code: x.emplacement, quantite: x.quantite, ranges: x.quantite }));
  }
  const [produits] = await connexion.query(
    `SELECT r.id, r.type, r.taille_bobine, r.type_cosse, r.reference, r.lot, r.quantite - COALESCE(rc.quantite, 0) AS quantite,
            r.longueur, r.largeur, r.hauteur, r.poids
     FROM receptions r LEFT JOIN reclamations rc ON rc.reception_id = r.id
     WHERE r.import_id = ?`,
    [ligne.import_id]
  );
  const nombre = (v) => (v === null ? null : Number(v));
  const aRanger = produits
    .map((p) => ({ ...p, quantite: Number(p.quantite), longueur: nombre(p.longueur), largeur: nombre(p.largeur), hauteur: nombre(p.hauteur), poids: nombre(p.poids) }))
    .filter((p) => p.quantite > 0);
  const enPlace = (await occupation(connexion)).filter((l) => l.emplacement);
  const plan = R.proposerPlan(aRanger, enPlace, await parametresRangement(connexion));
  return plan.filter((p) => p.id === ligne.id).map((p) => ({ code: p.emplacement, quantite: p.quantite }));
}

// Rangement pendant la réception (décision du 2026-11-27) : un colis reçu se range tout de suite, sans attendre la
// validation de l'import. Sa place est calculée maintenant, avec les mêmes règles qu'à la fin de la réception
// (niveau, capacité, zone tampon), pour ce seul colis. null si aucune place.
async function placeAvantValidation(connexion, receptionId) {
  const [[p]] = await connexion.query(
    'SELECT id, type, taille_bobine, type_cosse, reference, lot, longueur, largeur, hauteur, poids FROM receptions WHERE id = ?',
    [receptionId]
  );
  if (!p) return null;
  const nombre = (v) => (v === null ? null : Number(v));
  const produit = { ...p, quantite: 1, longueur: nombre(p.longueur), largeur: nombre(p.largeur), hauteur: nombre(p.hauteur), poids: nombre(p.poids) };
  const enPlace = (await occupation(connexion, true)).filter((l) => l.emplacement);
  const plan = R.proposerPlan([produit], enPlace, await parametresRangement(connexion));
  return plan.find((x) => x.emplacement)?.emplacement ?? null;
}

const texteEmplacements = (liste) => liste.map((e) => e.code ?? 'non rangé').join(', ') || null;

// Réponse pour le téléphone (même forme pour un contrôle enregistré et pour une suggestion)
function reponseControle(req, controle, resultat, donnees) {
  const d = {
    reference: null, lot: null, quantite_ticket: null, pieces: null, quantite_attendue: null, ecart: null,
    ligne: null, reception_id: null, emplacements_prevus: [], emplacement_scanne: null, preparation_id: null, palette_id: null, ticket: null, extra: {}, ...donnees,
  };
  d.message = avecNumeros(d.message);
  const reponse = {
    uuid: req.body.uuid,
    controle,
    resultat,
    couleur: COULEURS[resultat],
    titre: TITRES[resultat],
    message: d.message,
    produit: d.ligne
      ? {
          reference: d.ligne.reference, lot: d.ligne.lot, type: d.ligne.type, taille_bobine: d.ligne.taille_bobine,
          import_id: d.ligne.import_id, numero_livraison: d.ligne.numero_livraison,
        }
      : d.reference ? { reference: d.reference, lot: d.lot } : null,
    quantite_ticket: d.quantite_ticket,
    quantite_attendue: d.quantite_attendue,
    ecart: d.ecart,
    emplacements_prevus: d.emplacements_prevus,
    emplacement_scanne: d.emplacement_scanne,
    saisie_manuelle: !!req.body.saisie_manuelle,
    date: new Date().toISOString(),
    ...d.extra,
  };
  return { d, reponse };
}

// Réception d'un import en cartons : la cosse reçue (conforme, en trop ou hors import) entre dans le
// carton ouvert du magasinier ; la 1re fixe sa référence et son lot. Renvoie l'id du carton, ou null.
async function rattacherAuCarton(connexion, req, controle, resultat, d, reponse) {
  const c = req.cartonReception;
  if (controle !== 'reception' || !c || !['conforme', 'ecart_quantite', 'inconnu'].includes(resultat)) return null;
  if (!(d.import_id ?? d.ligne?.import_id)) return null; // cosse d'un autre import : pas dans ce carton
  await connexion.query('UPDATE cartons SET reference = COALESCE(reference, ?), lot = COALESCE(lot, ?) WHERE id = ?', [d.reference, c.lotComplet, c.id]);
  const [[{ n }]] = await connexion.query(
    "SELECT COUNT(*) AS n FROM controles_mobile WHERE carton_id = ? AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite', 'inconnu')",
    [c.id]
  );
  const cosses = Number(n) + 1;
  reponse.carton = { id: c.id, numero: c.numero, reference: c.reference ?? d.reference, lot: c.lot ?? c.lotComplet, cosses, scan: req.body.uuid };
  reponse.message = d.message = `${d.message} Carton n° ${c.numero} : ${cosses} cosse${cosses > 1 ? 's' : ''}.`;
  return c.id;
}

// Cosse plate reçue pendant qu'une palette est ouverte (dans un carton ou séparée) : elle est sur cette palette.
// Renvoie l'id de la palette, ou null.
async function rattacherALaPalette(connexion, req, controle, resultat, d, reponse) {
  const p = req.paletteReception;
  if (controle !== 'reception' || !p || !['conforme', 'ecart_quantite', 'inconnu'].includes(resultat)) return null;
  if (!(d.import_id ?? d.ligne?.import_id)) return null; // cosse d'un autre import : pas sur cette palette
  const [[{ n, cartons, ce_carton }]] = await connexion.query(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT carton_id) AS cartons, COALESCE(SUM(carton_id = ?), 0) AS ce_carton FROM controles_mobile
     WHERE palette_cosses_id = ? AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite', 'inconnu')`,
    [req.cartonReception?.id ?? 0, p.id]
  );
  const cosses = Number(n) + 1;
  const nbCartons = Number(cartons) + (req.cartonReception && !Number(ce_carton) ? 1 : 0);
  if (p.complement) {
    // palette du magasin descendue : on compte les cartons de cet import ajoutés
    const [[{ ajoutes }]] = await connexion.query(
      "SELECT COUNT(*) AS ajoutes FROM controles_mobile WHERE palette_cosses_id = ? AND import_id = ? AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite', 'inconnu')",
      [p.id, p.descendue_import]
    );
    const k = Number(ajoutes) + 1;
    reponse.palette_cosses = { id: p.id, numero: p.numero, famille: 'connecteur', complement: true, emplacement: p.emplacement, ajoutes: k };
    reponse.message = d.message = `${d.message} ${avecNumeros(`Ajouté à la palette de ${p.emplacement}`)} : ${k} carton${k > 1 ? 's' : ''} ajouté${k > 1 ? 's' : ''}.`;
    return p.id;
  }
  if (p.famille === 'connecteur') {
    reponse.palette_cosses = { id: p.id, numero: p.numero, famille: 'connecteur', cosses, cartons: cosses };
    reponse.message = d.message = `${d.message} Palette n° ${p.numero}${p.nouvelle ? ' ouverte' : ''} : ${cosses} carton${cosses > 1 ? 's' : ''} de connecteurs.`;
    return p.id;
  }
  reponse.palette_cosses = { id: p.id, numero: p.numero, cosses, cartons: nbCartons };
  reponse.message = d.message = `${d.message} Palette n° ${p.numero}${p.nouvelle ? ' ouverte' : ''} : ${cosses} cosse${cosses > 1 ? 's' : ''}.`;
  return p.id;
}

// Enregistre le contrôle et renvoie la réponse pour le téléphone
async function enregistrer(connexion, req, controle, resultat, donnees) {
  const { d, reponse } = reponseControle(req, controle, resultat, donnees);
  const cartonId = (await rattacherAuCarton(connexion, req, controle, resultat, d, reponse)) ?? d.carton_id ?? null;
  const paletteId = (await rattacherALaPalette(connexion, req, controle, resultat, d, reponse)) ?? d.palette_cosses_id ?? null;
  await connexion.query(
    `INSERT INTO controles_mobile
       (uuid, controle, resultat, reference, lot, ticket, quantite_ticket, pieces, quantite_attendue, ecart, reception_id, import_id,
        preparation_id, palette_id, carton_id, palette_cosses_id, emplacement_prevu, emplacement_scanne, saisie_manuelle, qr_brut, message, reponse, utilisateur_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.body.uuid, controle, resultat, d.reference, d.lot, d.ticket, d.quantite_ticket, d.pieces, d.quantite_attendue, d.ecart,
      d.reception_id ?? d.ligne?.id ?? null, d.import_id ?? d.ligne?.import_id ?? null, d.preparation_id, d.palette_id, cartonId, paletteId, texteEmplacements(d.emplacements_prevus), d.emplacement_scanne,
      req.body.saisie_manuelle ? 1 : 0, String(req.body.qr ?? '').slice(0, 500), d.message.slice(0, 255),
      JSON.stringify(reponse), req.utilisateur.id,
    ]
  );
  return reponse;
}

// Exécute une opération dans une transaction, sous le verrou du stock, avec rejeu par uuid
function operation(controle, traitement) {
  return async (req, res, next) => {
    const uuid = String(req.body?.uuid ?? '');
    if (!UUID.test(uuid)) return res.status(400).json({ message: "Identifiant d'opération (uuid) manquant ou invalide" });
    const connexion = await db.getConnection();
    try {
      await verrouillerStock(connexion);
      await connexion.beginTransaction();
      const [[deja]] = await connexion.query('SELECT reponse, controle FROM controles_mobile WHERE uuid = ?', [uuid]);
      if (deja) {
        await connexion.rollback();
        if (deja.controle !== controle) return res.status(409).json({ message: 'Cet identifiant a déjà servi pour un autre contrôle' });
        return res.json({ ...JSON.parse(deja.reponse), rejoue: true });
      }
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

// Réception d'un colis (ticket fournisseur : un ticket = un colis = un produit).
// Les colis d'un lot sont comptés par rapport à la quantité de la ligne d'import.
async function receptionColis(connexion, req, ticket, lignes, base, palette = null) {
  const { reference, lot, colis } = ticket;
  const nomLot = `${lot}${ticket.suffixe ? '-' + ticket.suffixe : ''}`;
  const [[deja]] = await connexion.query(
    `SELECT reception_id FROM controles_mobile
     WHERE ticket = ? AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite') LIMIT 1`,
    [ticket.cle]
  );
  if (deja) {
    return enregistrer(connexion, req, 'reception', 'deja_traite', {
      ...base, ligne: lignes.find((l) => l.id === deja.reception_id) ?? lignes[0],
      message: `Le colis n° ${colis} de ${reference} lot ${nomLot} a déjà été reçu : pas de deuxième réception.`,
    });
  }
  const [comptes] = await connexion.query(
    `SELECT reception_id, COUNT(*) AS n FROM controles_mobile
     WHERE reception_id IN (?) AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite')
     GROUP BY reception_id`,
    [lignes.map((l) => l.id)]
  );
  const recus = new Map(comptes.map((c) => [c.reception_id, Number(c.n)]));
  const extraColis = (n, attendue) => ({
    colis: { numero: colis, confection: ticket.confection, recus: n, attendus: attendue },
    ...(base.resume ? { pieces: base.resume } : {}),
  });
  // Import résumé : le compteur de pièces de la référence, à la suite du message
  const suite = base.resume ? ` ${texteResume(base.resume)}` : '';

  // La ligne la plus ancienne qui attend encore des colis
  const ligne = lignes.find((l) => (recus.get(l.id) ?? 0) < l.attendue);
  if (ligne && palette) {
    // Palette de réception : des bobines d'une seule taille (6 petites, 2 moyennes ou 1 grande au maximum)
    // ou des cosses (10 au maximum, références mélangées) ; jamais des bobines et des cosses ensemble
    const cap = R.capacite(ligne);
    const typeSurPalette = typePalette(palette);
    const contenu = ligne.type === 'cosse' ? 'cosses plates' : R.LIBELLE_TAILLE[ligne.taille_bobine];
    if (typeSurPalette && typeSurPalette !== ligne.type) {
      throw refus(409, `La palette ${palette.numero} contient des ${typeSurPalette === 'cosse' ? 'cosses' : 'bobines'} : une palette ne mélange pas bobines et cosses. Terminez-la, puis ouvrez une nouvelle palette pour cette ${ligne.type}.`);
    }
    if (ligne.type === 'bobine' && palette.taille && palette.taille !== ligne.taille_bobine) {
      throw refus(409, `La palette ${palette.numero} contient des ${R.LIBELLE_TAILLE[palette.taille]} : une palette ne mélange pas les tailles. Terminez-la, puis ouvrez une nouvelle palette pour cette bobine.`);
    }
    const [[{ n: surPalette }]] = await connexion.query(
      "SELECT COUNT(*) AS n FROM controles_mobile WHERE palette_id = ? AND controle = 'reception' AND resultat = 'conforme'",
      [palette.id]
    );
    if (surPalette >= cap) {
      throw refus(409, `La palette ${palette.numero} est pleine (${cap} ${contenu}) : terminez-la.`);
    }
    if (!typeSurPalette) {
      await connexion.query('UPDATE palettes_reception SET type = ?, taille = ? WHERE id = ?', [ligne.type, ligne.taille_bobine ?? null, palette.id]);
    }
    const n = (recus.get(ligne.id) ?? 0) + 1;
    const k = Number(surPalette) + 1;
    return enregistrer(connexion, req, 'reception', 'conforme', {
      ...base, ligne, quantite_attendue: ligne.attendue, palette_id: palette.id,
      extra: {
        ...extraColis(n, ligne.attendue),
        palette: { id: palette.id, numero: palette.numero, type: ligne.type, taille: ligne.taille_bobine ?? null, n: k, capacite: cap, pleine: k >= cap },
      },
      message: `Colis n° ${colis} conforme${base.resume ? ` (+${nombre(base.resume.pieces)} pièces)` : ''} : palette ${palette.numero} (${k}/${cap})${k >= cap ? ', palette pleine : terminez-la' : ''}.${suite}`,
    });
  }
  if (ligne && base.separee) {
    // Réception séparée : on contrôle seulement ; le rangement viendra après la validation de la réception
    const n = (recus.get(ligne.id) ?? 0) + 1;
    return enregistrer(connexion, req, 'reception', 'conforme', {
      ...base, ligne, quantite_attendue: ligne.attendue, extra: extraColis(n, ligne.attendue),
      message: base.resume
        ? `Colis n° ${colis} conforme (+${nombre(base.resume.pieces)} pièces).${suite}`
        : `Colis n° ${colis} conforme : ${n}/${ligne.attendue} reçu(s) pour ${reference} lot ${nomLot}.`,
    });
  }
  if (ligne) {
    const n = (recus.get(ligne.id) ?? 0) + 1;
    const emplacements = await emplacementsPrevus(connexion, ligne);
    return enregistrer(connexion, req, 'reception', 'conforme', {
      ...base, ligne, quantite_attendue: ligne.attendue, emplacements_prevus: emplacements, extra: extraColis(n, ligne.attendue),
      message: base.resume
        ? `Colis n° ${colis} conforme (+${nombre(base.resume.pieces)} pièces).${suite} Rangez-le en ${texteEmplacements(emplacements) ?? 'zone tampon'}.`
        : `Colis n° ${colis} conforme : ${n}/${ligne.attendue} reçu(s) pour ce lot. Rangez-le en ${texteEmplacements(emplacements) ?? 'zone tampon'}.`,
    });
  }
  // Tous les colis annoncés sont déjà reçus : colis en trop
  const attendus = lignes.reduce((t, l) => t + l.attendue, 0);
  const total = lignes.reduce((t, l) => t + (recus.get(l.id) ?? 0), 0) + 1;
  return enregistrer(connexion, req, 'reception', 'ecart_quantite', {
    ...base, ligne: lignes[lignes.length - 1], quantite_ticket: total, quantite_attendue: attendus, ecart: total - attendus,
    extra: extraColis(total, attendus),
    message: base.separee
      ? `Colis en trop : l'import annonce ${attendus} produit(s) pour ${reference} lot ${nomLot}, tous déjà reçus. Le colis n° ${colis} entre au stock ; une réclamation sera créée.`
      : `Colis en trop : l'import annonce ${attendus} produit(s) pour ${reference} lot ${nomLot}, tous déjà reçus. Mettez le colis n° ${colis} de côté (hors stock), il sera signalé au chef.`,
  });
}

// « AK 15317766 : 40 500 / 45 000 pièces (9 colis). »
function texteResume(r) {
  const etat = r.recues - r.attendues > r.tolerance
    ? ' : plus que prévu, ce sera signalé au chef'
    : r.recues >= r.attendues - r.tolerance ? ' : référence complète' : '';
  return `${r.reference} : ${nombre(r.recues)} / ${nombre(r.attendues)} pièces (${r.colis} colis)${etat}.`;
}

// Import résumé (fichier de l'Italie : référence + total de pièces, sans lot ni colis).
// Le ticket doit porter son n° de colis et ses pièces ; la référence doit être annoncée dans l'import.
// Le 1er colis d'un lot crée la ligne référence + lot de l'import, les suivants l'augmentent d'un colis :
// la réception continue ensuite comme pour un import détaillé (palette, emplacement…).
// Renvoie { resume } (compteur de la référence, ce colis compris), { reponse } (refus enregistré) ou {} (hors import).
async function colisImportResume(connexion, req, imp, ticket, base) {
  const { reference, lot, colis } = ticket;
  if (!ticket.cle || !ticket.confection) {
    throw refus(409, 'Import par référence : scannez le QR du bas du ticket vert (il porte le n° du colis et sa quantité de pièces).');
  }
  const [[attendu]] = await connexion.query(
    'SELECT reference, type, taille_bobine, type_cosse, pieces FROM imports_attendus WHERE import_id = ? AND reference = ?',
    [imp.id, reference]
  );
  if (!attendu) return {}; // pas annoncée : la suite la note « hors import »
  const [[deja]] = await connexion.query(
    "SELECT reception_id FROM controles_mobile WHERE ticket = ? AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite') LIMIT 1",
    [ticket.cle]
  );
  if (deja) {
    return {
      reponse: await enregistrer(connexion, req, 'reception', 'deja_traite', {
        ...base, reception_id: deja.reception_id,
        message: `Le colis n° ${colis} de ${reference} lot ${lot}${ticket.suffixe ? '-' + ticket.suffixe : ''} a déjà été reçu : pas de deuxième réception.`,
      }),
    };
  }
  const [[ligne]] = await connexion.query(
    'SELECT id FROM receptions WHERE import_id = ? AND reference = ? AND lot = ? FOR UPDATE',
    [imp.id, reference, lot]
  );
  if (ligne) {
    await connexion.query('UPDATE receptions SET quantite = quantite + 1 WHERE id = ?', [ligne.id]);
  } else {
    await connexion.query(
      `INSERT INTO receptions (import_id, type, taille_bobine, type_cosse, reference, lot, date_reception, quantite, utilisateur_id)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), 1, ?)`,
      [imp.id, attendu.type, attendu.taille_bobine, attendu.type_cosse, attendu.reference, lot, req.utilisateur.id]
    );
  }
  const [[avant]] = await connexion.query(
    `SELECT COALESCE(SUM(c.pieces), 0) AS pieces, COUNT(*) AS colis
     FROM controles_mobile c JOIN receptions r ON r.id = c.reception_id
     WHERE r.import_id = ? AND r.reference = ? AND c.controle = 'reception' AND c.resultat = 'conforme'`,
    [imp.id, reference]
  );
  const pct = await tolerancePieces(connexion);
  return {
    resume: {
      reference: attendu.reference,
      pieces: ticket.confection,
      recues: Number(avant.pieces) + ticket.confection,
      attendues: attendu.pieces,
      colis: Number(avant.colis) + 1,
      tolerance: Math.floor((attendu.pieces * pct) / 100),
    },
  };
}

// Type du produit de ce ticket dans cet import (ligne d'import, total annoncé, sinon catalogue Articles)
async function typeDuTicket(connexion, imp, ticket) {
  const [[ligne]] = imp.mode === 'resume'
    ? await connexion.query('SELECT type, type_cosse FROM imports_attendus WHERE import_id = ? AND reference = ?', [imp.id, ticket.reference])
    : await connexion.query(
        'SELECT type, type_cosse FROM receptions WHERE import_id = ? AND UPPER(TRIM(reference)) = ? AND TRIM(lot) IN (?) LIMIT 1',
        [imp.id, ticket.reference, lotsDuTicket(ticket)]
      );
  return ligne ?? (await typesDuCatalogue(connexion, [ticket.reference])).get(ticket.reference) ?? null;
}

// Mode choisi sur le téléphone pour les cosses plates (body.emballage), gardé jusqu'au prochain changement :
//   'carton' : la cosse entre dans le carton ouvert du magasinier, ouvert tout seul s'il n'y en a pas ;
//   'separe' : la cosse est reçue séparée.
// Palette de cosses : un carton est toujours sur une palette (en mode Cartons, la palette s'ouvre seule si le
// magasinier n'en a pas d'ouverte). Une palette ne porte que des cartons : une cosse séparée n'y va jamais.
// Pas encore de mode : le téléphone demande « Cartons ou Séparées ? » (refus emballage_requis), puis renvoie le scan.
// Cosses plates et axiales peuvent aller en carton ; bobines et connecteurs jamais : null.
async function cartonDuScan(connexion, req, imp, ticket) {
  if (req.urgence) return null; // sortie urgente : le colis part tout de suite, ni carton ni palette
  const t = await typeDuTicket(connexion, imp, ticket);
  if (!t || t.type !== 'cosse') return null; // cosses plates et axiales
  const mode = req.body.emballage;
  if (mode !== 'carton' && mode !== 'separe') {
    throw Object.assign(refus(409, 'Ces cosses arrivent-elles en cartons ou séparées ? Choisissez, puis le scan continue.'), { codeMetier: 'emballage_requis' });
  }
  // Séparées : sans palette (une palette ne porte que des cartons ; décision du 2026-11-12). La cosse séparée
  // recevra sa place aux niveaux des cosses séparées (1-2, et 1-3 du bloc E).
  if (mode === 'separe') return null;
  if (!ticket.cle) throw refus(409, 'Scannez le QR du bas du ticket vert de la cosse (il porte le n° du colis).');
  const lot = C.lotComplet(ticket);
  let [[c]] = await connexion.query(
    "SELECT * FROM cartons WHERE import_id = ? AND statut = 'ouvert' AND ouvert_par = ? ORDER BY numero DESC LIMIT 1 FOR UPDATE",
    [imp.id, req.utilisateur.id]
  );
  // la palette du carton ouvert, sinon la palette ouverte du magasinier, sinon une nouvelle palette
  if (c?.palette_id) {
    [[req.paletteReception]] = await connexion.query(`${P.SELECT_PALETTE} WHERE p.id = ? AND p.statut = 'ouverte' FOR UPDATE`, [c.palette_id]);
  }
  if (!req.paletteReception) {
    req.paletteReception = await P.paletteOuverte(connexion, imp.id, req.utilisateur.id, true, 'cosse');
    if (c) await connexion.query('UPDATE cartons SET palette_id = ? WHERE id = ?', [req.paletteReception.id, c.id]);
  }
  req.paletteReception = await P.verifierFamille(connexion, req.paletteReception, 'cosse');
  if (!c) {
    // mode Cartons, aucun carton ouvert : le carton suivant s'ouvre avec cette cosse, sur la palette
    const [[{ suivant }]] = await connexion.query('SELECT COALESCE(MAX(numero), 0) + 1 AS suivant FROM cartons WHERE import_id = ? FOR UPDATE', [imp.id]);
    const [r] = await connexion.query('INSERT INTO cartons (import_id, palette_id, numero, ouvert_par) VALUES (?, ?, ?, ?)', [imp.id, req.paletteReception.id, suivant, req.utilisateur.id]);
    await connexion.query("UPDATE imports SET emballage = 'carton' WHERE id = ?", [imp.id]);
    [[c]] = await connexion.query('SELECT * FROM cartons WHERE id = ?', [r.insertId]);
  }
  if (c.reference) {
    const [[{ n }]] = await connexion.query(
      "SELECT COUNT(*) AS n FROM controles_mobile WHERE carton_id = ? AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite', 'inconnu')",
      [c.id]
    );
    if (!Number(n)) {
      // toutes ses cosses ont été retirées : le carton accepte une autre référence
      await connexion.query('UPDATE cartons SET reference = NULL, lot = NULL WHERE id = ?', [c.id]);
      c = { ...c, reference: null, lot: null };
    } else if (c.reference.toUpperCase() !== ticket.reference || c.lot !== lot) {
      throw refus(409, `Le carton n° ${c.numero} contient ${c.reference} lot ${c.lot} : un carton n'a qu'une référence et un lot. Touchez « Terminer le carton » avant de scanner ${ticket.reference} lot ${lot}.`);
    }
  }
  return { ...c, lotComplet: lot };
}

// Connecteurs (migration 041) : chaque carton (son ticket vert) va sur la palette de connecteurs ouverte du magasinier,
// ouverte toute seule au 1er carton ; ou, s'il a descendu une palette du magasin pour la compléter, sur celle-ci.
// Jamais de cosses et de connecteurs sur la même palette. Renvoie la palette, ou null (ce n'est pas un connecteur).
async function paletteConnecteur(connexion, req, imp, ticket) {
  if (req.urgence) return null; // sortie urgente : le colis part tout de suite
  const t = await typeDuTicket(connexion, imp, ticket);
  if (t?.type !== 'connecteur') return null;
  if (!ticket.cle) throw refus(409, 'Scannez le QR du bas du ticket vert du carton (il porte le n° du colis).');
  const descendue = await P.paletteDescendue(connexion, req.utilisateur.id, true);
  if (descendue) {
    if (descendue.descendue_import !== imp.id) throw refus(409, `Remettez d'abord la palette descendue en ${descendue.emplacement} (elle est complétée pour un autre import).`);
    return { ...descendue, complement: true };
  }
  const p = await P.paletteOuverte(connexion, imp.id, req.utilisateur.id, true, 'connecteur');
  return P.verifierFamille(connexion, p, 'connecteur');
}

// ---------- Contrôle 1 : réception du ticket ----------
// POST /api/mobile/reception  { uuid, qr, saisie_manuelle? }
// import_id (facultatif) = import en cours de réception choisi sur le mobile : les colis sont
// rapprochés de cet import ; un produit absent de l'import est noté « hors import » pour lui.
// req.urgence (sortie urgente, routes/mobile-urgence.js) : le colis se contrôle de la même façon, mais sans
// carton ni palette, et sans attendre la réception des imports plus anciens.
router.post('/reception', operation('reception', controleReception));

async function controleReception(connexion, req) {
  const importChoisi = Number(req.body.import_id) > 0 ? Number(req.body.import_id) : null;
  let imp = null;
  if (importChoisi) {
    [[imp]] = await connexion.query(
      'SELECT id, statut, mode, reception, numero_livraison FROM imports WHERE id = ? FOR UPDATE',
      [importChoisi]
    );
    if (!imp) throw Object.assign(new Error('Import introuvable'), { status: 404 });
    if (imp.statut !== 'en_attente' || imp.reception === 'terminee') {
      return enregistrer(connexion, req, 'reception', 'deja_traite', {
        import_id: imp.id,
        message: `La réception de l'import ${imp.numero_livraison ?? 'n° ' + imp.id} est terminée : choisissez un autre import.`,
      });
    }
    const avant = req.urgence ? null : await receptionPrecedenteNonTerminee(connexion, imp.id);
    if (avant) throw refus(409, messageOrdreReception(avant));
  }
  const ticket = lireTicket(req.body.qr);
  if (!ticket) {
    return enregistrer(connexion, req, 'reception', 'ticket_illisible', { import_id: importChoisi, message: messageIllisible(req.body.qr) });
  }
  const { reference, lot, quantite } = ticket;
  const base = { reference, lot, quantite_ticket: quantite, pieces: ticket.confection ?? null, ticket: ticket.cle, import_id: importChoisi };
  // Réception séparée (par défaut) : contrôle des produits, lots et écarts seulement, sans palette ni emplacement
  base.separee = (await modeReception(connexion)) === 'separee';
  // Cosses plates d'un import en cartons : elles entrent dans le carton ouvert du magasinier
  if (imp && base.separee) req.cartonReception = await cartonDuScan(connexion, req, imp, ticket);
  if (imp && base.separee && !req.cartonReception) {
    const pc = await paletteConnecteur(connexion, req, imp, ticket);
    if (pc) req.paletteReception = pc;
  }
  if (req.cartonReception && ticket.cle) {
    // Cosse déjà reçue séparée dans cet import : on propose de la mettre dans le carton ouvert (sans la recompter)
    const [[separee]] = await connexion.query(
      `SELECT id FROM controles_mobile
       WHERE ticket = ? AND controle = 'reception' AND carton_id IS NULL AND import_id = ?
         AND resultat IN ('conforme', 'ecart_quantite', 'inconnu') LIMIT 1`,
      [ticket.cle, imp.id]
    );
    if (separee) {
      const k = req.cartonReception;
      req.cartonReception = null; // ce scan n'entre pas dans le carton : c'est une proposition
      return enregistrer(connexion, req, 'reception', 'deja_traite', {
        ...base,
        extra: { proposition_carton: { controle_id: separee.id, carton_id: k.id, numero: k.numero } },
        message: `Cette cosse (colis n° ${ticket.colis}) est déjà reçue séparée : touchez « Mettre dans le carton ${k.numero} » si elle fait partie de ce carton.`,
      });
    }
  }
  if (imp?.mode === 'resume') {
    // Import résumé : la ligne référence + lot naît (ou grandit) avec ce colis
    const pret = await colisImportResume(connexion, req, imp, ticket, base);
    if (pret.reponse) return pret.reponse;
    base.resume = pret.resume;
  }
  const toutes = (await lignesDuTicket(connexion, reference, lotsDuTicket(ticket))).filter((l) => l.attendue > 0);
  const lignes = importChoisi ? toutes.filter((l) => l.import_id === importChoisi) : toutes;

  // 1er colis de l'import : la réception est en cours (visible sur le web)
  const importRecu = importChoisi ?? lignes[0]?.import_id;
  if (importRecu) {
    await connexion.query(
      "UPDATE imports SET reception = 'en_cours', reception_debut = NOW() WHERE id = ? AND reception = 'non_commencee' AND statut = 'en_attente'",
      [importRecu]
    );
  }
  if (!lignes.length) {
    const ailleurs = importChoisi && toutes.find((l) => l.statut_import === 'en_attente');
    return enregistrer(connexion, req, 'reception', 'inconnu', {
      ...base,
      // colis d'un autre import : pas un écart de celui-ci (il sera reçu avec le sien)
      import_id: ailleurs ? null : importChoisi,
      message: ailleurs
        ? `${reference} lot ${lot} appartient à l'import ${ailleurs.numero_livraison ?? 'n° ' + ailleurs.import_id}, pas à celui-ci : mettez ce colis de côté pour sa réception.`
        : importChoisi && base.separee
          ? `${reference} lot ${lot} n'est pas dans cet import : une réclamation « hors import » sera créée et il entrera au stock (si la référence est au catalogue Articles).`
          : importChoisi
          ? `${reference} lot ${lot} n'est pas dans cet import : mettez ce colis de côté. Il sera signalé au chef (hors import).`
          : `${reference} lot ${lot} n'existe dans aucun import : rangement bloqué. Prévenez le responsable.`,
    });
  }
  // Bobines et cosses plates d'un import : reçues palette par palette (ticket du colis obligatoire).
  // Les cosses axiales (petites) se reçoivent une par une, sans palette, comme les connecteurs.
  if (importChoisi && !base.separee && !req.urgence && TYPES_PALETTE.includes(lignes[0].type) && !R.estAxiale(lignes[0])) {
    const quoi = lignes[0].type === 'cosse' ? 'cosse' : 'bobine';
    if (!ticket.cle) throw refus(409, `Ce ticket n'a pas de n° de colis : scannez le QR du bas du ticket vert de la ${quoi}.`);
    const paletteId = Number(req.body.palette_id) > 0 ? Number(req.body.palette_id) : null;
    if (!paletteId) throw refus(409, `Les ${quoi}s se reçoivent palette par palette : appuyez sur « Nouvelle palette », puis scannez les ${quoi}s de la palette.`);
    const [[palette]] = await connexion.query('SELECT * FROM palettes_reception WHERE id = ? FOR UPDATE', [paletteId]);
    if (!palette || palette.import_id !== importChoisi) throw refus(404, 'Palette introuvable pour cet import');
    if (palette.statut !== 'ouverte') throw refus(409, `La palette ${palette.numero} est terminée : rouvrez-la ou ouvrez une nouvelle palette.`);
    return receptionColis(connexion, req, ticket, lignes, base, palette);
  }
  if (ticket.cle) return receptionColis(connexion, req, ticket, lignes, base);
  const aRecevoir = lignes.filter((l) => !l.recue);
  if (!aRecevoir.length) {
    return enregistrer(connexion, req, 'reception', 'deja_traite', {
      ...base, ligne: lignes[lignes.length - 1],
      message: `${reference} lot ${lot} a déjà été reçu : pas de deuxième réception.`,
    });
  }
  // Plusieurs lignes possibles (même lot envoyé en plusieurs fois, cartons identiques) :
  // d'abord celle dont la quantité correspond, sinon la plus ancienne
  const ligne = aRecevoir.find((l) => l.attendue === quantite) ?? aRecevoir[0];
  const emplacements = base.separee ? [] : await emplacementsPrevus(connexion, ligne);
  const ecart = quantite - ligne.attendue;
  const donnees = { ...base, ligne, quantite_attendue: ligne.attendue, ecart, emplacements_prevus: emplacements };
  if (ecart === 0) {
    return enregistrer(connexion, req, 'reception', 'conforme', {
      ...donnees,
      message: base.separee
        ? `Quantité conforme (${quantite}) pour ${reference} lot ${lot}.`
        : `Quantité conforme (${quantite}). Rangez-le en ${texteEmplacements(emplacements) ?? 'zone tampon'}.`,
    });
  }
  return enregistrer(connexion, req, 'reception', 'ecart_quantite', {
    ...donnees,
    message: `Écart de ${ecart > 0 ? '+' : ''}${ecart} : ticket ${quantite}, import ${ligne.attendue}. L'écart est enregistré.`,
  });
}

// ---------- Contrôle 2 : rangement ----------
// Sur le téléphone : 1) ticket du produit → l'application indique l'emplacement où aller,
// 2) étiquette de l'emplacement → contrôle (POST /rangement), comme pour l'export.

// Vérifications du ticket à ranger, communes à la suggestion et au contrôle.
// Renvoie { refus: [resultat, donnees] } ou { base, aRanger } (lignes d'import où ranger ce produit).
async function ticketARanger(connexion, ticket, code = null) {
  const { reference, lot, quantite } = ticket;
  const base = { reference, lot, quantite_ticket: quantite, emplacement_scanne: code, ticket: ticket.cle };
  const lignes = await lignesDuTicket(connexion, reference, lotsDuTicket(ticket));
  if (!lignes.length) {
    return { refus: ['inconnu', { ...base, message: `${reference} lot ${lot} n'existe dans aucun import : rangement bloqué.` }] };
  }
  if (ticket.cle) {
    // Colis : il doit avoir été reçu, et n'est rangé qu'une fois
    const [[recu]] = await connexion.query(
      `SELECT c.reception_id, c.carton_id, c.palette_cosses_id, ca.numero AS carton FROM controles_mobile c LEFT JOIN cartons ca ON ca.id = c.carton_id
       WHERE c.ticket = ? AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite') ORDER BY c.id LIMIT 1`,
      [ticket.cle]
    );
    // cosse d'une palette (dans un carton ou séparée) : c'est toute la palette qui se range
    if (recu?.palette_cosses_id) {
      return { palette: { id: recu.palette_cosses_id, scanne: { reference, lot, ticket: ticket.cle, carton_id: recu.carton_id } } };
    }
    if (recu?.carton_id) {
      return { refus: ['carton', {
        ...base, ligne: lignes.find((l) => l.id === recu.reception_id) ?? lignes[0],
        message: `Cette cosse est dans le carton n° ${recu.carton} : rangez le carton entier, en scannant l'étiquette du carton puis l'emplacement.`,
      }] };
    }
    if (!recu) {
      return { refus: ['non_recu', {
        ...base, ligne: lignes[0],
        message: `Le colis n° ${ticket.colis} n'est pas passé par la réception : scannez d'abord son ticket dans « Réception ».`,
      }] };
    }
    const [[range]] = await connexion.query(
      "SELECT emplacement_scanne FROM controles_mobile WHERE ticket = ? AND controle = 'rangement' AND resultat = 'bon_emplacement' LIMIT 1",
      [ticket.cle]
    );
    if (range) {
      return { refus: ['deja_traite', {
        ...base, ligne: lignes.find((l) => l.id === recu.reception_id) ?? lignes[0],
        message: `Le colis n° ${ticket.colis} est déjà rangé${range.emplacement_scanne ? ' en ' + range.emplacement_scanne : ''} : pas de double rangement.`,
      }] };
    }
    const aRanger = lignes.filter((l) => l.id === recu.reception_id);
    return { base, aRanger: aRanger.length ? aRanger : lignes };
  }
  const recues = lignes.filter((l) => l.recue);
  if (!recues.length) {
    return { refus: ['non_recu', {
      ...base, ligne: lignes[0],
      message: "Ce produit n'est pas passé par la réception : scannez d'abord son ticket dans « Réception ».",
    }] };
  }
  const aRanger = recues.filter((l) => !l.rangee);
  if (!aRanger.length) {
    return { refus: ['deja_traite', {
      ...base, ligne: recues[recues.length - 1],
      message: `${reference} lot ${lot} est déjà rangé : pas de double rangement.`,
    }] };
  }
  return { base, aRanger };
}

// Emplacement où poser ce produit : le premier emplacement prévu qui n'a pas encore reçu
// tous ses colis (ex. 10 petites bobines → D000 ×6 puis D001 ×4)
async function emplacementSuggere(connexion, ligne, prevus) {
  const liste = prevus.filter((p) => p.code).map((p) => ({ ...p, ranges: p.ranges ?? 0 }));
  const cible = liste.find((p) => p.ranges < p.quantite);
  if (!cible) return null;
  const niveau = R.lireCode(cible.code)?.niveau ?? null;
  return { ...cible, niveau, tampon: R.estTampon(cible.code), elevateur: niveau >= 4 };
}

// POST /api/mobile/rangement/suggestion  { qr }
// 1re étape : ticket scanné → emplacement où aller. Rien n'est enregistré : le contrôle se fait
// au scan de l'emplacement (POST /rangement).
router.post('/rangement/suggestion', async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    await connexion.beginTransaction(); // attribution éventuelle d'un emplacement au colis
    const repondre = (resultat, donnees) => res.json(reponseControle(req, 'rangement', resultat, donnees).reponse);
    const etiquette = C.lireEtiquetteCarton(req.body?.qr);
    if (etiquette) {
      const e = await paletteDeLEtiquette(connexion, etiquette);
      if (e.refus) return repondre(...e.refus);
      return repondre(...(await suggestionPalette(connexion, e.palette.id, e.palette.scanne)));
    }
    const ticket = lireTicket(req.body?.qr);
    if (!ticket) return repondre('ticket_illisible', { message: messageIllisible(req.body?.qr) });
    const t = await ticketARanger(connexion, ticket);
    if (t.refus) return repondre(...t.refus);
    if (t.palette) return repondre(...(await suggestionPalette(connexion, t.palette.id, t.palette.scanne)));
    const ligne = t.aRanger[0];
    const prevus = await emplacementsPrevus(connexion, ligne);
    const donnees = { ...t.base, ligne, quantite_attendue: ligne.attendue, emplacements_prevus: prevus };
    const affPalette = ticket.cle ? await affectationPalette(connexion, ticket.cle) : null;
    if (affPalette) {
      const niveau = R.lireCode(affPalette.emplacement)?.niveau ?? null;
      return repondre('a_ranger', {
        ...donnees, emplacements_prevus: [{ code: affPalette.emplacement, quantite: 1 }],
        extra: { suggestion: { code: affPalette.emplacement, quantite: 1, ranges: 0, niveau, tampon: R.estTampon(affPalette.emplacement), elevateur: niveau >= 4 } },
        message: `Colis n° ${ticket.colis} (palette ${affPalette.palette}) : allez en ${affPalette.emplacement} et scannez l'étiquette de l'emplacement.`,
      });
    }
    if (ligne.statut_import !== 'ajoute') {
      // Réception en cours : un colis (ticket avec n° de colis) se range tout de suite ; un ticket de lot attend la validation
      if (!ticket.cle) {
        return repondre('import_en_attente', {
          ...donnees,
          message: `L'import ${ligne.numero_livraison ?? 'n° ' + ligne.import_id} n'est pas encore ajouté au stock : rangement pas encore possible. Demandez au responsable.`,
        });
      }
      const code = await placeAvantValidation(connexion, ligne.id);
      if (!code) return repondre('sans_emplacement', { ...donnees, message: `Aucune place libre pour le colis n° ${ticket.colis} : appelez le chef.` });
      const niveau = R.lireCode(code)?.niveau ?? null;
      return repondre('a_ranger', {
        ...donnees, emplacements_prevus: [{ code, quantite: 1 }],
        extra: { suggestion: { code, quantite: 1, ranges: 0, niveau, tampon: R.estTampon(code), elevateur: niveau >= 4 } },
        message: `Colis n° ${ticket.colis} : allez en ${code}${niveau >= 4 ? ' (élévateur)' : ''} et scannez l'étiquette de l'emplacement.`,
      });
    }
    // Colis : son emplacement imposé
    if (ticket.cle) {
      const aff = await affectationDuColis(connexion, ligne.id, ticket.cle);
      if (!aff) {
        return repondre('sans_emplacement', { ...donnees, message: `Aucun emplacement n'est attribué au colis n° ${ticket.colis} : appelez le chef.` });
      }
      const place = prevus.find((p) => p.code === aff.emplacement) ?? { code: aff.emplacement, quantite: 1, ranges: 0 };
      const niveau = R.lireCode(aff.emplacement)?.niveau ?? null;
      return repondre('a_ranger', {
        ...donnees, emplacements_prevus: [{ code: aff.emplacement, quantite: 1 }],
        extra: { suggestion: { ...place, code: aff.emplacement, niveau, tampon: R.estTampon(aff.emplacement), elevateur: niveau >= 4 } },
        message: `Colis n° ${ticket.colis} : allez en ${aff.emplacement}${niveau >= 4 ? ' (élévateur)' : ''} et scannez l'étiquette de l'emplacement.`,
      });
    }
    const cible = await emplacementSuggere(connexion, ligne, prevus);
    if (!cible && prevus.length && prevus.every((p) => p.code && (p.ranges ?? 0) >= p.quantite)) {
      return repondre('deja_traite', { ...donnees, message: `${ticket.reference} lot ${ticket.lot} est déjà entièrement rangé : pas de double rangement.` });
    }
    if (!cible) {
      return repondre('sans_emplacement', {
        ...donnees, message: "L'application n'a prévu aucun emplacement pour ce produit. Demandez au responsable de l'affecter dans Gestion de stock.",
      });
    }
    return repondre('a_ranger', {
      ...donnees, extra: { suggestion: cible },
      message: `Allez en ${cible.code}${cible.elevateur ? ' (élévateur)' : ''} et scannez l'étiquette de l'emplacement.`,
    });
  } catch (err) {
    await connexion.rollback().catch(() => {});
    next(err);
  } finally {
    await connexion.commit().catch(() => {});
    connexion.release();
  }
});

// ---------- Rangement d'une palette de cosses : l'étiquette d'un de ses cartons (ou le ticket d'une cosse), puis l'emplacement ----------
// La palette entière (cartons et cosses séparées) va seule sur un emplacement entièrement vide (cosses)
// ou une place tampon libre ; toutes ses cosses entrent alors au stock, marquées de la palette.

// Palette d'une étiquette de carton : { palette: { id, scanne } } ou { refus: [resultat, donnees] }
async function paletteDeLEtiquette(connexion, etiquette) {
  const [[carton]] = await connexion.query(`${C.SELECT_CARTON} WHERE c.date_etiquette = ?`, [etiquette.date]);
  if (!carton || String(carton.reference).toUpperCase() !== etiquette.reference) {
    return { refus: ['ticket_illisible', { message: "Étiquette de carton inconnue : réimprimez-la depuis le web (page Import)." }] };
  }
  if (!carton.palette_id) {
    return { refus: ['sans_emplacement', { reference: carton.reference, lot: carton.lot, carton_id: carton.id, message: `Le carton n° ${carton.numero} n'est sur aucune palette : appelez le chef.` }] };
  }
  return { palette: { id: carton.palette_id, scanne: { reference: carton.reference, lot: carton.lot, carton_id: carton.id, ticket: null } } };
}

// Palette prête à ranger ; sinon { refus: [resultat, donnees] }. scanne : carton ou cosse lu par le magasinier.
async function etatPalette(connexion, paletteId, scanne) {
  const [[p]] = await connexion.query(`${P.SELECT_PALETTE} WHERE p.id = ? FOR UPDATE`, [paletteId]);
  if (!p) return { refus: ['ticket_illisible', { message: 'Palette introuvable : appelez le chef.' }] };
  const vue = await P.vuePalette(connexion, p);
  const base = {
    reference: scanne?.reference ?? vue.references[0] ?? null, lot: scanne?.lot ?? null, ticket: scanne?.ticket ?? null, quantite_ticket: vue.cosses,
    carton_id: scanne?.carton_id ?? null, palette_cosses_id: p.id, extra: { palette_cosses: vue },
  };
  const nom = P.nomPalette(vue);
  const [[imp]] = await connexion.query('SELECT id, statut, numero_livraison FROM imports WHERE id = ?', [p.import_id]);
  if (p.statut === 'rangee') {
    return { refus: ['deja_traite', { ...base, message: `${nom} est déjà rangée${vue.emplacement ? ' en ' + vue.emplacement : ''} : pas de double rangement.` }] };
  }
  // Une palette terminée se range tout de suite, même si la réception de l'import continue (décision du 2026-11-27) :
  // un magasinier reçoit pendant qu'un autre range. Seule une palette encore ouverte attend.
  if (p.statut === 'ouverte') {
    return { refus: ['import_en_attente', { ...base, message: `La palette n° ${p.numero} de l'import ${imp.numero_livraison ?? 'n° ' + imp.id} est encore ouverte : touchez « Terminer la palette » sur le téléphone de réception, puis rangez-la.` }] };
  }
  if (vue.hors_stock) {
    return { refus: ['sans_emplacement', { ...base, message: `${nom} porte ${vue.hors_stock} cosse(s) d'une référence absente du catalogue Articles : ajoutez-la au catalogue, puis « Entrer au stock » sur le web (page Import).` }] };
  }
  if (!vue.cosses) return { refus: ['deja_traite', { ...base, message: `La palette n° ${p.numero} est vide.` }] };
  return { palette: p, vue, base, nom };
}

// Emplacement proposé pour la palette (suggestion, rien n'est enregistré) : [resultat, donnees]
async function suggestionPalette(connexion, paletteId, scanne) {
  const e = await etatPalette(connexion, paletteId, scanne);
  if (e.refus) return e.refus;
  const place = C.emplacementPourCarton(await occupation(connexion), await capaciteTampon(connexion));
  if (!place) return ['sans_emplacement', { ...e.base, message: `Aucun emplacement vide ni place tampon libre pour la palette n° ${e.palette.numero} : appelez le chef.` }];
  const niveau = R.lireCode(place.code)?.niveau ?? null;
  return ['a_ranger', {
    ...e.base, emplacements_prevus: [{ code: place.code, quantite: e.vue.cosses }],
    extra: { palette_cosses: e.vue, suggestion: { code: place.code, quantite: e.vue.cosses, ranges: 0, niveau, tampon: place.tampon, elevateur: niveau >= 4 } },
    message: `${e.nom} : posez toute la palette en ${place.code}${place.tampon ? ' (zone tampon : plus d’emplacement vide)' : ''}, puis scannez l'étiquette de l'emplacement.`,
  }];
}

async function rangerPalette(connexion, req, paletteId, scanne, code) {
  const e = await etatPalette(connexion, paletteId, scanne);
  if (e.refus) return enregistrer(connexion, req, 'rangement', e.refus[0], { ...e.refus[1], emplacement_scanne: code });
  const { palette, vue, base, nom } = e;
  const donnees = { ...base, emplacement_scanne: code };
  if (!R.estTampon(code) && R.typeEmplacement(code) !== 'connecteur') {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', { ...donnees, message: `Une palette de cartons de cosses se range en haut (niveaux 3 et 4, 4 et 5 du bloc E), pas en ${code}. Rien n'est enregistré.` });
  }
  const occ = await occupation(connexion, true);
  if (occ.some((l) => l.emplacement === code && Number(l.quantite) > 0)) {
    const place = C.emplacementPourCarton(occ, await capaciteTampon(connexion));
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
      ...donnees, emplacements_prevus: place ? [{ code: place.code, quantite: vue.cosses }] : [],
      message: `${code} n'est pas vide : une palette va seule sur un emplacement entièrement vide${place ? ' (ex. ' + place.code + ')' : ''}. Rien n'est enregistré.`,
    });
  }
  // Une ligne de stock par ligne d'import, marquée de la palette (et du carton s'il est seul sur cette ligne)
  const cosses = (await P.cossesDeLaPalette(connexion, palette.id)).filter((x) => x.reception_id);
  const parLigne = new Map();
  for (const x of cosses) {
    const g = parLigne.get(x.reception_id) ?? { n: 0, cartons: new Set() };
    g.n++;
    g.cartons.add(x.carton_id ?? 0);
    parLigne.set(x.reception_id, g);
  }
  for (const [receptionId, g] of parLigne) {
    const carton = g.cartons.size === 1 && !g.cartons.has(0) ? [...g.cartons][0] : null;
    await connexion.query(
      `INSERT INTO placements (reception_id, emplacement, quantite, carton_id, palette_cosses_id) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE quantite = quantite + VALUES(quantite), carton_id = VALUES(carton_id), palette_cosses_id = VALUES(palette_cosses_id)`,
      [receptionId, code, g.n, carton, palette.id]
    );
  }
  await connexion.query("UPDATE cartons SET statut = 'range', emplacement = ?, date_rangement = NOW() WHERE palette_id = ?", [code, palette.id]);
  await connexion.query("UPDATE palettes_cosses SET statut = 'rangee', emplacement = ?, date_rangee = NOW() WHERE id = ?", [code, palette.id]);
  const premiere = cosses[0];
  const reponse = await enregistrer(connexion, req, 'rangement', 'bon_emplacement', {
    ...donnees, ligne: null, reception_id: premiere.reception_id, import_id: palette.import_id, ticket: premiere.ticket,
    reference: premiere.reference, lot: premiere.lot, carton_id: premiere.carton_id,
    emplacements_prevus: [{ code, quantite: cosses.length }],
    extra: { palette_cosses: { ...(await P.vuePalette(connexion, { ...palette, statut: 'rangee', emplacement: code })) } },
    message: `${nom} rangée en ${code} : ${cosses.length} cosse${cosses.length > 1 ? 's' : ''} ajoutée${cosses.length > 1 ? 's' : ''} au stock.`,
  });
  // Un contrôle de rangement par cosse : l'avancement de l'import compte les cosses rangées
  for (const x of cosses.slice(1)) {
    await connexion.query(
      `INSERT INTO controles_mobile (uuid, controle, resultat, reference, lot, ticket, reception_id, import_id, carton_id, palette_cosses_id, emplacement_scanne, message, reponse, utilisateur_id)
       VALUES (?, 'rangement', 'bon_emplacement', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
      [crypto.randomUUID(), x.reference, x.lot, x.ticket, x.reception_id, palette.import_id, x.carton_id, palette.id, code, `Rangé avec la palette n° ${palette.numero}`, req.utilisateur.id]
    );
  }
  return reponse;
}

// Rangement d'un colis : seul son emplacement imposé est accepté ; il entre alors au stock
// Emplacement d'un colis donné par sa palette de réception (palette terminée), ou null
async function affectationPalette(connexion, ticketCle) {
  const [[a]] = await connexion.query(
    `SELECT a.*, p.numero AS palette, p.type AS type_palette, p.taille AS taille_palette FROM affectations_colis a JOIN palettes_reception p ON p.id = a.palette_id
     WHERE a.ticket = ? AND a.range_le IS NULL FOR UPDATE`,
    [ticketCle]
  );
  return a ?? null;
}

async function rangerColis(connexion, req, ticket, t, code) {
  const ligne = t.aRanger[0];
  const prevus = await emplacementsPrevus(connexion, ligne);
  const donnees = { ...t.base, ligne, quantite_attendue: ligne.attendue, emplacements_prevus: prevus };
  const affPalette = await affectationPalette(connexion, ticket.cle);
  if (affPalette) return rangerColisPalette(connexion, req, ticket, donnees, affPalette, code);
  if (ligne.statut_import !== 'ajoute') return rangerColisAvantValidation(connexion, req, ticket, donnees, ligne, code);
  const aff = await affectationDuColis(connexion, ligne.id, ticket.cle);
  if (!aff) {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
      ...donnees, message: `Aucun emplacement n'est attribué au colis n° ${ticket.colis} : appelez le chef. Rien n'est enregistré.`,
    });
  }
  const impose = [{ code: aff.emplacement, quantite: 1 }];
  if (code !== aff.emplacement) {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
      ...donnees, emplacements_prevus: impose,
      message: `Le colis n° ${ticket.colis} va en ${aff.emplacement}, pas en ${code}. Rien n'est enregistré. Appelez le chef si ${aff.emplacement} n'est pas utilisable.`,
    });
  }
  await poserQuantite(connexion, ligne.id, code, 1);
  const [maj] = await connexion.query(
    'UPDATE plans_rangement SET ranges = ranges + 1 WHERE reception_id = ? AND emplacement = ?',
    [ligne.id, code]
  );
  if (!maj.affectedRows) {
    await connexion.query('INSERT INTO plans_rangement (reception_id, emplacement, quantite, ranges) VALUES (?, ?, 1, 1)', [ligne.id, code]);
  }
  await connexion.query('UPDATE affectations_colis SET range_le = NOW() WHERE id = ?', [aff.id]);
  const [[total]] = await connexion.query(
    'SELECT COALESCE(SUM(ranges), 0) AS ranges, COALESCE(SUM(quantite), 0) AS prevus FROM plans_rangement WHERE reception_id = ?',
    [ligne.id]
  );
  const auStock = Number(total.ranges);
  const attendus = Number(total.prevus);
  return enregistrer(connexion, req, 'rangement', 'bon_emplacement', {
    ...donnees, emplacements_prevus: impose, extra: { stock: { ranges: auStock, prevus: attendus } },
    message: `${ticket.reference} lot ${ticket.lot} (colis n° ${ticket.colis}) rangé en ${code} : ajouté au stock${attendus > 1 ? ` (${auStock}/${attendus} au stock)` : ''}.`,
  });
}

// Colis rangé pendant la réception de son import : la place calculée maintenant (placeAvantValidation) est la seule
// acceptée. Le colis entre au stock tout de suite ; son affectation est marquée rangée, donc la fin de la réception
// ne le planifie pas une 2e fois (produitsImport et attribuerColis le sautent).
async function rangerColisAvantValidation(connexion, req, ticket, donnees, ligne, code) {
  const place = await placeAvantValidation(connexion, ligne.id);
  if (!place) {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', { ...donnees, message: `Aucune place libre pour le colis n° ${ticket.colis} : appelez le chef. Rien n'est enregistré.` });
  }
  const impose = [{ code: place, quantite: 1 }];
  if (code !== place) {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
      ...donnees, emplacements_prevus: impose,
      message: `Le colis n° ${ticket.colis} va en ${place}, pas en ${code}. Rien n'est enregistré.`,
    });
  }
  await poserQuantite(connexion, ligne.id, code, 1);
  await connexion.query(
    `INSERT INTO plans_rangement (reception_id, emplacement, quantite, ranges) VALUES (?, ?, 1, 1)
     ON DUPLICATE KEY UPDATE quantite = quantite + 1, ranges = ranges + 1`,
    [ligne.id, code]
  );
  await connexion.query(
    'INSERT INTO affectations_colis (reception_id, ticket, colis, emplacement, range_le) VALUES (?, ?, ?, ?, NOW())',
    [ligne.id, ticket.cle, ticket.colis, code]
  );
  return enregistrer(connexion, req, 'rangement', 'bon_emplacement', {
    ...donnees, emplacements_prevus: impose,
    message: `${ticket.reference} lot ${ticket.lot} (colis n° ${ticket.colis}) rangé en ${code} : ajouté au stock, pendant la réception de l'import.`,
  });
}

// Colis d'une palette de réception rangée colis par colis : seul son emplacement est accepté
async function rangerColisPalette(connexion, req, ticket, donnees, aff, code) {
  const impose = [{ code: aff.emplacement, quantite: 1 }];
  if (code !== aff.emplacement) {
    return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
      ...donnees, emplacements_prevus: impose, palette_id: aff.palette_id,
      message: `Le colis n° ${ticket.colis} (palette ${aff.palette}) va en ${aff.emplacement}, pas en ${code}. Rien n'est enregistré.`,
    });
  }
  await poserQuantite(connexion, aff.reception_id, code, 1);
  await connexion.query('UPDATE affectations_colis SET range_le = NOW() WHERE id = ?', [aff.id]);
  const [[{ reste }]] = await connexion.query(
    'SELECT COUNT(*) AS reste FROM affectations_colis WHERE palette_id = ? AND range_le IS NULL',
    [aff.palette_id]
  );
  if (!Number(reste)) {
    await connexion.query("UPDATE palettes_reception SET statut = 'rangee', date_rangee = NOW() WHERE id = ? AND statut = 'terminee'", [aff.palette_id]);
  }
  return enregistrer(connexion, req, 'rangement', 'bon_emplacement', {
    ...donnees, emplacements_prevus: impose, palette_id: aff.palette_id,
    extra: { palette: { id: aff.palette_id, numero: aff.palette, reste: Number(reste) } },
    message: `${ticket.reference} lot ${ticket.lot} (colis n° ${ticket.colis}) rangé en ${code} : ajouté au stock${Number(reste) ? ` (palette ${aff.palette} : encore ${nommer(typePalette({ type: aff.type_palette, taille: aff.taille_palette }), Number(reste))})` : ` (palette ${aff.palette} rangée)`}.`,
  });
}

// POST /api/mobile/rangement  { uuid, emplacement, qr, saisie_manuelle? }
// emplacement = texte lu dans le QR de l'emplacement, qr = ticket du produit
router.post('/rangement', operation('rangement', async (connexion, req) => {
  const code = lireEmplacement(req.body.emplacement);
  const ticket = lireTicket(req.body.qr);
  if (!code || !R.emplacementValide(code, await capaciteTampon(connexion))) {
    return enregistrer(connexion, req, 'rangement', 'emplacement_inconnu', {
      reference: ticket?.reference ?? null, lot: ticket?.lot ?? null, quantite_ticket: ticket?.quantite ?? null,
      emplacement_scanne: String(req.body.emplacement ?? '').trim().slice(0, 20) || null,
      message: "Ce QR ne correspond à aucun emplacement du magasin. Rescannez l'étiquette de l'emplacement.",
    });
  }
  const etiquette = C.lireEtiquetteCarton(req.body.qr);
  if (etiquette) {
    const e = await paletteDeLEtiquette(connexion, etiquette);
    if (e.refus) return enregistrer(connexion, req, 'rangement', e.refus[0], { ...e.refus[1], emplacement_scanne: code });
    return rangerPalette(connexion, req, e.palette.id, e.palette.scanne, code);
  }
  if (!ticket) {
    return enregistrer(connexion, req, 'rangement', 'ticket_illisible', {
      emplacement_scanne: code, message: messageIllisible(req.body.qr),
    });
  }
  const { reference, lot } = ticket;
  const t = await ticketARanger(connexion, ticket, code);
  if (t.refus) return enregistrer(connexion, req, 'rangement', ...t.refus);
  if (t.palette) return rangerPalette(connexion, req, t.palette.id, t.palette.scanne, code);
  if (ticket.cle) return rangerColis(connexion, req, ticket, t, code);
  // Ticket de lot (sans n° de colis) : les places du plan se remplissent dans l'ordre
  // Ligne dont l'emplacement prévu est celui scanné, sinon la plus ancienne
  let choix = null;
  for (const l of t.aRanger) {
    const prevus = await emplacementsPrevus(connexion, l);
    if (!choix) choix = { ligne: l, prevus };
    if (prevus.some((e) => e.code === code)) {
      choix = { ligne: l, prevus };
      break;
    }
  }
  const { ligne, prevus } = choix;
  const donnees = { ...t.base, ligne, quantite_attendue: ligne.attendue, emplacements_prevus: prevus };
  if (prevus.some((e) => e.code === code)) {
    if (ligne.statut_import !== 'ajoute') {
      return enregistrer(connexion, req, 'rangement', 'import_en_attente', {
        ...donnees,
        message: `Bon emplacement, mais l'import n° ${ligne.import_id} n'est pas encore ajouté au stock dans l'application web. Rien n'est enregistré : demandez au responsable de l'ajouter, puis rescannez.`,
      });
    }
    // Ticket de lot : la première place pas encore remplie, et elle seule
    const premiere = prevus.find((e) => e.code && (e.ranges ?? 0) < e.quantite);
    if (premiere && premiere.code !== code) {
      return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
        ...donnees, emplacements_prevus: [premiere],
        message: `Rangez d'abord en ${premiere.code} : ${code} n'est pas la place prévue maintenant pour ce lot. Rien n'est enregistré.`,
      });
    }
    // Place prévue : reste-t-il de la place pour ce produit ?
    const [[place]] = await connexion.query(
      'SELECT id, quantite, ranges FROM plans_rangement WHERE reception_id = ? AND emplacement = ? FOR UPDATE',
      [ligne.id, code]
    );
    if (place && place.ranges >= place.quantite) {
      const libre = prevus.find((e) => e.code !== code && (e.ranges ?? 0) < e.quantite);
      return enregistrer(connexion, req, 'rangement', 'emplacement_complet', {
        ...donnees,
        message: `${code} a déjà reçu ${place.quantite} produit(s) prévu(s) pour ce lot${libre ? ' : allez en ' + libre.code : ''}. Rien n'est enregistré.`,
      });
    }
    // Un colis = 1 produit ; un ticket de lot = tout ce qui reste prévu à cette place
    const n = ticket.cle ? 1 : place ? place.quantite - place.ranges : 0;
    if (place && n > 0) {
      await poserQuantite(connexion, ligne.id, code, n);
      await connexion.query('UPDATE plans_rangement SET ranges = ranges + ? WHERE id = ?', [n, place.id]);
    }
    const [[total]] = await connexion.query(
      'SELECT COALESCE(SUM(ranges), 0) AS ranges, COALESCE(SUM(quantite), 0) AS prevus FROM plans_rangement WHERE reception_id = ?',
      [ligne.id]
    );
    const auStock = Number(total.ranges);
    const attendus = Number(total.prevus);
    return enregistrer(connexion, req, 'rangement', 'bon_emplacement', {
      ...donnees,
      emplacements_prevus: await emplacementsPrevus(connexion, ligne),
      extra: { stock: { ranges: auStock, prevus: attendus } },
      message: `${reference} lot ${lot}${ticket.colis ? ' (colis n° ' + ticket.colis + ')' : ''} rangé en ${code} : ajouté au stock${attendus > 1 ? ` (${auStock}/${attendus} au stock)` : ''}.`,
    });
  }
  return enregistrer(connexion, req, 'rangement', 'faux_emplacement', {
    ...donnees,
    message: `Ce n'est pas son emplacement : ${code} scanné, prévu ${texteEmplacements(prevus) ?? 'non rangé'}. Rien n'est enregistré dans le stock.`,
  });
}));

// ---------- Consultation ----------
const statutLigne = (l) =>
  l.rangee ? 'rangee' : l.ecart ? 'en_ecart' : l.recue ? 'recue' : l.nb_recus > 0 ? 'en_cours' : 'a_recevoir';

// GET /api/mobile/emplacement/:code : contenu d'un emplacement
router.get('/emplacement/:code', async (req, res, next) => {
  try {
    const code = lireEmplacement(req.params.code);
    if (!code || !R.emplacementValide(code, await capaciteTampon())) {
      return res.status(404).json({ message: "Cet emplacement n'existe pas" });
    }
    const enPlace = (await lignesEnStock()).filter((l) => l.emplacement === code);
    // Colis présents : rangés ici (scan de rangement), moins ceux sortis depuis (scan d'export)
    const [scansColis] = enPlace.length
      ? await db.query(
          `SELECT reception_id, ticket, controle, emplacement_scanne FROM controles_mobile
           WHERE ticket IS NOT NULL AND reception_id IN (?)
             AND ((controle = 'rangement' AND resultat = 'bon_emplacement')
               OR (controle = 'export' AND resultat IN ('prelevement_ok', 'sortie_terminee')))
           ORDER BY id`,
          [enPlace.map((l) => l.reception_id)]
        )
      : [[]];
    const sortis = new Set(scansColis.filter((x) => x.controle === 'export').map((x) => x.ticket));
    // dernier rangement de chaque colis : une cosse descendue d'un carton ouvert n'est plus à l'emplacement de sa palette
    const dernier = new Map();
    for (const x of scansColis) if (x.controle === 'rangement') dernier.set(x.ticket, x.emplacement_scanne);
    // cosse dans un carton rangé (pas descendue) : elle est là où est le carton (il a pu être déplacé)
    const [dansCarton] = enPlace.length
      ? await db.query(
          `SELECT c.ticket, ca.emplacement FROM controles_mobile c JOIN cartons ca ON ca.id = c.carton_id
           WHERE c.controle = 'reception' AND c.ticket IS NOT NULL AND c.reception_id IN (?) AND ca.statut = 'range'
             AND NOT EXISTS (SELECT 1 FROM descentes_carton_cosses d WHERE d.ticket = c.ticket AND d.pose_le IS NOT NULL)`,
          [enPlace.map((l) => l.reception_id)]
        )
      : [[]];
    for (const x of dansCarton) if (dernier.has(x.ticket)) dernier.set(x.ticket, x.emplacement);
    const colisIci = (receptionId) => [...new Set(scansColis
      .filter((x) => x.controle === 'rangement' && x.reception_id === receptionId && !sortis.has(x.ticket) && dernier.get(x.ticket) === code)
      .map((x) => Number(String(x.ticket).split('|').pop())))].sort((a, b) => a - b);
    const produits = enPlace.map(({ reception_id, reference, lot, type, taille_bobine, quantite, date_reception }) => ({
      reference, lot, type, taille_bobine, quantite, date_reception, colis: colisIci(reception_id),
    }));
    const [controles] = await db.query(
      `SELECT c.resultat, c.reference, c.lot, DATE_FORMAT(c.date_controle, '%Y-%m-%dT%H:%i:%s') AS date, u.matricule AS par
       FROM controles_mobile c LEFT JOIN utilisateurs u ON u.id = c.utilisateur_id
       WHERE c.emplacement_scanne = ? ORDER BY c.date_controle DESC, c.id DESC LIMIT 10`,
      [code]
    );
    // palette de cosses : seule sur l'emplacement, elle se déplace en entier
    const ligneP = enPlace.find((l) => l.palette_cosses_id);
    let palette = null;
    if (ligneP) {
      const [[p]] = await db.query(`${P.SELECT_PALETTE} WHERE p.id = ?`, [ligneP.palette_cosses_id]);
      const v = await P.vuePalette(db, p);
      palette = {
        id: v.id, numero: v.numero, cosses: enPlace.reduce((t, l) => t + Number(l.quantite), 0),
        cartons: v.cartons.filter((c) => c.en_stock > 0).map((c) => ({ numero: c.numero, reference: c.reference, lot: c.lot, en_stock: c.en_stock })),
        separees: v.nb_separees,
      };
    }
    res.json({ code, niveau: R.lireCode(code)?.niveau ?? null, tampon: R.estTampon(code), produits, controles, palette });
  } catch (err) { next(err); }
});

// GET /api/mobile/carton?qr= : étiquette d'un carton de cosses → le carton, ses cosses, sa palette et où il est
router.get('/carton', async (req, res, next) => {
  try {
    const etiquette = C.lireEtiquetteCarton(req.query.qr);
    if (!etiquette) return res.status(400).json({ message: "Ce QR n'est pas une étiquette de carton." });
    const [[carton]] = await db.query(`${C.SELECT_CARTON} WHERE c.date_etiquette = ?`, [etiquette.date]);
    if (!carton || String(carton.reference).toUpperCase() !== etiquette.reference) {
      return res.status(404).json({ message: 'Étiquette de carton inconnue : réimprimez-la depuis le web (page Import).' });
    }
    const vue = await C.vueCarton(db, carton);
    const cosses = await C.cossesDuCarton(db, carton.id);
    const sortis = await P.ticketsSortis(db, cosses.map((x) => x.ticket));
    const [[imp]] = await db.query('SELECT id, numero_livraison FROM imports WHERE id = ?', [carton.import_id]);
    let palette = null;
    if (carton.palette_id) {
      const [[p]] = await db.query(`${P.SELECT_PALETTE} WHERE p.id = ?`, [carton.palette_id]);
      if (p) {
        const v = await P.vuePalette(db, p);
        palette = {
          id: v.id, numero: v.numero, statut: v.statut, emplacement: v.emplacement, contenu: v.contenu, cosses: v.cosses, en_stock: v.en_stock,
          nb_separees: v.nb_separees,
          cartons: v.cartons.filter((c) => c.cosses > 0).map((c) => ({ id: c.id, numero: c.numero, reference: c.reference, lot: c.lot, cosses: c.cosses, en_stock: c.en_stock, statut: c.statut })),
        };
      }
    }
    res.json({
      carton: {
        id: vue.id, numero: vue.numero, reference: vue.reference, lot: vue.lot, statut: vue.statut, cosses: vue.cosses, pieces: vue.pieces,
        en_stock: vue.en_stock, emplacement: vue.emplacement, date_etiquette: vue.date_etiquette,
        liste: cosses.map((x) => ({ colis: x.colis, pieces: x.pieces, sortie: sortis.has(x.ticket), en_stock: !!x.reception_id })),
      },
      palette,
      import: { id: imp.id, numero_livraison: imp.numero_livraison },
    });
  } catch (err) { next(err); }
});

// GET /api/mobile/produit?reference=&lot= : lignes d'import, avancement et emplacements
router.get('/produit', async (req, res, next) => {
  try {
    const reference = String(req.query.reference ?? '').trim().toUpperCase();
    const lot = String(req.query.lot ?? '').trim();
    if (!reference) return res.status(400).json({ message: 'Indiquez la référence' });
    const [lignes] = await db.query(
      `SELECT r.id, r.import_id, i.statut AS statut_import, i.numero_livraison, r.type, r.taille_bobine, r.type_cosse, r.reference, r.lot,
              r.quantite - COALESCE(rc.quantite, 0) AS quantite,
              (SELECT COUNT(*) FROM controles_mobile c WHERE c.reception_id = r.id AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite')) AS nb_recus,
              (SELECT COUNT(*) FROM controles_mobile c WHERE c.reception_id = r.id AND c.controle = 'rangement' AND c.resultat = 'bon_emplacement') AS nb_ranges,
              EXISTS (SELECT 1 FROM controles_mobile c WHERE c.reception_id = r.id AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite') AND c.ticket IS NULL) AS recue_lot,
              EXISTS (SELECT 1 FROM controles_mobile c WHERE c.reception_id = r.id AND c.controle = 'rangement' AND c.resultat = 'bon_emplacement' AND c.ticket IS NULL) AS rangee_lot,
              EXISTS (SELECT 1 FROM controles_mobile c WHERE c.reception_id = r.id AND c.controle = 'reception' AND c.resultat = 'ecart_quantite') AS ecart
       FROM receptions r JOIN imports i ON i.id = r.import_id LEFT JOIN reclamations rc ON rc.reception_id = r.id
       WHERE UPPER(r.reference) = ? ${lot ? 'AND r.lot = ?' : ''}
       ORDER BY i.date_creation DESC, r.id DESC LIMIT 50`,
      lot ? [reference, lot] : [reference]
    );
    const [placements] = lignes.length
      ? await db.query('SELECT reception_id, emplacement, quantite FROM placements WHERE reception_id IN (?)', [lignes.map((l) => l.id)])
      : [[]];
    res.json(
      lignes.map((l) => {
        const quantite = Number(l.quantite);
        const nb_recus = Number(l.nb_recus);
        const nb_ranges = Number(l.nb_ranges);
        // ticket par lot : un scan suffit ; tickets par colis : tous les colis comptent
        const ligne = {
          ...l, quantite, nb_recus, nb_ranges, ecart: !!l.ecart,
          recue: !!l.recue_lot || nb_recus >= quantite,
          rangee: !!l.rangee_lot || (nb_ranges > 0 && nb_ranges >= quantite),
        };
        delete ligne.recue_lot;
        delete ligne.rangee_lot;
        return {
          ...ligne,
          statut: statutLigne(ligne),
          emplacements: placements.filter((p) => p.reception_id === l.id).map((p) => ({ code: p.emplacement, quantite: p.quantite })),
        };
      })
    );
  } catch (err) { next(err); }
});

// GET /api/mobile/mes-controles : les 30 derniers contrôles de l'utilisateur connecté
router.get('/mes-controles', async (req, res, next) => {
  try {
    const [lignes] = await db.query(
      `SELECT uuid, controle, resultat, reference, lot, emplacement_scanne, emplacement_prevu, message, saisie_manuelle,
              DATE_FORMAT(date_controle, '%Y-%m-%dT%H:%i:%s') AS date
       FROM controles_mobile WHERE utilisateur_id = ? ORDER BY date_controle DESC, id DESC LIMIT 30`,
      [req.utilisateur.id]
    );
    res.json(lignes.map((l) => ({ ...l, couleur: COULEURS[l.resultat], titre: TITRES[l.resultat], saisie_manuelle: !!l.saisie_manuelle })));
  } catch (err) { next(err); }
});

// GET /api/mobile/journal?du=&au=&utilisateur=&reference=&resultat=&tout=1
// Journal des contrôles (administrateur, chef de magasin). Par défaut : les alertes seulement
// (écarts de quantité, faux emplacements, produits inconnus).
router.get('/journal', exigerGestionnaire(), async (req, res, next) => {
  try {
    const conditions = [];
    const valeurs = [];
    if (COULEURS[req.query.resultat]) {
      conditions.push('c.resultat = ?');
      valeurs.push(req.query.resultat);
    } else if (req.query.tout !== '1') {
      conditions.push('c.resultat IN (?)');
      valeurs.push(ALERTES);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.du || '')) {
      conditions.push('DATE(c.date_controle) >= ?');
      valeurs.push(req.query.du);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.au || '')) {
      conditions.push('DATE(c.date_controle) <= ?');
      valeurs.push(req.query.au);
    }
    if (Number(req.query.utilisateur) > 0) {
      conditions.push('c.utilisateur_id = ?');
      valeurs.push(Number(req.query.utilisateur));
    }
    if (req.query.reference) {
      conditions.push('c.reference LIKE ?');
      valeurs.push(`%${String(req.query.reference).trim().toUpperCase()}%`);
    }
    const [lignes] = await db.query(
      `SELECT c.id, c.controle, c.resultat, c.reference, c.lot, c.quantite_ticket, c.quantite_attendue, c.ecart,
              c.import_id, c.preparation_id, c.emplacement_prevu, c.emplacement_scanne, c.saisie_manuelle, c.message,
              DATE_FORMAT(c.date_controle, '%Y-%m-%dT%H:%i:%s') AS date,
              u.matricule, u.matricule AS par
       FROM controles_mobile c LEFT JOIN utilisateurs u ON u.id = c.utilisateur_id
       ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
       ORDER BY c.date_controle DESC, c.id DESC LIMIT 500`,
      valeurs
    );
    res.json(lignes.map((l) => ({ ...l, titre: TITRES[l.resultat], couleur: COULEURS[l.resultat], saisie_manuelle: !!l.saisie_manuelle })));
  } catch (err) { next(err); }
});

module.exports = router;
// Partagé avec la sortie préparée sur le mobile (routes/mobile-export.js)
module.exports.outils = { enregistrer, operation, texteEmplacements, UUID, COULEURS, TITRES, ALERTES, controleReception, lignesDuTicket };
