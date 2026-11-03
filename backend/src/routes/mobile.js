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
};
const ALERTES = ['ecart_quantite', 'faux_emplacement', 'inconnu', 'mauvais_produit', 'stock_modifie', 'deplacement_refuse'];
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

const texteEmplacements = (liste) => liste.map((e) => e.code ?? 'non rangé').join(', ') || null;

// Réponse pour le téléphone (même forme pour un contrôle enregistré et pour une suggestion)
function reponseControle(req, controle, resultat, donnees) {
  const d = {
    reference: null, lot: null, quantite_ticket: null, quantite_attendue: null, ecart: null,
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

// Enregistre le contrôle et renvoie la réponse pour le téléphone
async function enregistrer(connexion, req, controle, resultat, donnees) {
  const { d, reponse } = reponseControle(req, controle, resultat, donnees);
  await connexion.query(
    `INSERT INTO controles_mobile
       (uuid, controle, resultat, reference, lot, ticket, quantite_ticket, quantite_attendue, ecart, reception_id, import_id,
        preparation_id, palette_id, emplacement_prevu, emplacement_scanne, saisie_manuelle, qr_brut, message, reponse, utilisateur_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.body.uuid, controle, resultat, d.reference, d.lot, d.ticket, d.quantite_ticket, d.quantite_attendue, d.ecart,
      d.reception_id ?? d.ligne?.id ?? null, d.import_id ?? d.ligne?.import_id ?? null, d.preparation_id, d.palette_id, texteEmplacements(d.emplacements_prevus), d.emplacement_scanne,
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
  const extraColis = (n, attendue) => ({ colis: { numero: colis, confection: ticket.confection, recus: n, attendus: attendue } });

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
      message: `Colis n° ${colis} conforme : palette ${palette.numero} (${k}/${cap})${k >= cap ? ', palette pleine : terminez-la' : ''}.`,
    });
  }
  if (ligne) {
    const n = (recus.get(ligne.id) ?? 0) + 1;
    const emplacements = await emplacementsPrevus(connexion, ligne);
    return enregistrer(connexion, req, 'reception', 'conforme', {
      ...base, ligne, quantite_attendue: ligne.attendue, emplacements_prevus: emplacements, extra: extraColis(n, ligne.attendue),
      message: `Colis n° ${colis} conforme : ${n}/${ligne.attendue} reçu(s) pour ce lot. Rangez-le en ${texteEmplacements(emplacements) ?? 'zone tampon'}.`,
    });
  }
  // Tous les colis annoncés sont déjà reçus : colis en trop
  const attendus = lignes.reduce((t, l) => t + l.attendue, 0);
  const total = lignes.reduce((t, l) => t + (recus.get(l.id) ?? 0), 0) + 1;
  return enregistrer(connexion, req, 'reception', 'ecart_quantite', {
    ...base, ligne: lignes[lignes.length - 1], quantite_ticket: total, quantite_attendue: attendus, ecart: total - attendus,
    extra: extraColis(total, attendus),
    message: `Colis en trop : l'import annonce ${attendus} produit(s) pour ${reference} lot ${nomLot}, tous déjà reçus. Mettez le colis n° ${colis} de côté (hors stock), il sera signalé au chef.`,
  });
}

// ---------- Contrôle 1 : réception du ticket ----------
// POST /api/mobile/reception  { uuid, qr, saisie_manuelle? }
// import_id (facultatif) = import en cours de réception choisi sur le mobile : les colis sont
// rapprochés de cet import ; un produit absent de l'import est noté « hors import » pour lui.
router.post('/reception', operation('reception', async (connexion, req) => {
  const importChoisi = Number(req.body.import_id) > 0 ? Number(req.body.import_id) : null;
  let imp = null;
  if (importChoisi) {
    [[imp]] = await connexion.query(
      'SELECT id, statut, reception, numero_livraison FROM imports WHERE id = ? FOR UPDATE',
      [importChoisi]
    );
    if (!imp) throw Object.assign(new Error('Import introuvable'), { status: 404 });
    if (imp.statut !== 'en_attente' || imp.reception === 'terminee') {
      return enregistrer(connexion, req, 'reception', 'deja_traite', {
        import_id: imp.id,
        message: `La réception de l'import ${imp.numero_livraison ?? 'n° ' + imp.id} est terminée : choisissez un autre import.`,
      });
    }
    const avant = await receptionPrecedenteNonTerminee(connexion, imp.id);
    if (avant) throw refus(409, messageOrdreReception(avant));
  }
  const ticket = lireTicket(req.body.qr);
  if (!ticket) {
    return enregistrer(connexion, req, 'reception', 'ticket_illisible', { import_id: importChoisi, message: messageIllisible(req.body.qr) });
  }
  const { reference, lot, quantite } = ticket;
  const base = { reference, lot, quantite_ticket: quantite, ticket: ticket.cle, import_id: importChoisi };
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
        : importChoisi
          ? `${reference} lot ${lot} n'est pas dans cet import : mettez ce colis de côté. Il sera signalé au chef (hors import).`
          : `${reference} lot ${lot} n'existe dans aucun import : rangement bloqué. Prévenez le responsable.`,
    });
  }
  // Bobines et cosses plates d'un import : reçues palette par palette (ticket du colis obligatoire).
  // Les cosses axiales (petites) se reçoivent une par une, sans palette, comme les connecteurs.
  if (importChoisi && TYPES_PALETTE.includes(lignes[0].type) && !R.estAxiale(lignes[0])) {
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
  const emplacements = await emplacementsPrevus(connexion, ligne);
  const ecart = quantite - ligne.attendue;
  const donnees = { ...base, ligne, quantite_attendue: ligne.attendue, ecart, emplacements_prevus: emplacements };
  if (ecart === 0) {
    return enregistrer(connexion, req, 'reception', 'conforme', {
      ...donnees,
      message: `Quantité conforme (${quantite}). Rangez-le en ${texteEmplacements(emplacements) ?? 'zone tampon'}.`,
    });
  }
  return enregistrer(connexion, req, 'reception', 'ecart_quantite', {
    ...donnees,
    message: `Écart de ${ecart > 0 ? '+' : ''}${ecart} : ticket ${quantite}, import ${ligne.attendue}. L'écart est enregistré.`,
  });
}));

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
      `SELECT reception_id FROM controles_mobile
       WHERE ticket = ? AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite') ORDER BY id LIMIT 1`,
      [ticket.cle]
    );
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
  return { ...cible, niveau, tampon: R.estTampon(cible.code), elevateur: niveau === 4 };
}

// POST /api/mobile/rangement/suggestion  { qr }
// 1re étape : ticket scanné → emplacement où aller. Rien n'est enregistré : le contrôle se fait
// au scan de l'emplacement (POST /rangement).
router.post('/rangement/suggestion', async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    await connexion.beginTransaction(); // attribution éventuelle d'un emplacement au colis
    const repondre = (resultat, donnees) => res.json(reponseControle(req, 'rangement', resultat, donnees).reponse);
    const ticket = lireTicket(req.body?.qr);
    if (!ticket) return repondre('ticket_illisible', { message: messageIllisible(req.body?.qr) });
    const t = await ticketARanger(connexion, ticket);
    if (t.refus) return repondre(...t.refus);
    const ligne = t.aRanger[0];
    const prevus = await emplacementsPrevus(connexion, ligne);
    const donnees = { ...t.base, ligne, quantite_attendue: ligne.attendue, emplacements_prevus: prevus };
    const affPalette = ticket.cle ? await affectationPalette(connexion, ticket.cle) : null;
    if (affPalette) {
      const niveau = R.lireCode(affPalette.emplacement)?.niveau ?? null;
      return repondre('a_ranger', {
        ...donnees, emplacements_prevus: [{ code: affPalette.emplacement, quantite: 1 }],
        extra: { suggestion: { code: affPalette.emplacement, quantite: 1, ranges: 0, niveau, tampon: R.estTampon(affPalette.emplacement), elevateur: niveau === 4 } },
        message: `Colis n° ${ticket.colis} (palette ${affPalette.palette}) : allez en ${affPalette.emplacement} et scannez l'étiquette de l'emplacement.`,
      });
    }
    if (ligne.statut_import !== 'ajoute') {
      return repondre('import_en_attente', {
        ...donnees,
        message: `L'import ${ligne.numero_livraison ?? 'n° ' + ligne.import_id} n'est pas encore ajouté au stock : rangement pas encore possible. Demandez au responsable.`,
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
        extra: { suggestion: { ...place, code: aff.emplacement, niveau, tampon: R.estTampon(aff.emplacement), elevateur: niveau === 4 } },
        message: `Colis n° ${ticket.colis} : allez en ${aff.emplacement}${niveau === 4 ? ' (élévateur)' : ''} et scannez l'étiquette de l'emplacement.`,
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
  if (ligne.statut_import !== 'ajoute') {
    return enregistrer(connexion, req, 'rangement', 'import_en_attente', {
      ...donnees,
      message: `L'import ${ligne.numero_livraison ?? 'n° ' + ligne.import_id} n'est pas encore validé : rangement pas encore possible. Rien n'est enregistré.`,
    });
  }
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
  if (!ticket) {
    return enregistrer(connexion, req, 'rangement', 'ticket_illisible', {
      emplacement_scanne: code, message: messageIllisible(req.body.qr),
    });
  }
  const { reference, lot } = ticket;
  const t = await ticketARanger(connexion, ticket, code);
  if (t.refus) return enregistrer(connexion, req, 'rangement', ...t.refus);
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
          `SELECT reception_id, ticket, controle FROM controles_mobile
           WHERE ticket IS NOT NULL AND reception_id IN (?)
             AND ((controle = 'rangement' AND resultat = 'bon_emplacement' AND emplacement_scanne = ?)
               OR (controle = 'export' AND resultat IN ('prelevement_ok', 'sortie_terminee')))
           ORDER BY id`,
          [enPlace.map((l) => l.reception_id), code]
        )
      : [[]];
    const sortis = new Set(scansColis.filter((x) => x.controle === 'export').map((x) => x.ticket));
    const colisIci = (receptionId) => [...new Set(scansColis
      .filter((x) => x.controle === 'rangement' && x.reception_id === receptionId && !sortis.has(x.ticket))
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
    res.json({ code, niveau: R.lireCode(code)?.niveau ?? null, tampon: R.estTampon(code), produits, controles });
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
module.exports.outils = { enregistrer, operation, texteEmplacements, UUID, COULEURS, TITRES, ALERTES };
