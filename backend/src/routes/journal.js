// Journal des contrôles du mobile (administrateur, chef de magasin) : contrôler le travail des magasiniers.
//   GET /api/journal                 contrôles filtrés (les alertes par défaut), 1000 au plus
//   GET /api/journal/resume          compteurs par résultat et par magasinier (mêmes filtres)
//   GET /api/journal/utilisateurs    magasiniers ayant des contrôles (filtre)
//   GET /api/journal/excel | /pdf    tout le journal filtré
// Filtres : du, au (AAAA-MM-JJ), utilisateur (id), reference, controle (reception | rangement | export | ranger),
//           resultat, niveau (alertes | tout), manuel (1 = saisies manuelles seulement)
const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('../db');
const { outils } = require('./mobile');

const { COULEURS, TITRES, ALERTES } = outils;
const router = express.Router();

const CONTROLES = { reception: 'Réception', rangement: 'Rangement', export: 'Export', ranger: 'Ranger le magasin' };
const ROLES = { admin: 'Administrateur', chef_magasin: 'Chef de magasin', magasinier: 'Magasinier', planificateur: 'Planificateur' };
const COULEUR_PDF = { vert: '#138a4b', orange: '#d97a00', rouge: '#d42020' };

function filtres(q) {
  const conditions = [];
  const valeurs = [];
  if (TITRES[q.resultat]) {
    conditions.push('c.resultat = ?');
    valeurs.push(q.resultat);
  } else if (q.niveau !== 'tout') {
    conditions.push('c.resultat IN (?)');
    valeurs.push(ALERTES);
  }
  if (CONTROLES[q.controle]) {
    conditions.push('c.controle = ?');
    valeurs.push(q.controle);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.du || '')) {
    conditions.push('DATE(c.date_controle) >= ?');
    valeurs.push(q.du);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.au || '')) {
    conditions.push('DATE(c.date_controle) <= ?');
    valeurs.push(q.au);
  }
  if (Number(q.utilisateur) > 0) {
    conditions.push('c.utilisateur_id = ?');
    valeurs.push(Number(q.utilisateur));
  }
  if (q.reference) {
    conditions.push('c.reference LIKE ?');
    valeurs.push(`%${String(q.reference).trim().toUpperCase()}%`);
  }
  if (q.manuel === '1') conditions.push('c.saisie_manuelle = 1');
  return { ou: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', valeurs };
}

async function charger(q, limite = 1000) {
  const { ou, valeurs } = filtres(q);
  const [lignes] = await db.query(
    `SELECT c.id, c.controle, c.resultat, c.reference, c.lot, c.ticket, c.quantite_ticket, c.quantite_attendue, c.ecart,
            c.emplacement_prevu, c.emplacement_scanne, c.saisie_manuelle, c.message,
            DATE_FORMAT(c.date_controle, '%Y-%m-%dT%H:%i:%s') AS date,
            c.import_id, i.numero_livraison, c.preparation_id, p.destination,
            u.id AS utilisateur_id, u.matricule, u.matricule AS par, u.role
     FROM controles_mobile c
     LEFT JOIN utilisateurs u ON u.id = c.utilisateur_id
     LEFT JOIN imports i ON i.id = c.import_id
     LEFT JOIN preparations_export p ON p.id = c.preparation_id
     ${ou}
     ORDER BY c.date_controle DESC, c.id DESC
     ${limite ? 'LIMIT ' + Number(limite) : ''}`,
    valeurs
  );
  return lignes.map((l) => ({
    ...l,
    titre: TITRES[l.resultat] ?? l.resultat,
    couleur: COULEURS[l.resultat] ?? 'rouge',
    controle_libelle: CONTROLES[l.controle],
    colis: l.ticket ? Number(String(l.ticket).split('|').pop()) : null,
    saisie_manuelle: !!l.saisie_manuelle,
  }));
}

// "2026-10-13T13:00:00" -> "13/10/2026 13:00"
const dateFr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}` : '');
const maintenant = () => dateFr(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19));
function nomFichier(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `journal-alertes-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${ext}`;
}
function descriptionFiltres(q, utilisateurs) {
  const f = [];
  f.push(q.niveau === 'tout' && !TITRES[q.resultat] ? 'tous les contrôles' : 'alertes');
  if (TITRES[q.resultat]) f.push(`résultat « ${TITRES[q.resultat]} »`);
  if (CONTROLES[q.controle]) f.push(CONTROLES[q.controle]);
  if (q.reference) f.push(`référence « ${String(q.reference).toUpperCase()} »`);
  if (Number(q.utilisateur) > 0) {
    const u = utilisateurs.find((x) => x.id === Number(q.utilisateur));
    f.push(`magasinier ${u ? u.matricule : q.utilisateur}`);
  }
  if (q.du) f.push(`du ${q.du.split('-').reverse().join('/')}`);
  if (q.au) f.push(`au ${q.au.split('-').reverse().join('/')}`);
  if (q.manuel === '1') f.push('saisies manuelles');
  return f.join(' · ');
}
const lieu = (l) => {
  if (l.controle === 'reception') return l.numero_livraison ?? (l.import_id ? `import n° ${l.import_id}` : '');
  if (l.controle === 'export') return `sortie → ${l.destination ?? ''}`;
  // Ranger le magasin : départ → arrivée scannés
  if (l.controle === 'ranger') return [l.emplacement_prevu, l.emplacement_scanne].filter(Boolean).join(' → ');
  return '';
};

async function listeUtilisateurs() {
  const [u] = await db.query(
    `SELECT DISTINCT u.id, u.matricule, u.matricule AS nom, u.role
     FROM controles_mobile c JOIN utilisateurs u ON u.id = c.utilisateur_id ORDER BY u.matricule`
  );
  return u;
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await charger(req.query));
  } catch (err) { next(err); }
});

router.get('/utilisateurs', async (req, res, next) => {
  try {
    res.json(await listeUtilisateurs());
  } catch (err) { next(err); }
});

// Compteurs : tous les contrôles de la période (pas seulement les alertes), par résultat et par magasinier
router.get('/resume', async (req, res, next) => {
  try {
    const { ou, valeurs } = filtres({ ...req.query, niveau: 'tout', resultat: undefined });
    const [lignes] = await db.query(
      `SELECT c.resultat, c.utilisateur_id, u.matricule, u.matricule AS nom, COUNT(*) AS n,
              SUM(c.saisie_manuelle) AS manuels
       FROM controles_mobile c LEFT JOIN utilisateurs u ON u.id = c.utilisateur_id
       ${ou}
       GROUP BY c.resultat, c.utilisateur_id, u.matricule, nom`,
      valeurs
    );
    const parResultat = {};
    const parMagasinier = new Map();
    let total = 0;
    let alertes = 0;
    let manuels = 0;
    for (const l of lignes) {
      const n = Number(l.n);
      total += n;
      manuels += Number(l.manuels ?? 0);
      parResultat[l.resultat] = (parResultat[l.resultat] ?? 0) + n;
      const estAlerte = ALERTES.includes(l.resultat);
      if (estAlerte) alertes += n;
      if (!parMagasinier.has(l.utilisateur_id)) {
        parMagasinier.set(l.utilisateur_id, { id: l.utilisateur_id, matricule: l.matricule, nom: l.nom, controles: 0, alertes: 0, manuels: 0 });
      }
      const m = parMagasinier.get(l.utilisateur_id);
      m.controles += n;
      m.manuels += Number(l.manuels ?? 0);
      if (estAlerte) m.alertes += n;
    }
    res.json({
      total, alertes, manuels,
      par_resultat: Object.entries(parResultat).map(([resultat, n]) => ({ resultat, titre: TITRES[resultat] ?? resultat, couleur: COULEURS[resultat], n, alerte: ALERTES.includes(resultat) }))
        .sort((a, b) => b.n - a.n),
      par_magasinier: [...parMagasinier.values()]
        .map((m) => ({ ...m, taux_alertes: m.controles ? Math.round((1000 * m.alertes) / m.controles) / 10 : 0 }))
        .sort((a, b) => b.alertes - a.alertes || b.controles - a.controles),
    });
  } catch (err) { next(err); }
});

router.get('/excel', async (req, res, next) => {
  try {
    const lignes = await charger(req.query, null);
    const utilisateurs = await listeUtilisateurs();
    const classeur = new ExcelJS.Workbook();
    classeur.creator = 'Magasin Kablem';
    const feuille = classeur.addWorksheet('Journal', { views: [{ state: 'frozen', ySplit: 4 }] });
    const colonnes = [
      ['Date', 'date', 17], ['Contrôle', 'controle', 12], ['Résultat', 'resultat', 28], ['Référence', 'reference', 12],
      ['Lot', 'lot', 13], ['Colis', 'colis', 8], ['Emplacement scanné', 'scanne', 12], ['Emplacement prévu', 'prevu', 16],
      ['Écart', 'ecart', 8], ['Import / sortie', 'lieu', 18], ['Saisie', 'saisie', 10], ['Matricule', 'matricule', 12],
      ['Détail', 'message', 70],
    ];
    feuille.columns = colonnes.map(([, key, width]) => ({ key, width }));
    feuille.mergeCells(1, 1, 1, colonnes.length);
    feuille.getCell('A1').value = 'Journal des alertes du mobile';
    feuille.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FF06163A' } };
    feuille.getRow(1).height = 26;
    feuille.mergeCells(2, 1, 2, colonnes.length);
    feuille.getCell('A2').value = `Magasin Kablem · édité le ${maintenant()} · ${lignes.length} ligne(s) · ${descriptionFiltres(req.query, utilisateurs)}`;
    feuille.getCell('A2').font = { size: 10, color: { argb: 'FF5A6276' } };
    const entete = feuille.getRow(4);
    entete.values = colonnes.map(([t]) => t);
    entete.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    entete.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF06163A' } };
    entete.height = 22;
    const FOND = { rouge: 'FFFDE6E6', orange: 'FFFFF1DC', vert: 'FFE2F6EA' };
    for (const l of lignes) {
      const ligne = feuille.addRow({
        date: dateFr(l.date), controle: l.controle_libelle, resultat: l.titre, reference: l.reference ?? '', lot: l.lot ?? '',
        colis: l.colis ?? '', scanne: l.emplacement_scanne ?? '', prevu: l.emplacement_prevu ?? '',
        ecart: l.ecart ?? '', lieu: lieu(l), saisie: l.saisie_manuelle ? 'Manuelle' : 'Scan', matricule: l.matricule ?? '',
        par: l.par ?? '', message: l.message,
      });
      ligne.alignment = { vertical: 'top', wrapText: true };
      ligne.getCell('resultat').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FOND[l.couleur] ?? FOND.rouge } };
      ligne.getCell('resultat').font = { bold: true };
    }
    feuille.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: colonnes.length } };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFichier('xlsx')}"`);
    await classeur.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

router.get('/pdf', async (req, res, next) => {
  try {
    const lignes = await charger(req.query, null);
    const utilisateurs = await listeUtilisateurs();
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: 'Journal des alertes', Author: 'Magasin Kablem' } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFichier('pdf')}"`);
    doc.pipe(res);
    const NUIT = '#06163a';
    const ROUGE = '#e02222';
    const GRIS = '#5a6276';
    const gauche = doc.page.margins.left;
    const largeur = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bas = () => doc.page.height - doc.page.margins.bottom;

    doc.rect(gauche, 30, largeur, 3).fill(ROUGE);
    doc.fillColor(NUIT).font('Helvetica-Bold').fontSize(18).text('Journal des alertes du mobile', gauche, 44);
    doc.fillColor(GRIS).font('Helvetica').fontSize(9.5).text(
      `Magasin Kablem · édité le ${maintenant()} · ${lignes.length} ligne(s) · ${descriptionFiltres(req.query, utilisateurs)}`, gauche, 68, { width: largeur }
    );
    let y = 92;

    // Résumé par résultat
    const compte = {};
    for (const l of lignes) compte[l.titre] = { n: (compte[l.titre]?.n ?? 0) + 1, couleur: l.couleur };
    const cartes = Object.entries(compte).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
    if (cartes.length) {
      const lc = (largeur - 10 * (cartes.length - 1)) / cartes.length;
      cartes.forEach(([titre, { n, couleur }], k) => {
        const x = gauche + k * (lc + 10);
        doc.roundedRect(x, y, lc, 42, 6).fill('#f4f6fa');
        doc.rect(x, y, 4, 42).fill(COULEUR_PDF[couleur] ?? ROUGE);
        doc.fillColor(COULEUR_PDF[couleur] ?? ROUGE).font('Helvetica-Bold').fontSize(16).text(String(n), x + 12, y + 6, { width: lc - 18 });
        doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(titre.toUpperCase(), x + 12, y + 27, { width: lc - 18, lineBreak: false, ellipsis: true });
      });
      y += 56;
    }

    const colonnes = [['Date', 66], ['Contrôle', 54], ['Résultat', 98], ['Produit', 96], ['Empl. scanné', 54], ['Prévu', 62], ['Matricule', 92], ['Détail', 248]];
    const echelle = largeur / colonnes.reduce((t, [, l]) => t + l, 0);
    const cols = colonnes.map(([t, l]) => [t, l * echelle]);
    const entete = () => {
      doc.rect(gauche, y, largeur, 18).fill(NUIT);
      let x = gauche;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
      for (const [t, l] of cols) {
        doc.text(t.toUpperCase(), x + 4, y + 5.5, { width: l - 8, lineBreak: false });
        x += l;
      }
      y += 18;
    };
    if (!lignes.length) doc.fillColor(GRIS).font('Helvetica').fontSize(11).text('Aucune alerte pour ces critères.', gauche, y);
    else entete();
    lignes.forEach((l, k) => {
      const valeurs = [
        dateFr(l.date), l.controle_libelle, l.titre + (l.saisie_manuelle ? ' (saisie manuelle)' : ''),
        [l.reference, l.lot ? 'lot ' + l.lot : '', l.colis ? 'colis ' + l.colis : ''].filter(Boolean).join(' · '),
        l.emplacement_scanne ?? '', l.emplacement_prevu ?? '', l.matricule ?? '', l.message,
      ];
      doc.font('Helvetica').fontSize(8);
      const h = Math.max(...valeurs.map((v, i) => doc.heightOfString(String(v), { width: cols[i][1] - 8 })), 10) + 8;
      if (y + h > bas()) {
        doc.addPage();
        y = doc.page.margins.top;
        entete();
      }
      if (k % 2) doc.rect(gauche, y, largeur, h).fill('#f4f6fa');
      let x = gauche;
      valeurs.forEach((v, i) => {
        const res = i === 2;
        doc.font(res ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(res ? (COULEUR_PDF[l.couleur] ?? ROUGE) : '#14193a')
          .text(String(v), x + 4, y + 4, { width: cols[i][1] - 8 });
        x += cols[i][1];
      });
      y += h;
      doc.moveTo(gauche, y).lineTo(gauche + largeur, y).lineWidth(0.5).strokeColor('#dde1ea').stroke();
    });
    const pages = doc.bufferedPageRange();
    for (let k = 0; k < pages.count; k++) {
      doc.switchToPage(pages.start + k);
      doc.page.margins.bottom = 0;
      doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(`Page ${k + 1} / ${pages.count}`, gauche, doc.page.height - 24, { width: largeur, align: 'right', lineBreak: false });
    }
    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;
