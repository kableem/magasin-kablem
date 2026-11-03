// Catalogue des articles (administrateur) : bobines, cosses et familles de connecteurs avec leurs références.
//   GET    /api/articles                    ?famille=&categorie=&q=   liste
//   GET    /api/articles/resume             nombre de références par famille et catégorie
//   GET    /api/articles/changements-taille ?reference=   historique des changements de taille des bobines
//   POST   /api/articles                    { reference, famille, categorie?, bobines_par_palette?, type_cosse? }
//   PUT    /api/articles/:id                { reference, famille, categorie?, bobines_par_palette?, type_cosse? }
//   PUT    /api/articles/:id/taille         { bobines_par_palette }   change la taille d'une bobine
//   PUT    /api/articles/:id/type-cosse     { type_cosse }            change le type d'une cosse (axiale / plat)
//   DELETE /api/articles/:id
// Bobines : bobines_par_palette donne la taille (1 grande, 2 moyenne, 6 petite) des prochains imports ;
// chaque changement est gardé dans l'historique (qui, quand, avant → après).
const express = require('express');
const db = require('../db');
const { FAMILLES, TAILLE_PAR_PALETTE, TYPES_COSSE, lireArticle } = require('../articles');

const router = express.Router();
const COLONNES = "id, reference, famille, categorie, bobines_par_palette, type_cosse, DATE_FORMAT(date_creation, '%Y-%m-%dT%H:%i:%s') AS date_creation";

router.get('/', async (req, res, next) => {
  try {
    const conditions = [];
    const valeurs = [];
    if (FAMILLES.includes(req.query.famille)) {
      conditions.push('famille = ?');
      valeurs.push(req.query.famille);
    }
    if (req.query.categorie) {
      conditions.push('categorie = ?');
      valeurs.push(String(req.query.categorie));
    }
    const q = String(req.query.q ?? '').trim();
    if (q) {
      conditions.push('(reference LIKE ? OR categorie LIKE ?)');
      valeurs.push(`%${q}%`, `%${q}%`);
    }
    const [lignes] = await db.query(
      `SELECT ${COLONNES} FROM articles_mp ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
       ORDER BY FIELD(famille, 'bobine', 'cosse', 'connecteur'), categorie, reference`,
      valeurs
    );
    res.json(lignes);
  } catch (err) { next(err); }
});

router.get('/resume', async (req, res, next) => {
  try {
    const [lignes] = await db.query(
      `SELECT famille, categorie, COUNT(*) AS n FROM articles_mp
       GROUP BY famille, categorie ORDER BY FIELD(famille, 'bobine', 'cosse', 'connecteur'), n DESC, categorie`
    );
    res.json(lignes.map((l) => ({ ...l, n: Number(l.n) })));
  } catch (err) { next(err); }
});

router.get('/changements-taille', async (req, res, next) => {
  try {
    const reference = String(req.query.reference ?? '').trim();
    const [lignes] = await db.query(
      `SELECT h.id, h.reference, h.famille, h.avant, h.apres, h.type_cosse_avant, h.type_cosse_apres, DATE_FORMAT(h.date_changement, '%Y-%m-%dT%H:%i:%s') AS date,
              u.matricule, TRIM(CONCAT(COALESCE(u.prenom, ''), ' ', COALESCE(u.nom, ''))) AS par
       FROM articles_changements_taille h
       LEFT JOIN utilisateurs u ON u.id = h.utilisateur_id
       ${reference ? 'WHERE h.reference = ?' : ''}
       ORDER BY h.date_changement DESC, h.id DESC
       LIMIT 500`,
      reference ? [reference.toUpperCase()] : []
    );
    res.json(lignes);
  } catch (err) { next(err); }
});

// Garde la trace d'un changement de taille (rien si la taille ne change pas)
async function noterChangementTaille(connexion, reference, avant, apres, utilisateurId) {
  if (apres === null || apres === undefined || Number(avant) === Number(apres)) return false;
  await connexion.query(
    'INSERT INTO articles_changements_taille (reference, avant, apres, utilisateur_id) VALUES (?, ?, ?, ?)',
    [reference, avant ?? null, apres, utilisateurId ?? null]
  );
  return true;
}

// Garde la trace d'un changement de type de cosse (rien si le type ne change pas)
async function noterChangementTypeCosse(connexion, reference, avant, apres, utilisateurId) {
  if (!apres || avant === apres) return false;
  await connexion.query(
    "INSERT INTO articles_changements_taille (reference, famille, type_cosse_avant, type_cosse_apres, utilisateur_id) VALUES (?, 'cosse', ?, ?, ?)",
    [reference, avant ?? null, apres, utilisateurId ?? null]
  );
  return true;
}

async function enregistrer(req, res, next, id) {
  const connexion = await db.getConnection();
  try {
    const { article, erreur } = lireArticle(req.body);
    if (erreur) return res.status(400).json({ message: erreur });
    const [[existant]] = await connexion.query('SELECT id, famille, categorie FROM articles_mp WHERE reference = ? AND id <> ?', [article.reference, id ?? 0]);
    if (existant) {
      return res.status(409).json({ message: `La référence ${article.reference} existe déjà (${existant.categorie})` });
    }
    await connexion.beginTransaction();
    if (id) {
      const [[avant]] = await connexion.query('SELECT bobines_par_palette, type_cosse FROM articles_mp WHERE id = ? FOR UPDATE', [id]);
      if (!avant) {
        await connexion.rollback();
        return res.status(404).json({ message: 'Article introuvable' });
      }
      await connexion.query('UPDATE articles_mp SET reference = ?, famille = ?, categorie = ?, bobines_par_palette = ?, type_cosse = ? WHERE id = ?',
        [article.reference, article.famille, article.categorie, article.bobines_par_palette, article.type_cosse, id]);
      await noterChangementTaille(connexion, article.reference, avant.bobines_par_palette, article.bobines_par_palette, req.utilisateur?.id);
      await noterChangementTypeCosse(connexion, article.reference, avant.type_cosse, article.type_cosse, req.utilisateur?.id);
    } else {
      const [r] = await connexion.query('INSERT INTO articles_mp (reference, famille, categorie, bobines_par_palette, type_cosse) VALUES (?, ?, ?, ?, ?)',
        [article.reference, article.famille, article.categorie, article.bobines_par_palette, article.type_cosse]);
      id = r.insertId;
    }
    await connexion.commit();
    const [[ligne]] = await connexion.query(`SELECT ${COLONNES} FROM articles_mp WHERE id = ?`, [id]);
    res.status(req.method === 'POST' ? 201 : 200).json(ligne);
  } catch (err) {
    await connexion.rollback().catch(() => {});
    next(err);
  } finally {
    connexion.release();
  }
}

router.post('/', (req, res, next) => enregistrer(req, res, next, null));
router.put('/:id', (req, res, next) => enregistrer(req, res, next, Number(req.params.id)));

// Changement rapide de la taille d'une bobine (petite 6, moyenne 2, grande 1 par palette)
router.put('/:id/taille', async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    const apres = Number(req.body?.bobines_par_palette);
    if (!TAILLE_PAR_PALETTE[apres]) return res.status(400).json({ message: 'Choisissez la taille : petite (6 par palette), moyenne (2) ou grande (1)' });
    await connexion.beginTransaction();
    const [[article]] = await connexion.query('SELECT reference, famille, bobines_par_palette FROM articles_mp WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!article) {
      await connexion.rollback();
      return res.status(404).json({ message: 'Article introuvable' });
    }
    if (article.famille !== 'bobine') {
      await connexion.rollback();
      return res.status(400).json({ message: `${article.reference} n'est pas une bobine` });
    }
    await connexion.query('UPDATE articles_mp SET bobines_par_palette = ? WHERE id = ?', [apres, req.params.id]);
    const change = await noterChangementTaille(connexion, article.reference, article.bobines_par_palette, apres, req.utilisateur?.id);
    await connexion.commit();
    const [[ligne]] = await connexion.query(`SELECT ${COLONNES} FROM articles_mp WHERE id = ?`, [req.params.id]);
    res.json({ ...ligne, change, avant: article.bobines_par_palette });
  } catch (err) {
    await connexion.rollback().catch(() => {});
    next(err);
  } finally {
    connexion.release();
  }
});

// Changement rapide du type d'une cosse (axiale : 3 par palette ; plat : 10 par palette)
router.put('/:id/type-cosse', async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    const apres = req.body?.type_cosse;
    if (!TYPES_COSSE.includes(apres)) return res.status(400).json({ message: 'Choisissez le type de la cosse : axiale ou plat' });
    await connexion.beginTransaction();
    const [[article]] = await connexion.query('SELECT reference, famille, type_cosse FROM articles_mp WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!article) {
      await connexion.rollback();
      return res.status(404).json({ message: 'Article introuvable' });
    }
    if (article.famille !== 'cosse') {
      await connexion.rollback();
      return res.status(400).json({ message: `${article.reference} n'est pas une cosse` });
    }
    await connexion.query('UPDATE articles_mp SET type_cosse = ? WHERE id = ?', [apres, req.params.id]);
    const change = await noterChangementTypeCosse(connexion, article.reference, article.type_cosse, apres, req.utilisateur?.id);
    await connexion.commit();
    const [[ligne]] = await connexion.query(`SELECT ${COLONNES} FROM articles_mp WHERE id = ?`, [req.params.id]);
    res.json({ ...ligne, change, avant: article.type_cosse });
  } catch (err) {
    await connexion.rollback().catch(() => {});
    next(err);
  } finally {
    connexion.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const [r] = await db.query('DELETE FROM articles_mp WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Article introuvable' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
