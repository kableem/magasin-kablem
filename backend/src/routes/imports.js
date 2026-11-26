const express = require('express');
const db = require('../db');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const R = require('../rangement');
const { lignesEnStock, occupation, poserQuantite } = require('./stock');
const { parametresRangement } = require('../parametres');
const { estGestionnaire, exigerGestionnaire, exigerRole } = require('../middleware/auth');
const { lireMotif, enregistrerMouvements, enregistrerMouvement } = require('../historique');
const RI = require('../reception-import');
const { attribuerColis } = require('../affectations');
const { typesDuCatalogue, normaliserReference } = require('../articles');
const { capaciteTampon, modeReception } = require('../parametres');
const { typePalette, nommer } = require('../palettes');
const IR = require('../import-resume');
const { expirerPreparations } = require('../reservations');
const C = require('../cartons');
const P = require('../palettes-cosses');
const { pdfEtiquettesCartons } = require('../etiquettes');
const { integrerHorsImport } = require('../surplus');
const { lireFichierReferences } = require('../lire-excel');

const router = express.Router();

const TYPES = ['bobine', 'cosse', 'connecteur'];
const TAILLES_BOBINE = ['grande', 'moyenne', 'petite'];

// Ordre d'arrivée d'un import : date d'envoi de l'Italie, sinon date de création (puis numéro)
const ARRIVEE = 'COALESCE(i.date_envoi, i.date_creation)';

// Les imports sont ajoutés au stock dans l'ordre d'arrivée : on termine l'import le plus ancien
// avant de passer au suivant. Renvoie l'import plus ancien encore en attente, ou null.
async function importPrecedentEnAttente(connexion, importId) {
  const [[precedent]] = await connexion.query(
    `SELECT i.id, i.numero_livraison, DATE_FORMAT(${ARRIVEE}, '%Y-%m-%dT%H:%i:%s') AS arrivee
     FROM imports i
     JOIN imports cible ON cible.id = ?
     WHERE i.statut = 'en_attente' AND i.id <> cible.id
       AND (${ARRIVEE} < COALESCE(cible.date_envoi, cible.date_creation)
            OR (${ARRIVEE} = COALESCE(cible.date_envoi, cible.date_creation) AND i.id < cible.id))
     ORDER BY ${ARRIVEE}, i.id
     LIMIT 1`,
    [importId]
  );
  return precedent ?? null;
}

// Réception mobile dans l'ordre d'arrivée : on termine la réception de l'import le plus ancien
// avant de commencer la suivante. Renvoie l'import plus ancien dont la réception n'est pas terminée.
async function receptionPrecedenteNonTerminee(connexion, importId) {
  const [[precedent]] = await connexion.query(
    `SELECT i.id, i.numero_livraison, DATE_FORMAT(${ARRIVEE}, '%Y-%m-%dT%H:%i:%s') AS arrivee
     FROM imports i
     JOIN imports cible ON cible.id = ?
     WHERE i.statut = 'en_attente' AND i.reception <> 'terminee' AND i.id <> cible.id
       AND (${ARRIVEE} < COALESCE(cible.date_envoi, cible.date_creation)
            OR (${ARRIVEE} = COALESCE(cible.date_envoi, cible.date_creation) AND i.id < cible.id))
     ORDER BY ${ARRIVEE}, i.id
     LIMIT 1`,
    [importId]
  );
  return precedent ?? null;
}

const dateFr = (iso) => iso.slice(0, 10).split('-').reverse().join('/');
function messageOrdreReception(p) {
  return `Terminez d'abord la réception de l'import plus ancien ${p.numero_livraison ?? 'n° ' + p.id} (arrivé le ${dateFr(p.arrivee)}) : les imports se réceptionnent dans leur ordre d'arrivée.`;
}
function messageOrdre(p) {
  return `Terminez d'abord l'import plus ancien ${p.numero_livraison ? p.numero_livraison + ' ' : ''}(n° ${p.id}, arrivé le ${dateFr(p.arrivee)}) : les imports sont ajoutés au stock dans leur ordre d'arrivée.`;
}

// Charge un import et vérifie qu'il est encore modifiable
async function importEnAttente(id, res) {
  const [[imp]] = await db.query('SELECT id, statut FROM imports WHERE id = ?', [id]);
  if (!imp) {
    res.status(404).json({ message: 'Import introuvable' });
    return null;
  }
  if (imp.statut !== 'en_attente') {
    res.status(409).json({ message: 'Cet import est déjà ajouté au stock : il ne peut plus être modifié' });
    return null;
  }
  return imp;
}

// GET /api/imports : tous les imports (les plus récents d'abord) avec leurs produits
router.get('/', async (req, res, next) => {
  try {
    const [imports] = await db.query(
      `SELECT i.id, i.statut, i.mode, i.emballage, i.reception, i.reception_ecarts, i.ajout_force, i.motif_force, i.source_id, i.numero_livraison,
              DATE_FORMAT(i.reception_debut, '%Y-%m-%dT%H:%i:%s') AS reception_debut,
              DATE_FORMAT(i.reception_fin, '%Y-%m-%dT%H:%i:%s') AS reception_fin,
              rp.matricule AS reception_par,
              DATE_FORMAT(i.date_envoi, '%Y-%m-%dT%H:%i:%s') AS date_envoi,
              DATE_FORMAT(i.date_creation, '%Y-%m-%dT%H:%i:%s') AS date_creation,
              DATE_FORMAT(i.date_ajout_stock, '%Y-%m-%dT%H:%i:%s') AS date_ajout_stock,
              c.matricule AS cree_par,
              a.matricule AS ajoute_par
       FROM imports i
       LEFT JOIN utilisateurs c ON c.id = i.cree_par
       LEFT JOIN utilisateurs a ON a.id = i.ajoute_par
       LEFT JOIN utilisateurs rp ON rp.id = i.reception_par
       ORDER BY i.date_creation DESC, i.id DESC`
    );
    const [lignes] = await db.query(
      `SELECT r.id, r.import_id, r.type, r.taille_bobine, r.type_cosse, r.reference, r.lot, r.quantite,
              r.longueur, r.largeur, r.hauteur, r.poids, r.commentaire,
              rc.quantite AS rc_quantite, rc.motif AS rc_motif, rc.commentaire AS rc_commentaire,
              DATE_FORMAT(rc.date_creation, '%Y-%m-%dT%H:%i:%s') AS rc_date,
              u.matricule AS rc_par
       FROM receptions r
       LEFT JOIN reclamations rc ON rc.reception_id = r.id
       LEFT JOIN utilisateurs u ON u.id = rc.utilisateur_id
       ORDER BY r.id`
    );

    // Ordre d'arrivée : seul l'import en attente le plus ancien peut être ajouté au stock
    const [enAttente] = await db.query(
      `SELECT i.id, i.numero_livraison, DATE_FORMAT(${ARRIVEE}, '%Y-%m-%dT%H:%i:%s') AS arrivee
       FROM imports i WHERE i.statut = 'en_attente' ORDER BY ${ARRIVEE}, i.id`
    );
    const premier = enAttente[0];
    const rang = new Map(enAttente.map((e, k) => [e.id, k + 1]));
    const parImport = new Map(
      imports.map((i) => [
        i.id,
        {
          ...i,
          produits: [],
          ordre_attente: rang.get(i.id) ?? null, // 1 = le prochain à ajouter au stock
          bloque_par: i.statut === 'en_attente' && premier && premier.id !== i.id
            ? { id: premier.id, numero_livraison: premier.numero_livraison, arrivee: premier.arrivee }
            : null,
        },
      ])
    );
    // Emplacement imposé de chaque colis (lignes dont la réception est validée)
    const [affectations] = await db.query(
`SELECT a.id, a.reception_id, a.colis, a.emplacement, a.range_le IS NOT NULL AS est_range, p.numero AS palette
       FROM affectations_colis a LEFT JOIN palettes_reception p ON p.id = a.palette_id ORDER BY a.colis, a.id`
    );
    const parLigne = new Map();
    for (const a of affectations) {
      parLigne.set(a.reception_id, [...(parLigne.get(a.reception_id) ?? []), { id: a.id, colis: a.colis, emplacement: a.emplacement, range: !!a.est_range, palette: a.palette }]);
    }
    // Réception mobile : colis reçus / attendus, écarts, rangement
    const av = await RI.avancement(db, imports.map((i) => i.id));
    for (const l of lignes) {
      const suivi = av.get(l.import_id)?.lignes.get(l.id);
      parImport.get(l.import_id)?.produits.push({
        ...avecReclamation(avecMesures(l)),
        recus: suivi?.recus ?? 0, en_trop: suivi?.en_trop ?? 0, ranges: suivi?.ranges ?? 0,
        colis_recus: suivi?.colis_recus ?? [], colis_en_trop: suivi?.colis_en_trop ?? [], colis_ranges: suivi?.colis_ranges ?? [],
        affectations: parLigne.get(l.id) ?? [],
      });
    }
    // Palettes de cosses (cartons et cosses séparées), cartons, et produits hors import en attente du catalogue Articles
    const [cartons] = await db.query(`${C.SELECT_CARTON} ORDER BY c.import_id, c.numero`);
    for (const c of cartons) {
      const i = parImport.get(c.import_id);
      if (i) i.cartons = [...(i.cartons ?? []), await C.vueCarton(db, c)];
    }
    const [palettesCosses] = await db.query(`${P.SELECT_PALETTE} ORDER BY p.import_id, p.numero`);
    for (const p of palettesCosses) {
      const i = parImport.get(p.import_id);
      if (i) i.palettes_cosses = [...(i.palettes_cosses ?? []), await P.vuePalette(db, p)];
    }
    const [horsImport] = await db.query(
      `SELECT import_id, reference, COUNT(*) AS n FROM controles_mobile
       WHERE controle = 'reception' AND resultat = 'inconnu' AND reference IS NOT NULL AND reception_id IS NULL AND import_id IS NOT NULL
       GROUP BY import_id, reference`
    );
    for (const h of horsImport) {
      const i = parImport.get(h.import_id);
      if (i?.reception === 'terminee') i.hors_import_en_attente = [...(i.hors_import_en_attente ?? []), { reference: h.reference, colis: Number(h.n) }];
    }
    // Sorties urgentes : colis sortis vers la production pendant la réception (ou posés, en attente de sortie)
    const [urgences] = await db.query(
      `SELECT u.id, u.import_id, u.reception_id, u.colis, u.reference, u.lot, u.destination, u.statut, u.emplacement, u.stock_existant, u.export_id,
              m.matricule AS par, a.matricule AS autorise_par,
              DATE_FORMAT(u.date_demande, '%Y-%m-%dT%H:%i:%s') AS date_demande,
              DATE_FORMAT(u.date_sortie, '%Y-%m-%dT%H:%i:%s') AS date_sortie
       FROM sorties_urgentes u
       LEFT JOIN utilisateurs m ON m.id = u.utilisateur_id
       LEFT JOIN utilisateurs a ON a.id = u.autorise_par
       WHERE u.statut <> 'annulee' OR u.date_posee IS NOT NULL
       ORDER BY u.date_demande, u.id`
    );
    for (const u of urgences) {
      const i = parImport.get(u.import_id);
      if (i) i.urgences = [...(i.urgences ?? []), u];
    }
    for (const i of parImport.values()) {
      i.cartons = i.cartons ?? [];
      i.palettes_cosses = i.palettes_cosses ?? [];
      i.hors_import_en_attente = i.hors_import_en_attente ?? [];
      i.urgences = i.urgences ?? [];
      const a = av.get(i.id);
      i.ajout_force = !!i.ajout_force;
      i.etape = RI.etape(i, a);
      i.avancement = a && { attendus: a.attendus, recus: a.recus, manquants: a.manquants, en_trop: a.en_trop, hors_import: a.hors_import, ranges: a.ranges, colis_recus: a.colis_recus, anomalies: RI.anomaliesAffichees(i, a) };
      // Import résumé : références annoncées (total de pièces) et ce qui en est reçu
      i.pieces = a?.pieces ?? null;
    }
    res.json([...parImport.values()]);
  } catch (err) { next(err); }
});

// PUT /api/imports/affectations/:id  { emplacement, motif, commentaire? }
// Le chef (ou l'administrateur) change l'emplacement imposé d'un colis pas encore rangé, avec un motif.
// La place réservée suit ; le changement est noté dans l'historique des emplacements.
router.put('/affectations/:id', exigerGestionnaire(), async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion);
    await connexion.beginTransaction();
    const refuser = async (status, message) => {
      await connexion.rollback();
      res.status(status).json({ message });
    };
    const [[a]] = await connexion.query(
      'SELECT a.id, a.reception_id, a.palette_id, a.colis, a.emplacement, a.range_le FROM affectations_colis a WHERE a.id = ? FOR UPDATE',
      [req.params.id]
    );
    if (!a) return refuser(404, 'Colis introuvable');
    if (a.range_le) return refuser(409, `Le colis n° ${a.colis} est déjà rangé en ${a.emplacement} : changez son emplacement dans Gestion de stock.`);
    const code = String(req.body?.emplacement ?? '').trim().toUpperCase();
    if (!R.emplacementValide(code, await capaciteTampon(connexion))) return refuser(400, `L'emplacement « ${code} » n'existe pas dans le magasin`);
    if (code === a.emplacement) return refuser(400, `Le colis n° ${a.colis} va déjà en ${code}`);
    const motif = lireMotif(req.body);
    if (motif.erreur) return refuser(400, motif.erreur);
    // Palette entière (réception par palette) : tous ses colis pas encore posés changent ensemble
    const [[palette]] = a.palette_id
      ? await connexion.query('SELECT id, numero, mode, type, taille FROM palettes_reception WHERE id = ? FOR UPDATE', [a.palette_id])
      : [[null]];
    const enBloc = palette?.mode === 'entiere';
    const [cibles] = await connexion.query(
      `SELECT a.id, a.reception_id, a.colis, a.emplacement, r.reference, r.lot, r.type, r.taille_bobine, r.type_cosse,
              r.longueur, r.largeur, r.hauteur, r.poids
       FROM affectations_colis a JOIN receptions r ON r.id = a.reception_id
       WHERE ${enBloc ? 'a.palette_id = ? AND a.range_le IS NULL' : 'a.id = ?'} FOR UPDATE`,
      [enBloc ? palette.id : a.id]
    );
    // La nouvelle place doit pouvoir recevoir ces produits (règles du magasin, stock et places réservées)
    const nombre = (v) => (v === null ? null : Number(v));
    const parLigne = new Map();
    for (const c of cibles) {
      const l = parLigne.get(c.reception_id) ?? {
        id: c.reception_id, type: c.type, taille_bobine: c.taille_bobine, type_cosse: c.type_cosse, reference: c.reference, lot: c.lot, quantite: 0,
        longueur: nombre(c.longueur), largeur: nombre(c.largeur), hauteur: nombre(c.hauteur), poids: nombre(c.poids),
      };
      l.quantite++;
      parLigne.set(c.reception_id, l);
    }
    const produits = [...parLigne.values()];
    const { capaciteTampon: capacite } = await parametresRangement(connexion);
    const enPlace = (await occupation(connexion, true)).filter((l) => l.emplacement);
    const refus = R.verifierPlan(produits.map((p) => ({ id: p.id, emplacement: code, quantite: p.quantite })), produits, enPlace, capacite);
    if (refus) return refuser(409, refus);
    if (!a.palette_id) {
      // Plan de rangement (validation de la réception) : la place réservée suit le colis
      await connexion.query('UPDATE plans_rangement SET quantite = quantite - 1 WHERE reception_id = ? AND emplacement = ?', [a.reception_id, a.emplacement]);
      await connexion.query('DELETE FROM plans_rangement WHERE reception_id = ? AND emplacement = ? AND quantite <= 0', [a.reception_id, a.emplacement]);
      await connexion.query(
        `INSERT INTO plans_rangement (reception_id, emplacement, quantite) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE quantite = quantite + 1`,
        [a.reception_id, code]
      );
    }
    await connexion.query('UPDATE affectations_colis SET emplacement = ? WHERE id IN (?)', [code, cibles.map((c) => c.id)]);
    if (enBloc) await connexion.query('UPDATE palettes_reception SET emplacement = ? WHERE id = ?', [code, palette.id]);
    const quoi = enBloc
      ? `Palette ${palette.numero} (${nommer(typePalette(palette), cibles.length)})`
      : `Colis n° ${a.colis}`;
    await enregistrerMouvements(connexion, produits.map((p) => ({
      origine: 'plan_import', ligne: { ...p, reception_id: p.id }, quantite: p.quantite, depuis: a.emplacement, vers: code,
      motif: motif.motif, commentaire: motif.commentaire ? `${quoi} : ${motif.commentaire}` : quoi,
      utilisateurId: req.utilisateur.id,
    })));
    await connexion.commit();
    res.json({ id: a.id, colis: a.colis, depuis: a.emplacement, emplacement: code, palette: palette?.numero ?? null, bobines: cibles.length });
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

// ---------- Synchronisation avec la base de l'Italie ----------
//
// Les imports viennent de l'Italie (tables italie_imports / italie_produits, en attendant l'accès
// à la vraie base). « Synchroniser » copie chaque import italien pas encore présent dans
// l'application : il arrive « en attente », avec ses produits, et suit ensuite le circuit habituel
// (réclamations, plan de rangement, ajout au stock). Un import italien n'est jamais copié deux fois.
// Un import dont un produit est invalide n'est pas copié : il est signalé pour correction.

// Contrôle d'un produit italien ; renvoie la raison du refus ou null
function erreurProduitItalie(p) {
  if (!p.type) return `référence ${p.reference} absente du catalogue Articles (page Articles) : type inconnu`;
  if (!TYPES.includes(p.type)) return `type « ${p.type} » inconnu`;
  if (p.type === 'bobine' && !TAILLES_BOBINE.includes(p.taille_bobine)) return `bobine ${p.reference} sans taille`;
  if (!String(p.reference || '').trim() || !String(p.lot || '').trim()) return 'référence ou lot manquant';
  if (!Number.isInteger(Number(p.quantite)) || Number(p.quantite) <= 0) return `quantité invalide pour ${p.reference}`;
  return null;
}

// GET /api/imports/synchronisation : imports italiens pas encore récupérés
router.get('/synchronisation', async (req, res, next) => {
  try {
    const [[{ disponibles }]] = await db.query(
      `SELECT COUNT(*) AS disponibles FROM italie_imports
       WHERE id NOT IN (SELECT source_id FROM imports WHERE source_id IS NOT NULL)
         AND id NOT IN (SELECT source_id FROM imports_supprimes WHERE source_id IS NOT NULL)`
    );
    const [lignes] = await db.query(
      "SELECT DATE_FORMAT(valeur, '%Y-%m-%dT%H:%i:%s') AS derniere FROM parametres WHERE cle = 'derniere_synchronisation'"
    );
    res.json({ disponibles: Number(disponibles), derniere_synchronisation: lignes[0]?.derniere ?? null });
  } catch (err) { next(err); }
});

// Copie les imports italiens pas encore présents (seulement : ids italiens à copier, sinon tous).
// Le type vient du catalogue Articles d'après la référence. Renvoie { ajoutes, ignores }.
async function copierImportsItalie(connexion, utilisateurId, seulement = null) {
  const [nouveaux] = await connexion.query(
    `SELECT id, numero, DATE_FORMAT(date_envoi, '%Y-%m-%d %H:%i:%s') AS date_envoi
     FROM italie_imports
     WHERE id NOT IN (SELECT source_id FROM imports WHERE source_id IS NOT NULL)
       AND id NOT IN (SELECT source_id FROM imports_supprimes WHERE source_id IS NOT NULL) -- supprimé par l'administrateur
       ${seulement ? 'AND id IN (?)' : ''}
     ORDER BY date_envoi, id`,
    seulement ? [seulement] : []
  );
  const ajoutes = [];
  const ignores = [];
  for (const it of nouveaux) {
    const [brut] = await connexion.query('SELECT * FROM italie_produits WHERE italie_import_id = ? ORDER BY id', [it.id]);
    // Le type vient du catalogue Articles d'après la référence (l'Italie ne le donne pas) ;
    // une référence absente du catalogue garde le type éventuel de l'Italie.
    // La taille d'une bobine vient du catalogue (bobines par palette), sauf si l'Italie la donne pour cette livraison.
    const catalogue = await typesDuCatalogue(connexion, brut.map((p) => p.reference));
    const produits = brut.map((p) => {
      const c = catalogue.get(normaliserReference(p.reference));
      return c ? { ...p, ...c, taille_bobine: c.type === 'bobine' ? (p.taille_bobine ?? c.taille_bobine) : null } : p;
    });
    if (!produits.length) {
      ignores.push({ numero: it.numero, raison: 'aucun produit' });
      continue;
    }
    const erreur = produits.map((p) => erreurProduitItalie(p)).find(Boolean);
    if (erreur) {
      ignores.push({ numero: it.numero, raison: erreur });
      continue;
    }
    const [r] = await connexion.query(
      `INSERT INTO imports (source_id, numero_livraison, date_envoi, statut, date_creation, cree_par)
       VALUES (?, ?, ?, 'en_attente', NOW(), ?)`,
      [it.id, it.numero, it.date_envoi, utilisateurId]
    );
    let nbProduits = 0;
    for (const p of produits) {
      const reference = normaliserReference(p.reference);
      const lot = String(p.lot).trim().toUpperCase();
      // Connecteur : une ligne par carton (une ligne de quantité N = N cartons identiques)
      const lignes = p.type === 'connecteur' ? Number(p.quantite) : 1;
      for (let k = 0; k < lignes; k++) {
        await connexion.query(
          `INSERT INTO receptions (import_id, type, taille_bobine, type_cosse, reference, lot, date_reception, quantite,
                                   longueur, largeur, hauteur, poids, utilisateur_id)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?)`,
          [
            r.insertId, p.type, p.type === 'bobine' ? p.taille_bobine : null, p.type === 'cosse' ? (p.type_cosse ?? 'plat') : null, reference, lot,
            p.type === 'connecteur' ? 1 : Number(p.quantite),
            p.type === 'connecteur' ? p.longueur : null, p.type === 'connecteur' ? p.largeur : null,
            p.type === 'connecteur' ? p.hauteur : null, p.type === 'connecteur' ? p.poids : null,
            utilisateurId,
          ]
        );
        nbProduits++;
      }
    }
    ajoutes.push({ id: r.insertId, numero: it.numero, produits: nbProduits });
  }
  return { ajoutes, ignores };
}

// POST /api/imports/synchroniser : copie les nouveaux imports italiens (tous les rôles)
router.post('/synchroniser', async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion); // deux synchronisations au même moment passent l'une après l'autre
    await connexion.beginTransaction();
    const resultat = await copierImportsItalie(connexion, req.utilisateur.id);
    await connexion.query(
      "INSERT INTO parametres (cle, valeur) VALUES ('derniere_synchronisation', NOW()) ON DUPLICATE KEY UPDATE valeur = NOW()"
    );
    await connexion.commit();
    res.json(resultat);
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

// POST /api/imports/manuel (administrateur) : saisie d'un import à la main, pour les essais.
//   { numero, produits: [{ reference, lot, quantite, longueur?, largeur?, hauteur?, poids? }] }
// Il est enregistré comme un import venu de l'Italie, puis copié aussitôt dans l'application :
// même circuit (type d'après le catalogue Articles, ordre d'arrivée, réception mobile, rangement).
router.post('/manuel', exigerRole('admin'), async (req, res, next) => {
  const numero = String(req.body?.numero ?? '').trim().toUpperCase();
  if (numero.length < 3 || numero.length > 50) return res.status(400).json({ message: 'Indiquez le n° de livraison (3 à 50 caractères)' });
  const liste = Array.isArray(req.body?.produits) ? req.body.produits : [];
  if (!liste.length) return res.status(400).json({ message: 'Ajoutez au moins un produit' });
  if (liste.length > 100) return res.status(400).json({ message: '100 lignes au maximum' });
  const nombre = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const produits = liste.map((p) => ({
    reference: normaliserReference(p?.reference),
    lot: String(p?.lot ?? '').trim().toUpperCase(),
    quantite: Number(p?.quantite),
    longueur: nombre(p?.longueur), largeur: nombre(p?.largeur), hauteur: nombre(p?.hauteur), poids: nombre(p?.poids),
  }));
  for (const [k, p] of produits.entries()) {
    const ligne = `Ligne ${k + 1}`;
    if (!p.reference) return res.status(400).json({ message: `${ligne} : référence manquante` });
    if (!p.lot) return res.status(400).json({ message: `${ligne} (${p.reference}) : lot manquant` });
    if (!Number.isInteger(p.quantite) || p.quantite <= 0 || p.quantite > 1000) {
      return res.status(400).json({ message: `${ligne} (${p.reference}) : quantité invalide (nombre entier de 1 à 1000)` });
    }
  }
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion);
    await connexion.beginTransaction();
    const refuser = async (status, message) => {
      await connexion.rollback();
      res.status(status).json({ message });
    };
    const [[deja]] = await connexion.query(
      'SELECT 1 AS ok FROM italie_imports WHERE numero = ? UNION SELECT 1 FROM imports WHERE numero_livraison = ? LIMIT 1',
      [numero, numero]
    );
    if (deja) return refuser(409, `Le n° de livraison ${numero} existe déjà`);
    // Le type de chaque référence doit être connu du catalogue
    const catalogue = await typesDuCatalogue(connexion, produits.map((p) => p.reference));
    const inconnues = [...new Set(produits.filter((p) => !catalogue.has(p.reference)).map((p) => p.reference))];
    if (inconnues.length) {
      return refuser(400, `Référence(s) absente(s) du catalogue Articles : ${inconnues.join(', ')}. Ajoutez-les dans la page Articles.`);
    }
    const [it] = await connexion.query(
      'INSERT INTO italie_imports (numero, date_envoi, commentaire) VALUES (?, NOW(), ?)',
      [numero, `Saisie manuelle (matricule ${req.utilisateur.matricule})`]
    );
    for (const p of produits) {
      await connexion.query(
        `INSERT INTO italie_produits (italie_import_id, type, taille_bobine, reference, lot, quantite, longueur, largeur, hauteur, poids)
         VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [it.insertId, p.reference, p.lot, p.quantite, p.longueur, p.largeur, p.hauteur, p.poids]
      );
    }
    const { ajoutes, ignores } = await copierImportsItalie(connexion, req.utilisateur.id, [it.insertId]);
    if (!ajoutes.length) return refuser(400, ignores[0]?.raison ?? "L'import n'a pas pu être créé");
    await connexion.commit();
    res.status(201).json(ajoutes[0]);
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

// ---------- Import résumé : référence + total de pièces (fichier de l'Italie sans lot ni colis) ----------
//
// Le chef (ou l'administrateur) colle les lignes « Codice / Somma di quantità » copiées depuis Excel ou le PDF.
// L'import arrive « en attente » ; à la réception mobile, chaque ticket scanné crée la ligne référence + lot
// et ses pièces s'ajoutent au compteur de la référence. Le type vient du catalogue Articles.

// Lignes collées -> références lues, avec leur type d'après le catalogue, et les problèmes à corriger
async function lireImportResume(connexion, texte) {
  // références du catalogue : une ligne « STAFFA 048290111 1 200 » se coupe après la référence connue
  const [articles] = await connexion.query('SELECT reference FROM articles_mp');
  const connues = new Set(articles.map((x) => normaliserReference(x.reference)));
  const { lignes, erreurs, erreursLignes } = IR.lireTexte(texte, connues);
  const catalogue = await typesDuCatalogue(connexion, lignes.map((l) => l.reference));
  const references = lignes.map((l) => ({ ...l, ...(catalogue.get(l.reference) ?? { type: null, taille_bobine: null, type_cosse: null }) }));
  const inconnues = references.filter((r) => !r.type).map((r) => r.reference);
  const problemes = [...erreurs];
  if (!references.length && !erreurs.length) problemes.push('Aucune ligne « référence + quantité » trouvée dans le texte collé');
  if (inconnues.length) problemes.push(`Référence(s) absente(s) du catalogue Articles : ${inconnues.join(', ')}. Ajoutez-les dans la page Articles (type : cosse plate ou axiale, bobine…).`);
  return { references, problemes, erreurs_lignes: erreursLignes, total: references.reduce((t, r) => t + r.pieces, 0) };
}

// POST /api/imports/resume/fichier?nom=PackingKLTN_291026.xlsx  (corps : le fichier, application/octet-stream)
// Fichier de l'Italie (Excel .xlsx ou .xls, ou .csv) → lignes « référence <tab> quantité », à vérifier dans l'aperçu
router.post('/resume/fichier', exigerGestionnaire(), express.raw({ type: '*/*', limit: '15mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ message: 'Fichier vide' });
    const r = await lireFichierReferences(req.body, req.query.nom);
    if (!r.lignes) return res.status(400).json({ message: "Aucune ligne « référence + quantité » trouvée dans ce fichier (colonnes « Codice » et « Somma di quantità »)." });
    res.json(r);
  } catch (err) {
    if (!err.status) err.message = `Fichier illisible : ${err.message}`;
    if (!err.status) err.status = 400;
    next(err);
  }
});

// POST /api/imports/resume/apercu  { texte } : ce qui sera créé, sans rien enregistrer
router.post('/resume/apercu', exigerGestionnaire(), async (req, res, next) => {
  try {
    res.json(await lireImportResume(db, req.body?.texte));
  } catch (err) { next(err); }
});

// POST /api/imports/resume  { numero, date_envoi?, texte }
router.post('/resume', exigerGestionnaire(), async (req, res, next) => {
  const numero = String(req.body?.numero ?? '').trim().toUpperCase();
  if (numero.length < 3 || numero.length > 50) return res.status(400).json({ message: 'Indiquez le n° de livraison (3 à 50 caractères)' });
  const dateEnvoi = String(req.body?.date_envoi ?? '').trim();
  if (dateEnvoi && !/^\d{4}-\d{2}-\d{2}$/.test(dateEnvoi)) return res.status(400).json({ message: "Date d'envoi invalide (AAAA-MM-JJ)" });
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion);
    await connexion.beginTransaction();
    const refuser = async (status, message) => {
      await connexion.rollback();
      res.status(status).json({ message });
    };
    const [[deja]] = await connexion.query(
      'SELECT 1 AS ok FROM italie_imports WHERE numero = ? UNION SELECT 1 FROM imports WHERE numero_livraison = ? LIMIT 1',
      [numero, numero]
    );
    if (deja) return refuser(409, `Le n° de livraison ${numero} existe déjà`);
    const { references, problemes } = await lireImportResume(connexion, req.body?.texte);
    if (problemes.length) return refuser(400, problemes.join(' '));
    const [r] = await connexion.query(
      `INSERT INTO imports (numero_livraison, mode, date_envoi, statut, date_creation, cree_par)
       VALUES (?, 'resume', ?, 'en_attente', NOW(), ?)`,
      [numero, dateEnvoi ? `${dateEnvoi} 00:00:00` : null, req.utilisateur.id]
    );
    for (const ref of references) {
      await connexion.query(
        `INSERT INTO imports_attendus (import_id, reference, type, taille_bobine, type_cosse, pieces)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [r.insertId, ref.reference, ref.type, ref.type === 'bobine' ? ref.taille_bobine : null, ref.type === 'cosse' ? (ref.type_cosse ?? 'plat') : null, ref.pieces]
      );
    }
    await connexion.commit();
    res.status(201).json({ id: r.insertId, numero, references: references.length, pieces: references.reduce((t, x) => t + x.pieces, 0) });
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

// POST /api/imports : nouvel import (arrivage), en attente
router.post('/', async (req, res, next) => {
  try {
    const [result] = await db.query(
      "INSERT INTO imports (statut, date_creation, cree_par) VALUES ('en_attente', NOW(), ?)",
      [req.utilisateur.id]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) { next(err); }
});

// ---------- Étiquettes des cartons de cosses ----------
// QR : « référence;lot;pièces;JJ/MM/AAAA HH:MM:SS.mmm ». La date est celle de la 1re impression (date système),
// unique à la milliseconde ; une réimpression redonne exactement la même étiquette.

// Donne leur date aux cartons qui n'en ont pas, puis écrit le PDF (une étiquette par page).
// Les cartons sont rangés palette par palette ; avec plusieurs cartons, une page « PALETTE N° X » sépare les palettes,
// et chaque étiquette porte le numéro de sa palette : le magasinier sait sur quelle palette coller chaque étiquette.
async function imprimerCartons(cartons, res) {
  cartons = [...cartons].sort((a, b) => (a.palette_numero ?? 1e9) - (b.palette_numero ?? 1e9) || a.numero - b.numero);
  const connexion = await db.getConnection();
  const pages = [];
  try {
    await verrouillerStock(connexion);
    await connexion.beginTransaction();
    for (const brut of cartons) {
      let c = brut;
      if (!c.date_etiquette) {
        const date = await C.nouvelleDateEtiquette(connexion);
        await connexion.query('UPDATE cartons SET date_etiquette = ? WHERE id = ?', [date, c.id]);
        c = { ...c, date_etiquette: date };
      }
      const vue = await C.vueCarton(connexion, c);
      const [[imp]] = await connexion.query('SELECT numero_livraison FROM imports WHERE id = ?', [c.import_id]);
      pages.push({ ...vue, palette_numero: c.palette_numero ?? null, numero_livraison: imp.numero_livraison, pieces: vue.pieces ?? 0, qr: C.qrCarton({ ...c, pieces: vue.pieces ?? 0 }) });
    }
    await connexion.commit();
  } catch (err) {
    await connexion.rollback();
    throw err;
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="etiquettes-cartons-${pages.map((p) => p.numero).join('-').slice(0, 60)}.pdf"`);
  res.setHeader('X-Etiquettes', String(pages.length));
  await pdfEtiquettesCartons(pages, res, { separateurs: pages.length > 1 });
}

// POST /api/imports/cartons/:id/etiquette : étiquette d'un carton terminé (ou réimpression)
router.post('/cartons/:id/etiquette', async (req, res, next) => {
  try {
    const [[c]] = await db.query(`${C.SELECT_CARTON} WHERE c.id = ?`, [req.params.id]);
    if (!c) return res.status(404).json({ message: 'Carton introuvable' });
    if (c.statut === 'ouvert') return res.status(409).json({ message: `Le carton n° ${c.numero} est encore ouvert : terminez-le sur le mobile avant d'imprimer son étiquette.` });
    await imprimerCartons([c], res);
  } catch (err) { next(err); }
});

// POST /api/imports/:id/cartons/etiquettes : les étiquettes pas encore imprimées de l'import (sinon toutes)
// Import détaillé (une ligne par référence et lot) : même tableau que le pointage par référence, en produits
function pointageDetaille(a) {
  const references = [...a.lignes.values()].map((l) => {
    const recues = l.recus + l.en_trop;
    const ecart = recues - l.attendue;
    return {
      reference: l.reference, type: l.type, taille_bobine: l.taille_bobine, type_cosse: l.type_cosse,
      attendues: l.attendue, recues, colis: recues, ecart,
      lots: recues ? [{ lot: l.lot, colis: recues }] : [{ lot: l.lot, colis: 0 }],
      statut: recues === 0 ? 'non_recue' : ecart === 0 ? 'conforme' : ecart < 0 ? 'manquant' : 'en_trop',
    };
  });
  return {
    references,
    attendues: references.reduce((t, r) => t + r.attendues, 0),
    recues: references.reduce((t, r) => t + r.recues, 0),
    a_reclamer: references.filter((r) => r.statut !== 'conforme').length,
  };
}

// GET /api/imports/:id/pointage/pdf : pointage d'un import (annoncées, reçues, écart, lots, bilan), en PDF.
// Import par référence : en pièces ; import détaillé : en produits (une ligne par référence et lot).
router.get('/:id/pointage/pdf', async (req, res, next) => {
  try {
    const [[imp]] = await db.query('SELECT id, numero_livraison, mode, date_creation FROM imports WHERE id = ?', [req.params.id]);
    if (!imp) return res.status(404).json({ message: 'Import introuvable' });
    const a = (await RI.avancement(db, [imp.id])).get(imp.id);
    const pointage = imp.mode === 'resume' ? a.pieces : pointageDetaille(a);
    if (!pointage.references.length) return res.status(404).json({ message: 'Cet import est vide : rien à mettre dans le PDF.' });
    const nom = String(imp.numero_livraison ?? `import-${imp.id}`).replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pointage-${nom}.pdf"`);
    require('../pointage-pdf').pdfPointage(res, imp, pointage, {}, imp.mode === 'resume' ? a.colis_recus : pointage.recues);
  } catch (err) { next(err); }
});

// { palette_id } (facultatif) : seulement les cartons de cette palette (pas encore imprimés, sinon tous)
router.post('/:id/cartons/etiquettes', async (req, res, next) => {
  try {
    const paletteId = Number(req.body?.palette_id) > 0 ? Number(req.body.palette_id) : null;
    const [cartons] = await db.query(
      `${C.SELECT_CARTON} WHERE c.import_id = ? AND c.statut <> 'ouvert' ${paletteId ? 'AND c.palette_id = ?' : ''} ORDER BY c.numero`,
      paletteId ? [req.params.id, paletteId] : [req.params.id]
    );
    if (!cartons.length) {
      return res.status(404).json({ message: paletteId ? 'Aucun carton terminé sur cette palette.' : "Aucun carton terminé dans cet import : terminez les cartons sur le mobile." });
    }
    const nouvelles = cartons.filter((c) => !c.date_etiquette);
    await imprimerCartons(nouvelles.length ? nouvelles : cartons, res);
  } catch (err) { next(err); }
});

// POST /api/imports/:id/hors-import : produits reçus hors import dont la référence a été ajoutée au catalogue
// Articles depuis la réception : ils entrent au stock (une ligne d'import chacun ; le plan de rangement suit
// si l'import est déjà au stock). Leur réclamation existe déjà.
router.post('/:id/hors-import', exigerGestionnaire(), async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion);
    await connexion.beginTransaction();
    const [[imp]] = await connexion.query('SELECT id, statut, reception FROM imports WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!imp) {
      await connexion.rollback();
      return res.status(404).json({ message: 'Import introuvable' });
    }
    if (imp.reception !== 'terminee') {
      await connexion.rollback();
      return res.status(409).json({ message: "La réception mobile de cet import n'est pas terminée." });
    }
    const r = await integrerHorsImport(connexion, imp.id, req.utilisateur.id);
    if (imp.statut === 'ajoute' && r.integres.length) {
      // Import déjà au stock : places réservées pour ces nouvelles lignes (hors cartons), puis emplacement de chaque colis
      const ids = new Set(r.integres.map((x) => x.id));
      const produits = (await produitsImport(connexion, imp.id)).filter((p) => ids.has(p.id));
      const enPlace = (await occupation(connexion, true)).filter((l) => l.emplacement);
      for (const p of R.proposerPlan(produits, enPlace, await parametresRangement(connexion))) {
        if (!p.emplacement) await poserQuantite(connexion, p.id, null, p.quantite);
        else {
          await connexion.query(
            `INSERT INTO plans_rangement (reception_id, emplacement, quantite, ranges) VALUES (?, ?, ?, 0)
             ON DUPLICATE KEY UPDATE quantite = quantite + VALUES(quantite)`,
            [p.id, p.emplacement, p.quantite]
          );
        }
      }
      for (const p of produits) await attribuerColis(connexion, p.id);
    }
    await connexion.commit();
    res.json(r);
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

// ---------- Suppression d'un import (administrateur) ----------
//
// L'administrateur peut supprimer n'importe quel import, en attente ou déjà au stock. Sont effacés : l'import,
// ses lignes, ses produits encore en stock, ses réclamations, ses palettes et plans de rangement.
// Sont gardés : l'historique des sorties (export_details) et des déplacements, les scans du mobile.
// Traçabilité : motif obligatoire, copie JSON de l'import (imports_supprimes), retrait du stock noté dans
// l'historique des emplacements. Refusé si une sortie en cours sur le mobile utilise ses produits.

// Ce que la suppression effacerait (verrou : dans la transaction de la suppression)
async function bilanSuppression(connexion, id, verrou = false) {
  const [[imp]] = await connexion.query(
    `SELECT id, source_id, numero_livraison, mode, statut, reception,
            DATE_FORMAT(date_creation, '%Y-%m-%dT%H:%i:%s') AS date_creation
     FROM imports WHERE id = ? ${verrou ? 'FOR UPDATE' : ''}`,
    [id]
  );
  if (!imp) return null;
  await expirerPreparations(connexion);
  const [lignes] = await connexion.query('SELECT * FROM receptions WHERE import_id = ? ORDER BY id', [id]);
  const [stock] = await connexion.query(
    `SELECT p.id, p.reception_id, p.emplacement, p.quantite, r.reference, r.lot, r.type, r.taille_bobine, r.type_cosse
     FROM placements p JOIN receptions r ON r.id = p.reception_id
     WHERE r.import_id = ? ORDER BY p.emplacement, r.reference ${verrou ? 'FOR UPDATE' : ''}`,
    [id]
  );
  const [reclamations] = await connexion.query(
    'SELECT * FROM reclamations WHERE import_id = ? OR reception_id IN (SELECT id FROM receptions WHERE import_id = ?) ORDER BY id',
    [id, id]
  );
  const [[{ scans }]] = await connexion.query(
    'SELECT COUNT(*) AS scans FROM controles_mobile WHERE import_id = ? OR reception_id IN (SELECT id FROM receptions WHERE import_id = ?)',
    [id, id]
  );
  const [[{ historique }]] = await connexion.query(
    'SELECT COUNT(*) AS historique FROM mouvements_emplacement WHERE reception_id IN (SELECT id FROM receptions WHERE import_id = ?)',
    [id]
  );
  const [[{ sorties }]] = await connexion.query(
    'SELECT COALESCE(SUM(d.quantite), 0) AS sorties FROM export_details d JOIN receptions r ON r.id = d.reception_id WHERE r.import_id = ?',
    [id]
  );
  const [enCours] = await connexion.query(
    `SELECT DISTINCT p.id, p.reference, u.matricule FROM preparation_lignes l
     JOIN preparations_export p ON p.id = l.preparation_id AND p.statut = 'en_cours'
     LEFT JOIN utilisateurs u ON u.id = p.utilisateur_id
     WHERE l.reception_id IN (SELECT id FROM receptions WHERE import_id = ?)`,
    [id]
  );
  const [attendus] = await connexion.query('SELECT reference, type, type_cosse, taille_bobine, pieces FROM imports_attendus WHERE import_id = ?', [id]);
  return {
    imp, lignes, stock, reclamations, attendus,
    resume: {
      id: imp.id,
      numero_livraison: imp.numero_livraison,
      statut: imp.statut,
      reception: imp.reception,
      lignes: lignes.length,
      produits_en_stock: stock.reduce((t, s) => t + s.quantite, 0),
      emplacements: [...new Set(stock.map((s) => s.emplacement).filter(Boolean))],
      non_ranges: stock.filter((s) => !s.emplacement).reduce((t, s) => t + s.quantite, 0),
      reclamations: reclamations.length,
      scans: Number(scans),
      historique: Number(historique), // lignes d'historique des emplacements de ses produits
      sorties_faites: Number(sorties),
      sorties_en_cours: enCours.map((p) => ({ id: p.id, reference: p.reference, par: p.matricule })),
      // texte à taper pour confirmer
      confirmation: imp.numero_livraison ?? String(imp.id),
    },
  };
}

// GET /api/imports/:id/suppression : ce que la suppression effacerait (administrateur)
router.get('/:id/suppression', exigerRole('admin'), async (req, res, next) => {
  try {
    const bilan = await bilanSuppression(db, Number(req.params.id));
    if (!bilan) return res.status(404).json({ message: 'Import introuvable' });
    res.json(bilan.resume);
  } catch (err) { next(err); }
});

// DELETE /api/imports/:id  { motif, confirmation, complet? } (administrateur)
// confirmation : le n° de livraison de l'import (ou son n° s'il n'en a pas), tapé à la main.
// complet : efface aussi l'historique des emplacements de ses produits et ses scans mobiles (aucune trace
// sauf la ligne « qui, quand, pourquoi » de imports_supprimes) ; les sorties déjà faites restent.
router.delete('/:id', exigerRole('admin'), async (req, res, next) => {
  const id = Number(req.params.id);
  const motif = String(req.body?.motif ?? '').trim();
  if (motif.length < 3) return res.status(400).json({ message: 'Indiquez le motif de la suppression' });
  if (motif.length > 255) return res.status(400).json({ message: 'Le motif ne doit pas dépasser 255 caractères' });
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion); // une opération sur le stock à la fois
    await connexion.beginTransaction();
    const refuser = async (status, message) => {
      await connexion.rollback();
      res.status(status).json({ message });
    };
    const bilan = await bilanSuppression(connexion, id, true);
    if (!bilan) return refuser(404, 'Import introuvable');
    const { imp, stock, resume } = bilan;
    const tape = String(req.body?.confirmation ?? '').trim().toUpperCase();
    if (tape !== resume.confirmation.toUpperCase()) {
      return refuser(400, `Pour confirmer, tapez exactement « ${resume.confirmation} »`);
    }
    if (resume.sorties_en_cours.length) {
      const p = resume.sorties_en_cours[0];
      return refuser(409, `Une sortie en cours sur le mobile utilise des produits de cet import (${p.reference}${p.par ? ', matricule ' + p.par : ''}) : terminez-la ou annulez-la d'abord.`);
    }
    const complet = req.body?.complet === true;
    // Copie de l'import tel qu'il était (suppression complète : rien n'est gardé)
    const contenu = JSON.stringify(complet
      ? { complet: true }
      : { import: imp, lignes: bilan.lignes, stock, reclamations: bilan.reclamations, attendus: bilan.attendus });
    await connexion.query(
      `INSERT INTO imports_supprimes (import_id, source_id, numero_livraison, statut, produits_retires, motif, contenu, utilisateur_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [imp.id, imp.source_id, imp.numero_livraison, imp.statut, resume.produits_en_stock, motif, contenu, req.utilisateur.id]
    );
    // Retrait du stock noté dans l'historique des emplacements (l'emplacement est-il vide ensuite ?)
    const ranges = stock.filter((s) => s.emplacement);
    if (complet) {
      // Toutes ses données : historique des emplacements de ses produits et scans du mobile
      await connexion.query('DELETE FROM mouvements_emplacement WHERE reception_id IN (SELECT id FROM receptions WHERE import_id = ?)', [imp.id]);
      await connexion.query('DELETE FROM controles_mobile WHERE import_id = ? OR reception_id IN (SELECT id FROM receptions WHERE import_id = ?)', [imp.id, imp.id]);
    } else if (ranges.length) {
      const [occupe] = await connexion.query(
        'SELECT emplacement, SUM(quantite) AS q FROM placements WHERE emplacement IN (?) GROUP BY emplacement',
        [[...new Set(ranges.map((s) => s.emplacement))]]
      );
      const reste = new Map(occupe.map((o) => [o.emplacement, Number(o.q)]));
      for (const s of ranges) reste.set(s.emplacement, reste.get(s.emplacement) - s.quantite);
      const nom = imp.numero_livraison ? `l'import ${imp.numero_livraison}` : `l'import n° ${imp.id}`;
      await enregistrerMouvements(connexion, ranges.map((s) => ({
        origine: 'suppression_import', ligne: { ...s, id: s.reception_id }, quantite: s.quantite, depuis: s.emplacement, vers: null,
        commentaire: `Suppression de ${nom} : ${motif}`.slice(0, 255), utilisateurId: req.utilisateur.id,
        depuisLiberee: reste.get(s.emplacement) === 0,
      })));
    }
    await connexion.query('DELETE FROM imports WHERE id = ?', [imp.id]);
    // Un import en attente de moins : les suivants déjà réceptionnés sans écart passent au stock, dans l'ordre d'arrivée
    const automatiques = imp.statut === 'en_attente' ? await ajoutsAutomatiques(connexion) : [];
    await connexion.commit();
    res.json({
      id: imp.id, numero_livraison: imp.numero_livraison, statut: imp.statut, complet,
      produits_retires: resume.produits_en_stock, reclamations: resume.reclamations, ajoutes_automatiquement: automatiques,
    });
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

// POST /api/imports/:id/produits
//   bobine / cosse : { type, taille_bobine, reference, lot, quantite }
//   connecteur     : { type, reference, lot, quantite } (cartons, sans dimensions ni poids)
router.post('/:id/produits', async (req, res, next) => {
  try {
    if (!(await importEnAttente(req.params.id, res))) return;

    const { type, taille_bobine, reference, lot } = req.body;
    const quantite = Number(req.body.quantite);
    if (!TYPES.includes(type)) return res.status(400).json({ message: 'Type invalide (Bobine, Cosse ou Connecteur)' });
    if (type === 'bobine' && !TAILLES_BOBINE.includes(taille_bobine)) {
      return res.status(400).json({ message: 'Taille de bobine obligatoire (grande, moyenne ou petite)' });
    }
    if (!reference?.trim() || !lot?.trim()) return res.status(400).json({ message: 'Référence et lot sont obligatoires' });
    // Commentaire facultatif (255 caractères au plus)
    const commentaire = String(req.body.commentaire ?? '').trim() || null;
    if (commentaire && commentaire.length > 255) {
      return res.status(400).json({ message: 'Le commentaire ne doit pas dépasser 255 caractères' });
    }

    if (!Number.isInteger(quantite) || quantite <= 0) {
      return res.status(400).json({ message: 'La quantité doit être un nombre entier positif' });
    }

    // Cosse : son type (axiale ou plat) vient du catalogue Articles
    const typeCosse = type === 'cosse' ? ((await typesDuCatalogue(db, [reference])).get(normaliserReference(reference))?.type_cosse ?? 'plat') : null;
    const [result] = await db.query(
      `INSERT INTO receptions (import_id, type, taille_bobine, type_cosse, reference, lot, date_reception, quantite, commentaire, utilisateur_id)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
      [
        req.params.id, type, type === 'bobine' ? taille_bobine : null, typeCosse,
        reference.trim().toUpperCase(), lot.trim().toUpperCase(), quantite, commentaire, req.utilisateur.id,
      ]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) { next(err); }
});

// DELETE /api/imports/:id/produits/:produitId : retirer un produit d'un import en attente
router.delete('/:id/produits/:produitId', async (req, res, next) => {
  try {
    if (!(await importEnAttente(req.params.id, res))) return;
    const [result] = await db.query('DELETE FROM receptions WHERE id = ? AND import_id = ?', [
      req.params.produitId,
      req.params.id,
    ]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Produit introuvable dans cet import' });
    res.status(204).end();
  } catch (err) { next(err); }
});

const MOTIFS = ['manquant', 'non_conforme', 'endommage', 'non_commande', 'autre'];

// Regroupe les colonnes rc_* en un objet « reclamation » (null si le produit n'est pas réclamé)
function avecReclamation(l) {
  const { rc_quantite, rc_motif, rc_commentaire, rc_date, rc_par, ...produit } = l;
  return {
    ...produit,
    reclamation: rc_motif
      ? { quantite: rc_quantite, motif: rc_motif, commentaire: rc_commentaire, date: rc_date, par: rc_par }
      : null,
  };
}

// Dimensions et poids en nombres (null pour les bobines et les cosses)
function avecMesures(l) {
  const nombre = (v) => (v === null || v === undefined ? null : Number(v));
  return { ...l, longueur: nombre(l.longueur), largeur: nombre(l.largeur), hauteur: nombre(l.hauteur), poids: nombre(l.poids) };
}

// Produits d'un import à ranger, au format attendu par le moteur de rangement.
// La quantité réclamée (manquante, non conforme…) n'entre pas dans le stock :
// seule la quantité restante est rangée ; un produit entièrement réclamé n'est pas rangé.
async function produitsImport(connexion, importId) {
  const [lignes] = await connexion.query(
    `SELECT r.id, r.type, r.taille_bobine, r.type_cosse, r.reference, r.lot,
            r.quantite - COALESCE(rc.quantite, 0)
              -- bobines déjà rangées palette par palette pendant la réception
              - (SELECT COUNT(*) FROM affectations_colis a WHERE a.reception_id = r.id AND a.palette_id IS NOT NULL AND a.range_le IS NOT NULL)
              -- cosses reçues sur une palette (cartons ou séparées) : elles entrent au stock au rangement de leur palette,
              -- sans plan (les cosses séparées hors palette de la même ligne gardent leur place)
              - (SELECT COUNT(*) FROM controles_mobile c WHERE c.reception_id = r.id AND (c.carton_id IS NOT NULL OR c.palette_cosses_id IS NOT NULL)
                   AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite'))
              -- colis posés pendant la réception pour une sortie urgente : déjà au stock (ou déjà sortis)
              - (SELECT COUNT(*) FROM sorties_urgentes u WHERE u.reception_id = r.id AND u.date_posee IS NOT NULL) AS quantite,
            r.longueur, r.largeur, r.hauteur, r.poids
     FROM receptions r
     LEFT JOIN reclamations rc ON rc.reception_id = r.id
     WHERE r.import_id = ?`,
    [importId]
  );
  return lignes.map(avecMesures).filter((l) => l.quantite > 0);
}

// PUT /api/imports/:id/produits/:produitId/reclamation  { quantite, motif, commentaire? }
// Réclame tout ou partie d'un produit d'un import en attente (crée ou modifie la réclamation).
router.put('/:id/produits/:produitId/reclamation', async (req, res, next) => {
  try {
    if (!(await importEnAttente(req.params.id, res))) return;
    const [[produit]] = await db.query('SELECT id, quantite FROM receptions WHERE id = ? AND import_id = ?', [
      req.params.produitId,
      req.params.id,
    ]);
    if (!produit) return res.status(404).json({ message: 'Produit introuvable dans cet import' });

    const quantite = Number(req.body?.quantite);
    const motif = req.body?.motif;
    const commentaire = String(req.body?.commentaire ?? '').trim() || null;
    if (!MOTIFS.includes(motif)) return res.status(400).json({ message: 'Choisissez le motif de la réclamation' });
    if (!Number.isInteger(quantite) || quantite < 1 || quantite > produit.quantite) {
      return res.status(400).json({ message: `La quantité réclamée doit être entre 1 et ${produit.quantite}` });
    }
    if (commentaire && commentaire.length > 255) {
      return res.status(400).json({ message: 'Le commentaire ne doit pas dépasser 255 caractères' });
    }
    await db.query(
      `INSERT INTO reclamations (reception_id, quantite, motif, commentaire, utilisateur_id, date_creation)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE quantite = VALUES(quantite), motif = VALUES(motif), commentaire = VALUES(commentaire),
                               utilisateur_id = VALUES(utilisateur_id), date_creation = NOW()`,
      [produit.id, quantite, motif, commentaire, req.utilisateur.id]
    );
    res.json({ reception_id: produit.id, quantite, motif, commentaire });
  } catch (err) { next(err); }
});

// DELETE /api/imports/:id/produits/:produitId/reclamation : annule la réclamation (import en attente)
router.delete('/:id/produits/:produitId/reclamation', async (req, res, next) => {
  try {
    if (!(await importEnAttente(req.params.id, res))) return;
    await db.query(
      'DELETE rc FROM reclamations rc JOIN receptions r ON r.id = rc.reception_id WHERE r.id = ? AND r.import_id = ?',
      [req.params.produitId, req.params.id]
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /api/imports/:id/plan-rangement
// Propose un emplacement pour chaque produit de l'import en attente (règles du moteur),
// sans rien enregistrer. Le magasinier vérifie ou modifie avant d'ajouter au stock.
router.get('/:id/plan-rangement', async (req, res, next) => {
  try {
    if (!(await importEnAttente(req.params.id, res))) return;
    const precedent = await importPrecedentEnAttente(db, req.params.id);
    if (precedent) return res.status(409).json({ message: messageOrdre(precedent), bloque_par: precedent });
    const produits = await produitsImport(db, req.params.id);
    const enPlace = (await occupation()).filter((l) => l.emplacement);
    const plan = R.proposerPlan(produits, enPlace, await parametresRangement());
    const parId = new Map(produits.map((p) => [p.id, p]));
    res.json(plan.map((p) => ({ ...p, produit: parId.get(p.id) })));
  } catch (err) { next(err); }
});

// POST /api/imports/:id/ajouter-au-stock  { placements?: [{ id, emplacement, quantite }] (administrateur uniquement) }
// Une ligne de quantité N = N produits identiques, éventuellement répartis sur plusieurs emplacements.
// Fait entrer tous les produits de l'import dans le stock et les range :
// selon les placements envoyés (plan vérifié / modifié par le magasinier),
// sinon selon le plan proposé par le moteur. La date de réception est la date système.
// L'import est ensuite verrouillé (historique).
// Ajoute un import au stock (dans la transaction en cours, sous le verrou du stock).
//   - réception mobile terminée : autorisé ;
//   - sinon : seulement l'administrateur ou le chef, avec corps.force et un motif (secours sans mobile) ;
//   - automatique (fin de réception sans écart) : plan du système.
// Lève une erreur { status, message } si c'est impossible.
async function ajouterAuStock(connexion, importId, utilisateur, corps = {}, { automatique = false } = {}) {
  const erreur = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
  const [[imp]] = await connexion.query('SELECT id, statut, reception FROM imports WHERE id = ? FOR UPDATE', [importId]);
  if (!imp) throw erreur(404, 'Import introuvable');
  if (imp.statut !== 'en_attente') throw erreur(409, 'Cet import est déjà ajouté au stock');
  const precedent = await importPrecedentEnAttente(connexion, imp.id);
  if (precedent) throw erreur(409, messageOrdre(precedent), { bloque_par: precedent });
  const [[{ nb }]] = await connexion.query('SELECT COUNT(*) AS nb FROM receptions WHERE import_id = ?', [imp.id]);
  if (!nb) throw erreur(400, "L'import est vide : ajoutez au moins un produit");

  // La réception physique (mobile) doit être terminée, sauf secours encadré.
  // Secours (chef, motif obligatoire) : tout entre au stock tout de suite, sans contrôle mobile.
  let motifForce = null;
  const secours = !automatique && estGestionnaire(utilisateur) && corps.force === true;
  if (!automatique && imp.reception !== 'terminee' && !secours) {
    const av = (await RI.avancement(connexion, [imp.id])).get(imp.id);
    const recus = av.resume ? `${av.recus}/${av.attendus} pièces reçues` : `${av.recus}/${av.attendus} produit(s) reçu(s)`;
    throw erreur(409, `En attente de la réception mobile (${recus}). Le magasinier doit scanner les colis puis « Terminer la réception ».`,
      { code: 'reception_requise', recus: av.recus, attendus: av.attendus });
  }
  if (secours) {
    motifForce = String(corps.motif_force ?? '').trim();
    if (motifForce.length < 3) throw erreur(400, "Indiquez le motif de l'ajout sans contrôle mobile (ex. téléphone en panne)");
    if (motifForce.length > 255) throw erreur(400, 'Le motif ne doit pas dépasser 255 caractères');
  }

  // Produits à ranger (quantités réclamées exclues)
  const produits = await produitsImport(connexion, imp.id);
  // Stock en place et places déjà réservées par les imports en cours de rangement, verrouillés
  const enPlace = (await occupation(connexion, true)).filter((l) => l.emplacement);
  const { capaciteTampon: capacite } = await parametresRangement(connexion);
  // Seuls l'administrateur et le chef de magasin peuvent modifier le plan ;
  // pour un magasinier (et l'ajout automatique), le plan du système s'applique
  const envoyes = !automatique && estGestionnaire(utilisateur) && Array.isArray(corps.placements) ? corps.placements : null;
  const plan = envoyes
    ? envoyes.map((p) => ({
        id: Number(p.id),
        emplacement: String(p.emplacement || '').trim().toUpperCase() || null,
        quantite: Number(p.quantite),
      }))
    : R.proposerPlan(produits, enPlace, { capaciteTampon: capacite });
  const refus = R.verifierPlan(plan, produits, enPlace, capacite);
  if (refus) throw erreur(409, refus);

  // Plan modifié par l'administrateur ou le chef : les emplacements différents de la proposition
  // du système sont enregistrés dans l'historique, avec un motif obligatoire.
  const ecarts = [];
  if (envoyes) {
    const propose = R.proposerPlan(produits, enPlace, { capaciteTampon: capacite });
    const repartition = (liste, id) => {
      const m = new Map();
      for (const p of liste.filter((x) => x.id === id)) m.set(p.emplacement, (m.get(p.emplacement) ?? 0) + p.quantite);
      return m;
    };
    for (const produit of produits) {
      const choisi = repartition(plan, produit.id);
      const prevu = repartition(propose, produit.id);
      const identique = choisi.size === prevu.size && [...choisi].every(([e, q]) => prevu.get(e) === q);
      if (identique) continue;
      const premierPrevu = [...prevu.keys()][0] ?? null;
      for (const [vers, quantite] of choisi) {
        if (prevu.get(vers) === quantite) continue;
        ecarts.push({ ligne: { ...produit, reception_id: produit.id }, quantite, depuis: premierPrevu, vers });
      }
    }
  }
  let motifPlan = null;
  if (ecarts.length) {
    motifPlan = lireMotif(corps);
    if (motifPlan.erreur) throw erreur(400, `Plan modifié : ${motifPlan.erreur.charAt(0).toLowerCase()}${motifPlan.erreur.slice(1)}`);
  }

  // Plan de rangement : les places sont réservées ; chaque produit entre au stock quand le magasinier
  // le range (scan du ticket puis de l'emplacement sur le mobile). Sans place (non rangé) ou en secours :
  // entrée au stock immédiate, comme avant.
  for (const p of plan) {
    if (!p.emplacement || secours) {
      await poserQuantite(connexion, p.id, p.emplacement, p.quantite);
    }
    if (p.emplacement) {
      await connexion.query(
        `INSERT INTO plans_rangement (reception_id, emplacement, quantite, ranges) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE quantite = quantite + VALUES(quantite), ranges = ranges + VALUES(ranges)`,
        [p.id, p.emplacement, p.quantite, secours ? p.quantite : 0]
      );
    }
  }
  // Cartons de connecteurs ajoutés à une palette du magasin (descendue puis remise) : au stock, à sa place
  await P.entrerComplements(connexion, imp.id, utilisateur.id);
  // Chaque colis reçu reçoit son emplacement imposé (colis triés par numéro, places dans l'ordre du plan)
  if (!secours) {
    for (const produit of produits) await attribuerColis(connexion, produit.id);
  }
  await enregistrerMouvements(connexion, ecarts.map((e) => ({
    origine: 'plan_import', ligne: e.ligne, quantite: e.quantite, depuis: e.depuis, vers: e.vers,
    motif: motifPlan.motif, commentaire: motifPlan.commentaire, utilisateurId: utilisateur.id,
  })));
  await connexion.query(
    "UPDATE imports SET statut = 'ajoute', date_ajout_stock = NOW(), ajoute_par = ?, ajout_force = ?, motif_force = ? WHERE id = ?",
    [utilisateur.id, motifForce ? 1 : 0, motifForce, imp.id]
  );
  await connexion.query('UPDATE receptions SET date_reception = NOW() WHERE import_id = ?', [imp.id]);
  // Sorties urgentes dont le colis n'est pas encore posé : plus possibles, le colis a maintenant son emplacement imposé
  await connexion.query("UPDATE sorties_urgentes SET statut = 'annulee' WHERE import_id = ? AND statut = 'a_poser'", [imp.id]);
  return {
    id: imp.id,
    secours: !!secours,
    a_ranger: secours ? 0 : plan.filter((p) => p.emplacement).reduce((t, p) => t + p.quantite, 0),
    produits: produits.length,
    enTampon: plan.filter((p) => R.estTampon(p.emplacement)).reduce((t, p) => t + p.quantite, 0),
  };
}

// Ajouts automatiques, dans l'ordre d'arrivée : tant que l'import le plus ancien en attente a une
// réception mobile terminée sans écart, il passe au stock (plan du système). Renvoie les imports ajoutés.
async function ajoutsAutomatiques(connexion) {
  const ajoutes = [];
  const separee = (await modeReception(connexion)) === 'separee';
  for (let garde = 0; garde < 50; garde++) {
    const [[premier]] = await connexion.query(
      `SELECT i.id, i.reception, i.reception_ecarts, i.reception_par FROM imports i
       WHERE i.statut = 'en_attente' ORDER BY ${ARRIVEE}, i.id LIMIT 1`
    );
    // réception séparée : les écarts sont déjà réclamés, l'import passe au stock sans validation du chef
    if (!premier || premier.reception !== 'terminee' || (premier.reception_ecarts > 0 && !separee)) break;
    try {
      await ajouterAuStock(connexion, premier.id, { id: premier.reception_par, role: 'magasinier' }, {}, { automatique: true });
      ajoutes.push(premier.id);
    } catch {
      break; // plan impossible (plus de place) : le chef l'ajoutera depuis le web
    }
  }
  return ajoutes;
}

// POST /api/imports/:id/ajouter-au-stock
//   { placements?: [{ id, emplacement, quantite }], motif?, commentaire? }  (plan modifié : administrateur, chef)
//   { force: true, motif_force: "téléphone en panne" }                       (sans réception mobile : administrateur, chef)
// Une ligne de quantité N = N produits identiques, éventuellement répartis sur plusieurs emplacements.
// La date de réception est la date système ; l'import est ensuite verrouillé (historique).
// Les imports suivants déjà réceptionnés sans écart passent ensuite au stock automatiquement.
router.post('/:id/ajouter-au-stock', async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion); // une opération sur le stock à la fois
    await connexion.beginTransaction();
    const resultat = await ajouterAuStock(connexion, Number(req.params.id), req.utilisateur, req.body || {});
    const automatiques = await ajoutsAutomatiques(connexion);
    await connexion.commit();
    res.json({ ...resultat, ajoutes_automatiquement: automatiques });
  } catch (err) {
    await connexion.rollback();
    if (err.status) return res.status(err.status).json({ message: err.message, ...(err.extra ?? {}) });
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

module.exports = router;
module.exports.ajouterAuStock = ajouterAuStock;
module.exports.ajoutsAutomatiques = ajoutsAutomatiques;
module.exports.importPrecedentEnAttente = importPrecedentEnAttente;
module.exports.receptionPrecedenteNonTerminee = receptionPrecedenteNonTerminee;
module.exports.messageOrdreReception = messageOrdreReception;
