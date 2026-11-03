const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('../db');
const { exigerGestionnaire } = require('../middleware/auth');
const { delaiReclamation } = require('../parametres');

const router = express.Router();

const STATUTS = { ouverte: 'Ouverte', envoyee: "Envoyée à l'Italie", reglee: 'Réglée' };
const SOLUTIONS = { avoir: 'Avoir', renvoi: 'Renvoi', remplacement: 'Remplacement', autre: 'Autre' };

const MOTIFS = {
  manquant: 'Manquant',
  non_conforme: 'Non conforme / produit différent',
  endommage: 'Endommagé',
  non_commande: 'Non commandé (en trop)',
  autre: 'Autre',
};
const TYPES = { bobine: 'Bobine', cosse: 'Cosse', connecteur: 'Connecteur' };
const TAILLES = { grande: 'Grande', moyenne: 'Moyenne', petite: 'Petite' };

function libelleProduit(p) {
  // réclamation créée par le mobile pour un produit sans ligne d'import (colis en trop, hors import)
  if (!p.type) return 'Hors import';
  return TYPES[p.type] + (p.taille_bobine ? ' · ' + TAILLES[p.taille_bobine] : '');
}

// "2026-10-13T13:00:00" -> "13/10/2026 13:00"
function dateFr(iso) {
  if (!iso) return '';
  const [j, h] = iso.split('T');
  const [a, m, d] = j.split('-');
  return `${d}/${m}/${a} ${h.slice(0, 5)}`;
}

// Réclamations filtrées, regroupées par import (les plus récents d'abord).
// Filtres : reference, motif, du, au (date de l'import, AAAA-MM-JJ), import (numéro).
async function chargerReclamations(filtres = {}) {
  const delai = await delaiReclamation();
  const conditions = [];
  const valeurs = [];
  if (filtres.reference) {
    conditions.push('COALESCE(r.reference, rc.reference) LIKE ?');
    valeurs.push(`%${String(filtres.reference).trim().toUpperCase()}%`);
  }
  if (filtres.motif && MOTIFS[filtres.motif]) {
    conditions.push('rc.motif = ?');
    valeurs.push(filtres.motif);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(filtres.du || '')) {
    conditions.push('DATE(i.date_creation) >= ?');
    valeurs.push(filtres.du);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(filtres.au || '')) {
    conditions.push('DATE(i.date_creation) <= ?');
    valeurs.push(filtres.au);
  }
  if (STATUTS[filtres.statut]) {
    conditions.push('rc.statut = ?');
    valeurs.push(filtres.statut);
  }
  if (filtres.statut === 'en_retard') {
    conditions.push("rc.statut <> 'reglee' AND DATEDIFF(CURDATE(), DATE(rc.date_creation)) > ?");
    valeurs.push(delai);
  }
  if (Number(filtres.import) > 0) {
    conditions.push('i.id = ?');
    valeurs.push(Number(filtres.import));
  }
  const [lignes] = await db.query(
    `SELECT i.id AS import_id, i.statut AS statut_import, i.numero_livraison,
            DATE_FORMAT(i.date_creation, '%Y-%m-%dT%H:%i:%s') AS date_import,
            DATE_FORMAT(i.date_ajout_stock, '%Y-%m-%dT%H:%i:%s') AS date_ajout_stock,
            rc.id, r.id AS reception_id, r.type, r.taille_bobine,
            COALESCE(r.reference, rc.reference) AS reference, COALESCE(r.lot, rc.lot) AS lot,
            COALESCE(r.quantite, 0) AS quantite_annoncee, rc.quantite, rc.motif, rc.commentaire, rc.origine,
            DATE_FORMAT(rc.date_creation, '%Y-%m-%dT%H:%i:%s') AS date_reclamation,
            u.matricule AS par,
            rc.statut, rc.solution, rc.note_suivi,
            DATE_FORMAT(rc.date_envoi, '%Y-%m-%dT%H:%i:%s') AS date_envoi,
            DATE_FORMAT(rc.date_reglement, '%Y-%m-%dT%H:%i:%s') AS date_reglement,
            DATE_FORMAT(rc.date_suivi, '%Y-%m-%dT%H:%i:%s') AS date_suivi,
            s.matricule AS suivi_par,
            DATEDIFF(CURDATE(), DATE(rc.date_creation)) AS age_jours
     FROM reclamations rc
     LEFT JOIN receptions r ON r.id = rc.reception_id
     JOIN imports i ON i.id = COALESCE(r.import_id, rc.import_id)
     LEFT JOIN utilisateurs u ON u.id = rc.utilisateur_id
     LEFT JOIN utilisateurs s ON s.id = rc.suivi_par
     ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
     ORDER BY i.date_creation DESC, i.id DESC, COALESCE(r.reference, rc.reference), COALESCE(r.lot, rc.lot), rc.id`,
    valeurs
  );
  const imports = new Map();
  for (const l of lignes) {
    if (!imports.has(l.import_id)) {
      imports.set(l.import_id, {
        import_id: l.import_id,
        statut: l.statut_import,
        date_import: l.date_import,
        date_ajout_stock: l.date_ajout_stock,
        numero_livraison: l.numero_livraison,
        produits: [],
      });
    }
    const { import_id, statut_import, date_import, date_ajout_stock, numero_livraison, ...produit } = l;
    produit.en_retard = produit.statut !== 'reglee' && produit.age_jours > delai;
    imports.get(import_id).produits.push(produit);
  }
  return [...imports.values()];
}

function nomFichier(extension) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `reclamations-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${extension}`;
}

// GET /api/reclamations?reference=&motif=&du=&au=&import=
router.get('/', async (req, res, next) => {
  try {
    res.json(await chargerReclamations(req.query));
  } catch (err) { next(err); }
});

// PUT /api/reclamations/:id/suivi  { statut, solution?, note? } (administrateur, chef de magasin)
// Ouverte -> Envoyée à l'Italie -> Réglée (avec la solution : avoir, renvoi, remplacement, autre).
// Possible à tout moment, même après l'ajout de l'import au stock : c'est le suivi avec le fournisseur.
router.put('/:id/suivi', exigerGestionnaire(), async (req, res, next) => {
  try {
    const statut = req.body?.statut;
    const solution = req.body?.solution || null;
    const note = String(req.body?.note ?? '').trim() || null;
    if (!STATUTS[statut]) return res.status(400).json({ message: 'Statut invalide (ouverte, envoyée, réglée)' });
    if (statut === 'reglee' && !SOLUTIONS[solution]) {
      return res.status(400).json({ message: 'Indiquez la solution : avoir, renvoi, remplacement ou autre' });
    }
    if (note && note.length > 255) return res.status(400).json({ message: 'La note ne doit pas dépasser 255 caractères' });
    const [[rc]] = await db.query('SELECT id FROM reclamations WHERE id = ?', [req.params.id]);
    if (!rc) return res.status(404).json({ message: 'Réclamation introuvable' });

    // Dates de chaque étape : posées au premier passage, effacées si l'on revient en arrière
    const dates = {
      ouverte: 'date_envoi = NULL, date_reglement = NULL, solution = NULL',
      envoyee: 'date_envoi = COALESCE(date_envoi, NOW()), date_reglement = NULL, solution = NULL',
      reglee: 'date_reglement = COALESCE(date_reglement, NOW()), solution = ?',
    }[statut];
    await db.query(
      `UPDATE reclamations SET statut = ?, ${dates}, note_suivi = ?, suivi_par = ?, date_suivi = NOW() WHERE id = ?`,
      statut === 'reglee'
        ? [statut, solution, note, req.utilisateur.id, rc.id]
        : [statut, note, req.utilisateur.id, rc.id]
    );
    res.json({ id: rc.id, statut, solution: statut === 'reglee' ? solution : null, note });
  } catch (err) { next(err); }
});

// GET /api/reclamations/compteurs : nombre de réclamations par statut et en retard (filtres de la page)
router.get('/compteurs', async (req, res, next) => {
  try {
    const delai = await delaiReclamation();
    const [[c]] = await db.query(
      `SELECT SUM(statut = 'ouverte') AS ouvertes, SUM(statut = 'envoyee') AS envoyees, SUM(statut = 'reglee') AS reglees,
              SUM(statut <> 'reglee' AND DATEDIFF(CURDATE(), DATE(date_creation)) > ?) AS en_retard
       FROM reclamations`,
      [delai]
    );
    res.json({
      ouvertes: Number(c.ouvertes ?? 0),
      envoyees: Number(c.envoyees ?? 0),
      reglees: Number(c.reglees ?? 0),
      en_retard: Number(c.en_retard ?? 0),
      delai_jours: delai,
    });
  } catch (err) { next(err); }
});

// GET /api/reclamations/excel : même filtres, fichier .xlsx
router.get('/excel', async (req, res, next) => {
  try {
    const imports = await chargerReclamations(req.query);
    const classeur = new ExcelJS.Workbook();
    classeur.creator = 'Magasin Kablem';
    const feuille = classeur.addWorksheet('Réclamations', { views: [{ state: 'frozen', ySplit: 1 }] });
    feuille.columns = [
      { header: 'Import', key: 'import', width: 9 },
      { header: "Date de l'import", key: 'date_import', width: 17 },
      { header: 'Statut', key: 'statut', width: 16 },
      { header: 'Type', key: 'type', width: 18 },
      { header: 'Référence', key: 'reference', width: 14 },
      { header: 'Lot', key: 'lot', width: 14 },
      { header: 'Qté annoncée', key: 'annoncee', width: 13 },
      { header: 'Qté réclamée', key: 'reclamee', width: 13 },
      { header: 'Motif', key: 'motif', width: 30 },
      { header: 'Commentaire', key: 'commentaire', width: 45 },
      { header: 'Réclamé par', key: 'par', width: 22 },
      { header: 'Date de la réclamation', key: 'date', width: 20 },
      { header: 'Statut', key: 'statut_rc', width: 18 },
      { header: "Envoyée à l'Italie le", key: 'envoi', width: 18 },
      { header: 'Réglée le', key: 'reglement', width: 17 },
      { header: 'Solution', key: 'solution', width: 15 },
      { header: 'Note de suivi', key: 'note', width: 40 },
      { header: 'En retard', key: 'retard', width: 10 },
    ];
    for (const i of imports) {
      for (const p of i.produits) {
        feuille.addRow({
          import: i.import_id,
          date_import: dateFr(i.date_import),
          statut: i.statut === 'ajoute' ? 'Ajouté au stock' : 'En attente',
          type: libelleProduit(p),
          reference: p.reference,
          lot: p.lot,
          annoncee: p.quantite_annoncee,
          reclamee: p.quantite,
          motif: MOTIFS[p.motif],
          commentaire: p.commentaire || '',
          par: p.par || '',
          date: dateFr(p.date_reclamation),
          statut_rc: STATUTS[p.statut],
          envoi: dateFr(p.date_envoi),
          reglement: dateFr(p.date_reglement),
          solution: SOLUTIONS[p.solution] || '',
          note: p.note_suivi || '',
          retard: p.en_retard ? 'Oui' : '',
        });
      }
    }
    const entete = feuille.getRow(1);
    entete.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    entete.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D2150' } };
    entete.alignment = { vertical: 'middle' };
    entete.height = 22;
    feuille.getColumn('commentaire').alignment = { wrapText: true, vertical: 'top' };
    feuille.autoFilter = { from: 'A1', to: 'R1' };
    feuille.getColumn('note').alignment = { wrapText: true, vertical: 'top' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFichier('xlsx')}"`);
    await classeur.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// GET /api/reclamations/pdf : même filtres, fichier .pdf (A4 paysage, un bloc par import)
router.get('/pdf', async (req, res, next) => {
  try {
    const imports = await chargerReclamations(req.query);
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: 'Réclamations', Author: 'Magasin Kablem' } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFichier('pdf')}"`);
    doc.pipe(res);
    dessinerPdf(doc, imports, req.query);
  } catch (err) { next(err); }
});

// PDF en mémoire (pièce jointe du mail)
function pdfEnMemoire(imports, filtres) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: 'Réclamation', Author: 'Kab-lem Tunisia' } });
    const morceaux = [];
    doc.on('data', (m) => morceaux.push(m));
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);
    dessinerPdf(doc, imports, filtres);
  });
}

function dessinerPdf(doc, imports, filtresDemandes) {
  const req = { query: filtresDemandes };
  {

    const NAVY = '#0d2150';
    const ROUGE = '#c81e1e';
    const GRIS = '#5a6276';
    const gauche = doc.page.margins.left;
    const largeur = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bas = () => doc.page.height - doc.page.margins.bottom;
    const colonnes = [
      ['Type', 85], ['Référence', 65], ['Lot', 70], ['Annoncée', 52], ['Réclamée', 52],
      ['Motif', 115], ['Commentaire', 150], ['Statut', 110], ['Par', 80],
    ];
    const echelle = largeur / colonnes.reduce((s, [, l]) => s + l, 0);
    const cols = colonnes.map(([t, l]) => [t, l * echelle]);

    // En-tête du document
    doc.rect(gauche, 30, largeur, 3).fill(ROUGE);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text('Réclamations des imports', gauche, 44);
    const total = imports.reduce((s, i) => s + i.produits.length, 0);
    const filtres = [];
    if (req.query.reference) filtres.push(`référence « ${req.query.reference} »`);
    if (MOTIFS[req.query.motif]) filtres.push(`motif « ${MOTIFS[req.query.motif]} »`);
    if (req.query.du) filtres.push(`du ${req.query.du.split('-').reverse().join('/')}`);
    if (req.query.au) filtres.push(`au ${req.query.au.split('-').reverse().join('/')}`);
    doc.fillColor(GRIS).font('Helvetica').fontSize(9.5).text(
      `Magasin Kablem · édité le ${dateFr(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19))} · ` +
        `${imports.length} import(s), ${total} produit(s) réclamé(s)` + (filtres.length ? ` · filtres : ${filtres.join(', ')}` : ''),
      gauche, 68
    );
    let y = 92;

    const ligneTableau = (valeurs, options = {}) => {
      doc.font(options.gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.taille ?? 8.5);
      const hauteurs = valeurs.map((v, k) => doc.heightOfString(String(v ?? ''), { width: cols[k][1] - 8 }));
      const h = Math.max(...hauteurs) + 8;
      if (y + h > bas()) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      if (options.fond) doc.rect(gauche, y, largeur, h).fill(options.fond);
      let x = gauche;
      valeurs.forEach((v, k) => {
        doc.fillColor(options.couleur ?? '#141a2b').text(String(v ?? ''), x + 4, y + 4, { width: cols[k][1] - 8 });
        x += cols[k][1];
      });
      doc.moveTo(gauche, y + h).lineTo(gauche + largeur, y + h).lineWidth(0.5).strokeColor('#dde1ea').stroke();
      y += h;
    };

    if (!imports.length) {
      doc.fillColor(GRIS).font('Helvetica').fontSize(11).text('Aucune réclamation pour ces critères.', gauche, y);
    }
    for (const i of imports) {
      if (y + 60 > bas()) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      y += 6;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11.5).text(
        `Import n° ${i.import_id} du ${dateFr(i.date_import)}` + (i.numero_livraison ? ` · livraison ${i.numero_livraison}` : ''), gauche, y, { continued: true }
      ).fillColor(GRIS).font('Helvetica').fontSize(9.5).text(
        `   ${i.statut === 'ajoute' ? `ajouté au stock le ${dateFr(i.date_ajout_stock)}` : 'en attente'} · ${i.produits.length} produit(s) réclamé(s)`
      );
      y = doc.y + 4;
      ligneTableau(cols.map(([t]) => t.toUpperCase()), { gras: true, taille: 7.5, fond: '#eef1f7', couleur: GRIS });
      for (const p of i.produits) {
        ligneTableau([
          libelleProduit(p), p.reference, p.lot, p.quantite_annoncee, p.quantite,
          MOTIFS[p.motif], p.commentaire || '-',
          STATUTS[p.statut] + (p.solution ? ` (${SOLUTIONS[p.solution]})` : '') + (p.en_retard ? ` - en retard (${p.age_jours} j)` : ''),
          p.par || '',
        ]);
      }
      y += 8;
    }

    // Numéros de page
    const pages = doc.bufferedPageRange();
    for (let k = 0; k < pages.count; k++) {
      doc.switchToPage(pages.start + k);
      doc.page.margins.bottom = 0; // écrire sous la marge sans créer de nouvelle page
      doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(
        `Page ${k + 1} / ${pages.count}`, gauche, doc.page.height - 26, { width: largeur, align: 'right', lineBreak: false }
      );
    }
    doc.end();
  }
}

// ---------- Mail de réclamation (brouillon Outlook) ----------
// Un fichier .eml marqué « non envoyé » (X-Unsent) : Outlook l'ouvre comme un nouveau message
// à compléter. Objet, texte et PDF joint sont prêts ; le destinataire est laissé vide.
const echapper = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const enteteUtf8 = (t) => `=?UTF-8?B?${Buffer.from(t, 'utf8').toString('base64')}?=`;
const base64Lignes = (buffer) => buffer.toString('base64').replace(/.{76}/g, '$&\r\n');

function contenuMail(i, expediteur) {
  const refLivraison = i.numero_livraison ? `livraison ${i.numero_livraison}` : `import n° ${i.import_id}`;
  const objet = `Réclamation - ${i.numero_livraison ? 'Livraison ' + i.numero_livraison : 'Import n° ' + i.import_id} du ${dateFr(i.date_import).slice(0, 10)} - Kab-lem Tunisia`;
  const total = i.produits.reduce((t, p) => t + Number(p.quantite), 0);

  const cellule = 'padding:7px 10px;border:1px solid #dde1ea;';
  const lignes = i.produits.map((p) => `
      <tr>
        <td style="${cellule}">${echapper(libelleProduit(p))}</td>
        <td style="${cellule}font-weight:bold;">${echapper(p.reference)}</td>
        <td style="${cellule}">${echapper(p.lot)}</td>
        <td style="${cellule}text-align:center;">${p.quantite_annoncee}</td>
        <td style="${cellule}text-align:center;font-weight:bold;color:#c81e1e;">${p.quantite}</td>
        <td style="${cellule}">${echapper(MOTIFS[p.motif])}</td>
        <td style="${cellule}">${echapper(p.commentaire || '-')}</td>
      </tr>`).join('');
  const entete = (t) => `<th style="${cellule}background:#0d2150;color:#ffffff;text-align:left;font-size:12px;">${t}</th>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#141a2b;">
  <p>Bonjour,</p>
  <p>Lors de la réception de la ${echapper(refLivraison)} (reçue le ${dateFr(i.date_import)}), nous avons constaté les anomalies suivantes :</p>
  <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;">
    <tr>${['Type', 'Référence', 'Lot', 'Qté annoncée', 'Qté réclamée', 'Motif', 'Commentaire'].map(entete).join('')}</tr>${lignes}
  </table>
  <p><b>Total réclamé : ${total} produit(s)</b> sur ${i.produits.length} ligne(s).</p>
  <p>Vous trouverez le détail dans le document PDF joint.</p>
  <p>Merci de nous indiquer la suite donnée à cette réclamation (avoir, renvoi ou remplacement).</p>
  <p>Cordialement,</p>
  <p>${echapper(expediteur)}<br>Magasin - Kab-lem Tunisia<br>Menzel Jemil</p>
</body></html>`;
  return { objet, html };
}

// GET /api/reclamations/mail?import=ID : brouillon de mail (.eml) avec le PDF de la réclamation en pièce jointe
router.get('/mail', async (req, res, next) => {
  try {
    const id = Number(req.query.import);
    if (!(id > 0)) return res.status(400).json({ message: "Indiquez l'import" });
    const [i] = await chargerReclamations({ import: id });
    if (!i) return res.status(404).json({ message: 'Aucune réclamation pour cet import' });

    const expediteur = req.utilisateur.matricule ? `Matricule ${req.utilisateur.matricule}` : '';
    const { objet, html } = contenuMail(i, expediteur);
    const pdf = await pdfEnMemoire([i], { import: id });
    const nom = `reclamation-${i.numero_livraison || 'import-' + i.import_id}`;
    const frontiere = 'kablem-' + Date.now().toString(36);

    const eml = [
      'X-Unsent: 1',
      'To: ',
      `Subject: ${enteteUtf8(objet)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${frontiere}"`,
      '',
      `--${frontiere}`,
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lignes(Buffer.from(html, 'utf8')),
      '',
      `--${frontiere}`,
      `Content-Type: application/pdf; name="${nom}.pdf"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${nom}.pdf"`,
      '',
      base64Lignes(pdf),
      '',
      `--${frontiere}--`,
      '',
    ].join('\r\n');

    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="${nom}.eml"`);
    res.send(eml);
  } catch (err) { next(err); }
});

module.exports = router;
