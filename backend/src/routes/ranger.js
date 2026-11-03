// « Ranger le magasin » côté web : ce que les magasiniers ont rangé sur le mobile, librement (sans
// suggestion du système), contrôlé et historisé. Pour le chef et le directeur : les chiffres de la période,
// le travail de chaque personne, chaque déplacement (qui, quand, quel produit, d'où, vers où, emplacement
// libéré) et les déplacements refusés par les contrôles.
//   GET /api/ranger?du=&au=&par=&reference=&emplacement=
//       du, au : AAAA-MM-JJ ; par : matricule ; reference : partie de la référence ; emplacement : départ ou arrivée
// Fichiers Excel et PDF : /api/stock/historique/excel|pdf?origine=regroupement (mêmes filtres).
const express = require('express');
const db = require('../db');

const router = express.Router();
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Conditions communes aux déplacements (historique) et aux contrôles du mobile
function filtres(q, colonnes) {
  const conditions = [];
  const valeurs = [];
  if (DATE.test(q.du ?? '')) {
    conditions.push(`${colonnes.date} >= ?`);
    valeurs.push(q.du);
  }
  if (DATE.test(q.au ?? '')) {
    conditions.push(`${colonnes.date} < DATE_ADD(?, INTERVAL 1 DAY)`);
    valeurs.push(q.au);
  }
  if (q.par) {
    conditions.push('u.matricule = ?');
    valeurs.push(String(q.par).trim());
  }
  if (q.reference) {
    conditions.push(`${colonnes.reference} LIKE ?`);
    valeurs.push(`%${String(q.reference).trim().toUpperCase()}%`);
  }
  if (q.emplacement) {
    const code = String(q.emplacement).trim().toUpperCase();
    conditions.push(`(${colonnes.depuis} = ? OR ${colonnes.vers} = ?)`);
    valeurs.push(code, code);
  }
  return { sql: conditions.map((c) => ` AND ${c}`).join(''), valeurs };
}

const PERSONNE = 'u.id AS utilisateur_id, u.matricule, u.nom, u.prenom, u.role';

router.get('/', async (req, res, next) => {
  try {
    const fm = filtres(req.query, { date: 'm.date_mouvement', reference: 'm.reference', depuis: 'm.depuis', vers: 'm.vers' });
    const fc = filtres(req.query, { date: 'c.date_controle', reference: 'c.reference', depuis: 'c.emplacement_prevu', vers: 'c.emplacement_scanne' });

    const [mouvements] = await db.query(
      `SELECT m.id, DATE_FORMAT(m.date_mouvement, '%Y-%m-%dT%H:%i:%s') AS date, m.reference, m.lot, m.type, m.taille_bobine,
              m.quantite, m.colis, m.depuis, m.vers, m.depuis_liberee, m.commentaire, ${PERSONNE}
       FROM mouvements_emplacement m LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
       WHERE m.origine = 'regroupement'${fm.sql}
       ORDER BY m.date_mouvement DESC, m.id DESC LIMIT 500`,
      fm.valeurs
    );
    const [refus] = await db.query(
      `SELECT c.id, DATE_FORMAT(c.date_controle, '%Y-%m-%dT%H:%i:%s') AS date, c.resultat, c.reference, c.lot,
              c.emplacement_prevu AS depuis, c.emplacement_scanne AS vers, c.message, ${PERSONNE}
       FROM controles_mobile c LEFT JOIN utilisateurs u ON u.id = c.utilisateur_id
       WHERE c.controle = 'ranger' AND c.resultat <> 'deplace'${fc.sql}
       ORDER BY c.date_controle DESC, c.id DESC LIMIT 200`,
      fc.valeurs
    );
    // Chiffres de chaque personne : déplacements et refus (contrôles), produits et emplacements libérés (historique)
    const [controles] = await db.query(
      `SELECT ${PERSONNE}, SUM(c.resultat = 'deplace') AS deplacements, SUM(c.resultat <> 'deplace') AS refus,
              DATE_FORMAT(MAX(IF(c.resultat = 'deplace', c.date_controle, NULL)), '%Y-%m-%dT%H:%i:%s') AS dernier
       FROM controles_mobile c JOIN utilisateurs u ON u.id = c.utilisateur_id
       WHERE c.controle = 'ranger'${fc.sql}
       GROUP BY u.id`,
      fc.valeurs
    );
    const [historique] = await db.query(
      `SELECT ${PERSONNE}, SUM(m.quantite) AS produits, SUM(m.depuis_liberee) AS liberes,
              DATE_FORMAT(MAX(m.date_mouvement), '%Y-%m-%dT%H:%i:%s') AS dernier
       FROM mouvements_emplacement m JOIN utilisateurs u ON u.id = m.utilisateur_id
       WHERE m.origine = 'regroupement'${fm.sql}
       GROUP BY u.id`,
      fm.valeurs
    );
    const personnes = new Map();
    const personne = (l) => personnes.get(l.utilisateur_id) ?? personnes.set(l.utilisateur_id, {
      utilisateur_id: l.utilisateur_id, matricule: l.matricule, nom: l.nom, prenom: l.prenom, role: l.role,
      deplacements: 0, refus: 0, produits: 0, liberes: 0, dernier: null,
    }).get(l.utilisateur_id);
    for (const l of controles) {
      const p = personne(l);
      p.deplacements = Number(l.deplacements ?? 0);
      p.refus = Number(l.refus ?? 0);
      if (l.dernier && (!p.dernier || l.dernier > p.dernier)) p.dernier = l.dernier;
    }
    for (const l of historique) {
      const p = personne(l);
      p.produits = Number(l.produits ?? 0);
      p.liberes = Number(l.liberes ?? 0);
      if (l.dernier && (!p.dernier || l.dernier > p.dernier)) p.dernier = l.dernier;
    }
    const parPersonne = [...personnes.values()].sort((a, b) => b.deplacements - a.deplacements || b.produits - a.produits || a.matricule.localeCompare(b.matricule));
    const somme = (champ) => parPersonne.reduce((t, p) => t + p[champ], 0);

    // Personnes ayant déjà rangé (filtre « Magasinier »), toutes périodes confondues
    const [utilisateurs] = await db.query(
      `SELECT DISTINCT u.matricule, u.nom, u.prenom FROM controles_mobile c JOIN utilisateurs u ON u.id = c.utilisateur_id
       WHERE c.controle = 'ranger'
       UNION
       SELECT DISTINCT u.matricule, u.nom, u.prenom FROM mouvements_emplacement m JOIN utilisateurs u ON u.id = m.utilisateur_id
       WHERE m.origine = 'regroupement'
       ORDER BY matricule`
    );

    res.json({
      resume: {
        deplacements: somme('deplacements'),
        produits: somme('produits'),
        liberes: somme('liberes'),
        refus: somme('refus'),
        personnes: parPersonne.filter((p) => p.deplacements || p.produits).length,
      },
      par_personne: parPersonne,
      mouvements: mouvements.map((m) => ({ ...m, depuis_liberee: !!m.depuis_liberee })),
      refus,
      utilisateurs,
    });
  } catch (err) { next(err); }
});

module.exports = router;
