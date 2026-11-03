const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('../db');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const R = require('../rangement');
const { parametresRangement } = require('../parametres');
const { exigerGestionnaire } = require('../middleware/auth');
const { MOTIFS_DEPLACEMENT, lireMotif, enregistrerMouvements } = require('../historique');

const router = express.Router();

function ordreStock(a, b) {
  return a.reference.localeCompare(b.reference, 'fr', { numeric: true }) || R.ordreFifo(a, b);
}

// Stock en place : tout ce qui est posé sur un emplacement. Les bobines rangées palette par palette
// pendant la réception en font partie, avant même la validation de l'import.
// Une ligne par placement : une ligne de réception de quantité N peut être répartie
// sur plusieurs emplacements (ex. 10 petites bobines → D000 ×6 + D001 ×4).
// id = identifiant du placement ; reception_id = ligne de l'import.
async function lignesEnStock(connexion = db, verrou = false) {
  const [lignes] = await connexion.query(
    `SELECT p.id, p.reception_id, r.reference, r.type, r.taille_bobine, r.type_cosse, r.lot, p.quantite, p.emplacement,
            r.longueur, r.largeur, r.hauteur, r.poids,
            DATE_FORMAT(r.date_reception, '%Y-%m-%dT%H:%i:%s') AS date_reception
     FROM placements p
     JOIN receptions r ON r.id = p.reception_id
     ${verrou ? 'FOR UPDATE' : ''}`
  );
  return lignes.map(avecMesures);
}

// Dimensions (cm) et poids (kg) des cartons de connecteurs, en nombres (null pour les autres produits)
function avecMesures(l) {
  const nombre = (v) => (v === null || v === undefined ? null : Number(v));
  return { ...l, longueur: nombre(l.longueur), largeur: nombre(l.largeur), hauteur: nombre(l.hauteur), poids: nombre(l.poids) };
}

// Places réservées par le plan de rangement : produits reçus, pas encore rangés (donc pas au stock).
// Même forme que lignesEnStock ; id négatif (pas un placement), reserve = true.
async function placesReservees(connexion = db, verrou = false) {
  const [lignes] = await connexion.query(
    `SELECT -pr.id AS id, pr.reception_id, r.reference, r.type, r.taille_bobine, r.type_cosse, r.lot, pr.quantite - pr.ranges AS quantite,
            pr.emplacement, r.longueur, r.largeur, r.hauteur, r.poids,
            DATE_FORMAT(r.date_reception, '%Y-%m-%dT%H:%i:%s') AS date_reception
     FROM plans_rangement pr
     JOIN receptions r ON r.id = pr.reception_id
     JOIN imports i ON i.id = r.import_id AND i.statut = 'ajoute'
     WHERE pr.quantite > pr.ranges
     ${verrou ? 'FOR UPDATE OF pr' : ''}`
  );
  // Bobines d'une palette de réception terminée, pas encore posées : leur emplacement est réservé
  const [palettes] = await connexion.query(
    `SELECT -(1000000 + a.id) AS id, a.reception_id, r.reference, r.type, r.taille_bobine, r.type_cosse, r.lot, 1 AS quantite,
            a.emplacement, r.longueur, r.largeur, r.hauteur, r.poids,
            DATE_FORMAT(r.date_reception, '%Y-%m-%dT%H:%i:%s') AS date_reception
     FROM affectations_colis a
     JOIN receptions r ON r.id = a.reception_id
     WHERE a.palette_id IS NOT NULL AND a.range_le IS NULL
     ${verrou ? 'FOR UPDATE OF a' : ''}`
  );
  return [...lignes, ...palettes].map((l) => ({ ...avecMesures(l), quantite: Number(l.quantite), reserve: true }));
}

// Occupation des emplacements pour calculer un rangement : stock rangé + places réservées
async function occupation(connexion = db, verrou = false) {
  return [...(await lignesEnStock(connexion, verrou)), ...(await placesReservees(connexion, verrou))];
}

// Ajoute une quantité d'une ligne de réception à un emplacement (fusionne si elle y est déjà)
async function poserQuantite(connexion, receptionId, emplacement, quantite) {
  if (!quantite) return;
  if (emplacement === null) {
    const [[existant]] = await connexion.query(
      'SELECT id FROM placements WHERE reception_id = ? AND emplacement IS NULL',
      [receptionId]
    );
    if (existant) {
      await connexion.query('UPDATE placements SET quantite = quantite + ? WHERE id = ?', [quantite, existant.id]);
      return;
    }
  }
  await connexion.query(
    `INSERT INTO placements (reception_id, emplacement, quantite) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE quantite = quantite + VALUES(quantite)`,
    [receptionId, emplacement, quantite]
  );
}

// Produits identiques (même référence, même lot, même date de réception) au même emplacement :
// une seule ligne, quantités additionnées. ids = placements regroupés.
// Un même lot reçu à deux dates (lot envoyé en plusieurs fois) reste sur deux lignes.
function regrouper(lignes) {
  const groupes = new Map();
  for (const l of lignes) {
    const cle = [l.reference, l.type, l.taille_bobine, l.type_cosse, l.lot, l.date_reception, l.emplacement].join('|');
    const g = groupes.get(cle);
    const volume = l.type === 'connecteur' ? R.volumeCarton(l) * l.quantite : null;
    const poids = l.type === 'connecteur' ? Number(l.poids) * l.quantite : null;
    if (g) {
      g.quantite += l.quantite;
      g.ids.push(l.id);
      if (volume !== null) {
        g.volume += volume;
        g.poids_total += poids;
      }
    } else {
      groupes.set(cle, { ...l, ids: [l.id], volume, poids_total: poids });
    }
  }
  return [...groupes.values()];
}

// GET /api/stock
// Tri : référence, puis ordre FIFO (plus petit lot, puis réception la plus ancienne).
router.get('/', async (req, res, next) => {
  try {
    res.json(regrouper(await lignesEnStock()).sort(ordreStock));
  } catch (err) { next(err); }
});

// POST /api/stock/ranger-automatiquement
// 1. Zone tampon d'abord, dans l'ordre FIFO : les produits du tampon prennent les places libres
//    des rayonnages ; ce qui ne trouve pas de place reste sur sa place tampon.
// 2. Puis les produits non rangés, avec toutes les règles (zone tampon comprise).
router.post('/ranger-automatiquement', async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion); // une opération sur le stock à la fois
    await connexion.beginTransaction();
    const { capaciteTampon: capacite, limites } = await parametresRangement(connexion);
    const lignes = await lignesEnStock(connexion, true);
    const reservees = await placesReservees(connexion, true);
    const enRayon = [...lignes.filter((l) => l.emplacement && !R.estTampon(l.emplacement)), ...reservees.filter((l) => !R.estTampon(l.emplacement))];
    const tampon = lignes.filter((l) => R.estTampon(l.emplacement));
    const sansPlace = lignes.filter((l) => !l.emplacement);

    // Nouvelle répartition de chaque ligne traitée : placement -> [{ emplacement, quantite }]
    const repartition = new Map();

    // 1. Tampon → rayonnages (pas de zone tampon dans ce calcul)
    const planTampon = R.proposerPlan(tampon, enRayon, { ordre: 'fifo', capaciteTampon: 0, limites });
    for (const l of tampon) {
      const parts = planTampon.filter((p) => p.id === l.id);
      const deplace = parts.filter((p) => p.emplacement).reduce((s, p) => s + p.quantite, 0);
      repartition.set(l.id, [
        ...parts.filter((p) => p.emplacement).map((p) => ({ emplacement: p.emplacement, quantite: p.quantite })),
        { emplacement: l.emplacement, quantite: l.quantite - deplace }, // reste sur sa place tampon
      ]);
    }

    // État du magasin après ces mouvements
    const etat = [
      ...enRayon,
      ...reservees.filter((l) => R.estTampon(l.emplacement)),
      ...tampon.flatMap((l) => repartition.get(l.id).map((r) => ({ ...l, ...r }))),
    ];

    // 2. Produits non rangés
    const planNouveaux = R.proposerPlan(sansPlace, etat, { capaciteTampon: capacite, limites });
    for (const l of sansPlace) {
      repartition.set(
        l.id,
        planNouveaux.filter((p) => p.id === l.id).map((p) => ({ emplacement: p.emplacement, quantite: p.quantite }))
      );
    }

    // Écriture
    let ranges = 0;
    let enTampon = 0;
    let sansPlaceRestant = 0;
    const mouvements = [];
    for (const l of [...tampon, ...sansPlace]) {
      const parts = repartition.get(l.id);
      await connexion.query('DELETE FROM placements WHERE id = ?', [l.id]);
      for (const p of parts) await poserQuantite(connexion, l.reception_id, p.emplacement, p.quantite);
      // Historique : produits sortis de la zone tampon vers un rayonnage
      if (R.estTampon(l.emplacement)) {
        for (const p of parts) {
          if (p.emplacement && p.emplacement !== l.emplacement) {
            mouvements.push({
              origine: 'automatique', ligne: l, quantite: p.quantite, depuis: l.emplacement, vers: p.emplacement,
              utilisateurId: req.utilisateur.id,
            });
          }
        }
      }
      for (const p of parts) {
        if (!p.emplacement) sansPlaceRestant += p.quantite;
        else if (R.estTampon(p.emplacement)) enTampon += l.emplacement === p.emplacement ? 0 : p.quantite;
        else ranges += p.quantite;
      }
    }
    await enregistrerMouvements(connexion, mouvements);
    await connexion.commit();
    res.json({ ranges, enTampon, sansPlace: sansPlaceRestant });
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

// PUT /api/stock/:id/emplacement  { emplacement: "D011" | "T05" | null, ids?: [placements], motif, commentaire? }
// Le motif est obligatoire : chaque déplacement est enregistré dans l'historique.
// Déplace un placement, ou une ligne regroupée (ids), avec tous ses produits vers un autre emplacement, en respectant les règles
// (niveau du type, capacité de la palette, une seule taille de bobine par palette).
// Réservé à l'administrateur et au chef de magasin : le magasinier ne choisit pas les emplacements.
router.put('/:id/emplacement', exigerGestionnaire(), async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion); // une opération sur le stock à la fois
    await connexion.beginTransaction();
    const brut = req.body.emplacement;
    const emplacement = brut ? String(brut).trim().toUpperCase() : null;
    const { motif, commentaire, erreur: erreurMotif } = lireMotif(req.body);
    if (erreurMotif) {
      await connexion.rollback();
      return res.status(400).json({ message: erreurMotif });
    }
    const { capaciteTampon: capacite, limites } = await parametresRangement(connexion);
    const lignes = await lignesEnStock(connexion, true);
    const ids = new Set(Array.isArray(req.body.ids) && req.body.ids.length ? req.body.ids.map(Number) : [Number(req.params.id)]);
    const aDeplacer = lignes.filter((l) => ids.has(l.id));
    if (aDeplacer.length !== ids.size) {
      await connexion.rollback();
      return res.status(404).json({ message: 'Ligne introuvable dans le stock' });
    }
    if (aDeplacer.every((l) => l.emplacement === emplacement)) {
      await connexion.rollback();
      return res.status(400).json({ message: `Le produit est déjà en ${emplacement ?? 'non rangé'}` });
    }

    if (emplacement) {
      const autres = [...lignes.filter((l) => !ids.has(l.id)), ...(await placesReservees(connexion, true))];
      const plan = aDeplacer.map((l) => ({ id: l.id, emplacement, quantite: l.quantite }));
      const erreur = R.verifierPlan(plan, aDeplacer, autres, capacite, limites);
      if (erreur) {
        await connexion.rollback();
        return res.status(409).json({ message: erreur });
      }
    }

    const mouvements = [];
    for (const l of aDeplacer) {
      await connexion.query('DELETE FROM placements WHERE id = ?', [l.id]);
      await poserQuantite(connexion, l.reception_id, emplacement, l.quantite);
      if (l.emplacement !== emplacement) {
        mouvements.push({
          origine: 'deplacement', ligne: l, quantite: l.quantite, depuis: l.emplacement, vers: emplacement,
          motif, commentaire, utilisateurId: req.utilisateur.id,
        });
      }
    }
    await enregistrerMouvements(connexion, mouvements);
    await connexion.commit();
    res.json({ id: Number(req.params.id), emplacement });
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

// ---------- Synchronisation : contrôle du stock ----------
// Compare le stock rangé (placements) à ce que la base attend pour chaque ligne d'import :
// reçu - réclamé - sorti vers la production. Vérifie aussi les règles du magasin
// (emplacement existant, bon niveau, capacité des palettes, zone tampon) et les livraisons
// de l'Italie pas encore synchronisées. Lecture seule : rien n'est modifié.
// Chaque contrôle : { cle, titre, statut: 'ok' | 'alerte' | 'erreur', message, details: [] }
router.get('/verification', async (req, res, next) => {
  try {
    const { capaciteTampon: capaciteT, limites } = await parametresRangement(db);
    const lignes = await lignesEnStock();
    const controles = [];
    const ajouter = (cle, titre, statut, message, details = []) =>
      controles.push({ cle, titre, statut, message, details: details.slice(0, 50), total_details: details.length });
    const nomProduit = (l) => `${l.reference} lot ${l.lot}`;

    // 1. Quantités : stock = reçu - réclamé - sorti
    const [attendus] = await db.query(
      `SELECT r.id, r.reference, r.lot, r.quantite AS recu,
              COALESCE((SELECT SUM(rc.quantite) FROM reclamations rc WHERE rc.reception_id = r.id), 0) AS reclame,
              COALESCE((SELECT SUM(d.quantite) FROM export_details d WHERE d.reception_id = r.id), 0) AS sorti,
              COALESCE((SELECT SUM(p.quantite) FROM placements p WHERE p.reception_id = r.id), 0) AS en_stock,
              COALESCE((SELECT SUM(pr.quantite - pr.ranges) FROM plans_rangement pr WHERE pr.reception_id = r.id), 0) AS a_ranger
       FROM receptions r
       JOIN imports i ON i.id = r.import_id AND i.statut = 'ajoute'`
    );
    // reçu - réclamé - sorti - pas encore rangé (places réservées) = en stock
    const attendu = (a) => Number(a.recu) - Number(a.reclame) - Number(a.sorti) - Number(a.a_ranger);
    const ecarts = attendus.filter((a) => Number(a.en_stock) !== attendu(a));
    ajouter(
      'quantites', 'Quantités en stock',
      ecarts.length ? 'erreur' : 'ok',
      ecarts.length
        ? `${ecarts.length} ligne(s) dont la quantité en stock ne correspond pas à la base`
        : `${attendus.length} ligne(s) d'import contrôlée(s) : reçu - réclamé - sorti = stock`,
      ecarts.map((a) => `${a.reference} lot ${a.lot} : ${a.en_stock} en stock, ${attendu(a)} attendu(s) (reçu ${a.recu}, réclamé ${a.reclame}, sorti ${a.sorti}, à ranger ${a.a_ranger})`)
    );

    // 2. Produits rangés sur un import qui n'est pas encore ajouté au stock
    const [orphelins] = await db.query(
      `SELECT r.reference, r.lot, p.emplacement, p.quantite, i.id AS import_id
       FROM placements p JOIN receptions r ON r.id = p.reception_id JOIN imports i ON i.id = r.import_id
       WHERE p.quantite <= 0
          OR (i.statut <> 'ajoute'
              -- bobines rangées palette par palette pendant la réception : normales
              AND NOT EXISTS (SELECT 1 FROM affectations_colis a WHERE a.reception_id = r.id AND a.palette_id IS NOT NULL AND a.emplacement = p.emplacement))`
    );
    ajouter(
      'imports', 'Lien avec les imports',
      orphelins.length ? 'erreur' : 'ok',
      orphelins.length ? `${orphelins.length} placement(s) invalide(s)` : 'Tous les produits rangés viennent d\'un import ajouté au stock',
      orphelins.map((o) => `${o.reference} lot ${o.lot} en ${o.emplacement ?? 'non rangé'} (×${o.quantite}) : import n° ${o.import_id}`)
    );

    // 3. Emplacements existants et bon niveau
    const inconnus = lignes.filter((l) => l.emplacement && !R.emplacementValide(l.emplacement, capaciteT));
    const mauvaisNiveau = lignes.filter((l) => {
      const typePlace = l.emplacement && R.typeEmplacement(l.emplacement);
      return typePlace && typePlace !== l.type;
    });
    ajouter(
      'emplacements', 'Emplacements et niveaux',
      inconnus.length || mauvaisNiveau.length ? 'erreur' : 'ok',
      inconnus.length || mauvaisNiveau.length
        ? `${inconnus.length + mauvaisNiveau.length} produit(s) mal placé(s)`
        : 'Chaque produit est sur un emplacement existant, au bon niveau',
      [
        ...inconnus.map((l) => `${nomProduit(l)} : l'emplacement ${l.emplacement} n'existe pas`),
        ...mauvaisNiveau.map((l) => `${nomProduit(l)} (${l.type}) en ${l.emplacement} : se range ${R.AU_NIVEAU[l.type]}`),
      ]
    );

    // 4. Capacité des palettes
    const contenu = R.etatMagasin(lignes);
    const surcharges = [];
    for (const [code, unites] of contenu) {
      const premier = unites[0];
      if (!unites.every((u) => R.peutPartager(u, premier))) {
        surcharges.push(`${code} : produits incompatibles sur la même palette (${[...new Set(unites.map((u) => u.reference))].join(', ')})`);
        continue;
      }
      if (premier.type === 'connecteur') {
        const lim = R.limitesPalette(code, limites);
        const poids = unites.reduce((t, u) => t + Number(u.poids || 0), 0);
        const volume = unites.reduce((t, u) => t + R.volumeCarton(u), 0);
        if (poids > lim.poidsMax + 1e-9) surcharges.push(`${code} : ${Math.round(poids * 10) / 10} kg pour ${lim.poidsMax} kg maximum`);
        if (volume > lim.volumeMax + 1e-6) surcharges.push(`${code} : ${Math.round(volume / 1000)} L pour ${Math.round(lim.volumeMax / 1000)} L maximum`);
      } else if (unites.length > R.capacite(premier)) {
        surcharges.push(`${code} : ${unites.length} produits pour ${R.capacite(premier)} maximum`);
      }
    }
    ajouter(
      'palettes', 'Capacité des palettes',
      surcharges.length ? 'erreur' : 'ok',
      surcharges.length ? `${surcharges.length} palette(s) au-delà de leur capacité` : `${contenu.size} palette(s) occupée(s), toutes dans leurs limites`,
      surcharges
    );

    // 5. Produits non rangés et zone tampon
    const nonRanges = lignes.filter((l) => !l.emplacement);
    const enTampon = lignes.filter((l) => l.emplacement && R.estTampon(l.emplacement));
    const qte = (liste) => liste.reduce((t, l) => t + l.quantite, 0);
    ajouter(
      'rangement', 'Produits à ranger',
      nonRanges.length || enTampon.length ? 'alerte' : 'ok',
      nonRanges.length || enTampon.length
        ? [nonRanges.length && `${qte(nonRanges)} produit(s) sans emplacement`, enTampon.length && `${qte(enTampon)} en zone tampon`].filter(Boolean).join(' · ')
        : 'Tous les produits sont rangés en rayonnage',
      [
        ...nonRanges.map((l) => `${nomProduit(l)} ×${l.quantite} : sans emplacement`),
        ...enTampon.map((l) => `${nomProduit(l)} ×${l.quantite} : en ${l.emplacement}`),
      ]
    );

    // 6. Livraisons de l'Italie pas encore synchronisées
    const [italie] = await db.query(
      `SELECT numero, DATE_FORMAT(date_envoi, '%d/%m/%Y %H:%i') AS envoi FROM italie_imports
       WHERE id NOT IN (SELECT source_id FROM imports WHERE source_id IS NOT NULL) ORDER BY date_envoi`
    );
    const [enAttente] = await db.query("SELECT COUNT(*) AS n FROM imports WHERE statut = 'en_attente'");
    const nAttente = Number(enAttente[0].n);
    ajouter(
      'italie', "Base de l'Italie",
      italie.length || nAttente ? 'alerte' : 'ok',
      italie.length || nAttente
        ? [italie.length && `${italie.length} livraison(s) à synchroniser (page Import)`, nAttente && `${nAttente} import(s) en attente d'ajout au stock`].filter(Boolean).join(' · ')
        : 'Toutes les livraisons sont synchronisées et ajoutées au stock',
      italie.map((i) => `${i.numero} envoyée le ${i.envoi}`)
    );

    const erreurs = controles.filter((c) => c.statut === 'erreur').length;
    const alertes = controles.filter((c) => c.statut === 'alerte').length;
    res.json({
      date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19),
      statut: erreurs ? 'erreur' : alertes ? 'alerte' : 'ok',
      resume: {
        produits: qte(lignes),
        references: new Set(lignes.map((l) => l.reference)).size,
        palettes: contenu.size,
        erreurs,
        alertes,
      },
      controles,
    });
  } catch (err) { next(err); }
});

// ---------- Historique des changements d'emplacement ----------
const ORIGINES = { deplacement: 'Déplacement', plan_import: "Plan d'import modifié", automatique: 'Automatique', regroupement: 'Ranger le magasin', inventaire: 'Inventaire' };
const TYPES = { bobine: 'Bobine', cosse: 'Cosse', connecteur: 'Connecteur' };
const TAILLES = { grande: 'grande', moyenne: 'moyenne', petite: 'petite' };
const ROLES = { admin: 'Administrateur', chef_magasin: 'Chef de magasin', magasinier: 'Magasinier', planificateur: 'Planificateur' };

const libelleType = (m) => TYPES[m.type] + (m.taille_bobine ? ' ' + TAILLES[m.taille_bobine] : '');

// "2026-10-13T13:00:00" -> "13/10/2026 13:00"
function dateFr(iso) {
  if (!iso) return '';
  const [j, h] = iso.split('T');
  return j.split('-').reverse().join('/') + ' ' + h.slice(0, 5);
}

// Filtres : reference, emplacement, origine, par (matricule), du, au (AAAA-MM-JJ). limite : null = tout l'historique
async function chargerHistorique(filtres = {}, limite = 500) {
  const conditions = [];
  const valeurs = [];
  if (filtres.reference) {
    conditions.push('m.reference LIKE ?');
    valeurs.push(`%${String(filtres.reference).trim().toUpperCase()}%`);
  }
  if (filtres.emplacement) {
    const code = String(filtres.emplacement).trim().toUpperCase();
    conditions.push('(m.depuis = ? OR m.vers = ?)');
    valeurs.push(code, code);
  }
  if (ORIGINES[filtres.origine]) {
    conditions.push('m.origine = ?');
    valeurs.push(filtres.origine);
  }
  if (filtres.par) {
    conditions.push('u.matricule = ?');
    valeurs.push(String(filtres.par).trim());
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(filtres.du || '')) {
    conditions.push('DATE(m.date_mouvement) >= ?');
    valeurs.push(filtres.du);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(filtres.au || '')) {
    conditions.push('DATE(m.date_mouvement) <= ?');
    valeurs.push(filtres.au);
  }
  const [lignes] = await db.query(
    `SELECT m.id, DATE_FORMAT(m.date_mouvement, '%Y-%m-%dT%H:%i:%s') AS date, m.origine, m.reference, m.lot, m.type,
            m.taille_bobine, m.quantite, m.colis, m.depuis, m.vers, m.depuis_liberee, m.motif, m.commentaire,
            u.matricule AS par, u.role, u.nom, u.prenom
     FROM mouvements_emplacement m
     LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
     ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
     ORDER BY m.date_mouvement DESC, m.id DESC
     ${limite ? 'LIMIT ' + Number(limite) : ''}`,
    valeurs
  );
  return lignes.map((l) => ({ ...l, depuis_liberee: !!l.depuis_liberee, motif_libelle: l.motif ? MOTIFS_DEPLACEMENT[l.motif] : null }));
}

// Filtres appliqués, en clair (en-tête des fichiers)
function descriptionFiltres(q) {
  const f = [];
  if (q.reference) f.push(`référence « ${String(q.reference).toUpperCase()} »`);
  if (q.emplacement) f.push(`emplacement ${String(q.emplacement).toUpperCase()}`);
  if (ORIGINES[q.origine]) f.push(`origine « ${ORIGINES[q.origine]} »`);
  if (q.par) f.push(`matricule ${String(q.par).trim()}`);
  if (q.du) f.push(`du ${q.du.split('-').reverse().join('/')}`);
  if (q.au) f.push(`au ${q.au.split('-').reverse().join('/')}`);
  return f;
}

function nomFichier(extension) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `historique-emplacements-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${extension}`;
}

const maintenant = () => dateFr(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19));

// GET /api/stock/historique?reference=&emplacement=&origine=&du=&au= : les 500 derniers mouvements
router.get('/historique', async (req, res, next) => {
  try {
    res.json(await chargerHistorique(req.query));
  } catch (err) { next(err); }
});

// GET /api/stock/historique/excel : tout l'historique (mêmes filtres), fichier .xlsx
router.get('/historique/excel', async (req, res, next) => {
  try {
    const mouvements = await chargerHistorique(req.query, null);
    const classeur = new ExcelJS.Workbook();
    classeur.creator = 'Magasin Kablem';
    const feuille = classeur.addWorksheet('Historique', { views: [{ state: 'frozen', ySplit: 4 }] });
    const colonnes = [
      ['Date', 'date', 17], ['Référence', 'reference', 13], ['Lot', 'lot', 13], ['Type', 'type', 17],
      ['Quantité', 'quantite', 10], ['Colis', 'colis', 8], ['Depuis', 'depuis', 12], ['Vers', 'vers', 12], ['Départ libéré', 'libere', 13], ['Motif', 'motif', 34],
      ['Commentaire', 'commentaire', 40], ['Origine', 'origine', 20], ['Par', 'par', 22], ['Rôle', 'role', 17],
    ];
    feuille.columns = colonnes.map(([, key, width]) => ({ key, width }));

    // Titre et résumé
    feuille.mergeCells(1, 1, 1, colonnes.length);
    const titre = feuille.getCell('A1');
    titre.value = "Historique des changements d'emplacement";
    titre.font = { bold: true, size: 15, color: { argb: 'FF0D2150' } };
    feuille.getRow(1).height = 26;
    feuille.mergeCells(2, 1, 2, colonnes.length);
    const filtres = descriptionFiltres(req.query);
    feuille.getCell('A2').value =
      `Magasin Kablem · édité le ${maintenant()} · ${mouvements.length} mouvement(s)` +
      (filtres.length ? ` · filtres : ${filtres.join(', ')}` : '');
    feuille.getCell('A2').font = { size: 10, color: { argb: 'FF5A6276' } };

    const entete = feuille.getRow(4);
    entete.values = colonnes.map(([t]) => t);
    entete.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    entete.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D2150' } };
    entete.alignment = { vertical: 'middle' };
    entete.height = 22;

    mouvements.forEach((m, k) => {
      const ligne = feuille.addRow({
        date: dateFr(m.date),
        reference: m.reference,
        lot: m.lot,
        type: libelleType(m),
        quantite: m.quantite,
        colis: m.colis ?? '',
        depuis: m.depuis || 'non rangé',
        vers: m.vers || 'retiré',
        libere: m.depuis_liberee ? 'Oui' : '',
        motif: m.motif_libelle || '',
        commentaire: m.commentaire || '',
        origine: ORIGINES[m.origine],
        par: m.par || '',
        role: ROLES[m.role] || '',
      });
      ligne.alignment = { vertical: 'top', wrapText: true };
      if (k % 2) ligne.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6FA' } };
      ligne.getCell('reference').font = { bold: true };
      ligne.getCell('vers').font = { bold: true, color: { argb: 'FF1D6F42' } };
    });
    feuille.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: colonnes.length } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFichier('xlsx')}"`);
    await classeur.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// GET /api/stock/historique/pdf : tout l'historique (mêmes filtres), A4 paysage
router.get('/historique/pdf', async (req, res, next) => {
  try {
    const mouvements = await chargerHistorique(req.query, null);
    const doc = new PDFDocument({
      size: 'A4', layout: 'landscape', margin: 36, bufferPages: true,
      info: { Title: "Historique des changements d'emplacement", Author: 'Magasin Kablem' },
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFichier('pdf')}"`);
    doc.pipe(res);

    const NAVY = '#0d2150';
    const ROUGE = '#c81e1e';
    const VERT = '#1d6f42';
    const GRIS = '#5a6276';
    const gauche = doc.page.margins.left;
    const largeur = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bas = () => doc.page.height - doc.page.margins.bottom;

    // En-tête
    doc.rect(gauche, 30, largeur, 3).fill(ROUGE);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text("Historique des changements d'emplacement", gauche, 44);
    const filtres = descriptionFiltres(req.query);
    doc.fillColor(GRIS).font('Helvetica').fontSize(9.5).text(
      `Magasin Kablem · édité le ${maintenant()}` + (filtres.length ? ` · filtres : ${filtres.join(', ')}` : ''),
      gauche, 68
    );

    // Résumé : total et nombre par origine
    let y = 88;
    const cartes = [
      ['Mouvements', mouvements.length, NAVY],
      ...Object.entries(ORIGINES).map(([cle, nom], k) => [
        nom, mouvements.filter((m) => m.origine === cle).length, ['#1f6fd1', '#d4740b', VERT][k],
      ]),
    ];
    const lCarte = (largeur - 10 * (cartes.length - 1)) / cartes.length;
    cartes.forEach(([nom, n, couleur], k) => {
      const x = gauche + k * (lCarte + 10);
      doc.roundedRect(x, y, lCarte, 44, 6).fill('#f4f6fa');
      doc.rect(x, y, 4, 44).fill(couleur);
      doc.fillColor(couleur).font('Helvetica-Bold').fontSize(16).text(String(n), x + 14, y + 7, { width: lCarte - 20 });
      doc.fillColor(GRIS).font('Helvetica').fontSize(8.5).text(nom.toUpperCase(), x + 14, y + 28, { width: lCarte - 20 });
    });
    y += 60;

    const colonnes = [
      ['Date', 72], ['Référence', 60], ['Lot', 62], ['Type', 72], ['Qté', 32], ['Depuis » vers', 92],
      ['Motif', 150], ['Origine', 82], ['Par', 100],
    ];
    const echelle = largeur / colonnes.reduce((t, [, l]) => t + l, 0);
    const cols = colonnes.map(([t, l]) => [t, l * echelle]);

    const entete = () => {
      doc.rect(gauche, y, largeur, 20).fill(NAVY);
      let x = gauche;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
      cols.forEach(([t, l]) => {
        doc.text(t.toUpperCase(), x + 5, y + 6.5, { width: l - 10, lineBreak: false });
        x += l;
      });
      y += 20;
    };

    if (!mouvements.length) {
      doc.fillColor(GRIS).font('Helvetica').fontSize(11).text('Aucun mouvement pour ces critères.', gauche, y);
    } else {
      entete();
    }
    mouvements.forEach((m, k) => {
      const motif = (m.motif_libelle || '-') + (m.commentaire ? '\n' + m.commentaire : '');
      const par = (m.par || '-') + (ROLES[m.role] ? '\n' + ROLES[m.role] : '');
      doc.font('Helvetica').fontSize(8.5);
      const h = Math.max(
        doc.heightOfString(motif, { width: cols[6][1] - 10 }),
        doc.heightOfString(par, { width: cols[8][1] - 10 }),
        doc.heightOfString(libelleType(m), { width: cols[3][1] - 10 }),
        doc.heightOfString(m.colis ? `${m.lot}\ncolis ${m.colis}` : m.lot, { width: cols[2][1] - 10 }),
        11
      ) + 10;
      if (y + h > bas()) {
        doc.addPage();
        y = doc.page.margins.top;
        entete();
      }
      if (k % 2) doc.rect(gauche, y, largeur, h).fill('#f4f6fa');
      let x = gauche;
      const cellule = (texte, k2, options = {}) => {
        doc.font(options.gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(options.couleur ?? '#141a2b')
          .text(String(texte ?? ''), x + 5, y + 5, { width: cols[k2][1] - 10 });
        x += cols[k2][1];
      };
      cellule(dateFr(m.date), 0, { couleur: GRIS });
      cellule(m.reference, 1, { gras: true });
      cellule(m.colis ? `${m.lot}\ncolis ${m.colis}` : m.lot, 2);
      cellule(libelleType(m), 3);
      cellule(m.quantite, 4, { gras: true });
      // Trajet : ancien emplacement en gris, nouveau en vert
      const depuis = (m.depuis || 'non rangé') + (m.depuis_liberee ? ' (libéré)' : '');
      doc.font('Helvetica').fontSize(8.5).fillColor(GRIS).text(depuis + '  ', x + 5, y + 5, { width: cols[5][1] - 10, continued: true })
        .fillColor(GRIS).text('»  ', { continued: true })
        .font('Helvetica-Bold').fillColor(VERT).text(m.vers || 'retiré');
      x += cols[5][1];
      doc.font('Helvetica').fontSize(8.5).fillColor('#141a2b').text(m.motif_libelle || '-', x + 5, y + 5, { width: cols[6][1] - 10 });
      if (m.commentaire) doc.fillColor(GRIS).fontSize(8).text(m.commentaire, { width: cols[6][1] - 10 });
      x += cols[6][1];
      cellule(ORIGINES[m.origine], 7);
      doc.font('Helvetica').fontSize(8.5).fillColor('#141a2b').text(m.par || '-', x + 5, y + 5, { width: cols[8][1] - 10 });
      if (ROLES[m.role]) doc.fillColor(GRIS).fontSize(7.5).text(ROLES[m.role], { width: cols[8][1] - 10 });
      y += h;
      doc.moveTo(gauche, y).lineTo(gauche + largeur, y).lineWidth(0.5).strokeColor('#dde1ea').stroke();
    });

    // Pied de page : numéros de page
    const pages = doc.bufferedPageRange();
    for (let k = 0; k < pages.count; k++) {
      doc.switchToPage(pages.start + k);
      doc.page.margins.bottom = 0; // écrire sous la marge sans créer de nouvelle page
      doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Magasin Kablem · Historique des emplacements', gauche, doc.page.height - 26, { lineBreak: false });
      doc.text(`Page ${k + 1} / ${pages.count}`, gauche, doc.page.height - 26, { width: largeur, align: 'right', lineBreak: false });
    }
    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.lignesEnStock = lignesEnStock;
module.exports.poserQuantite = poserQuantite;
module.exports.placesReservees = placesReservees;
module.exports.occupation = occupation;
