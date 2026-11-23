// PDF du pointage d'un import par référence (page Import du web) : pour chaque référence, les pièces annoncées
// par l'Italie, les pièces et colis reçus (tickets scannés), l'écart, les lots reçus et le bilan.
// A4 paysage, mêmes couleurs que les autres PDF du magasin.
const PDFDocument = require('pdfkit');
const { nombre } = require('./import-resume');

const NAVY = '#0d2150';
const ROUGE = '#c81e1e';
const GRIS = '#5a6276';
const VERT = '#1d6b3a';
const STATUTS = { non_recue: 'Pas encore reçue', conforme: 'Conforme', tolere: 'Petit écart accepté', manquant: 'Manquant', en_trop: 'En trop' };
const COULEURS = { non_recue: GRIS, conforme: VERT, tolere: '#8a5a00', manquant: ROUGE, en_trop: '#b35600' };

const libelleType = (r) =>
  r.type === 'cosse' ? `Cosse · ${r.type_cosse === 'axiale' ? 'axiale' : 'plate'}` : r.type === 'bobine' ? `Bobine · ${r.taille_bobine ?? 'petite'}` : r.type === 'connecteur' ? 'Connecteur' : r.type ?? '';
const ecart = (r) => (r.ecart ? `${r.ecart > 0 ? '+' : '-'}${nombre(Math.abs(r.ecart))}` : '—');
const dateFr = (d) => (d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Tunis', dateStyle: 'short', timeStyle: 'short' }) : '');

// imp : { numero_livraison, date_creation, statut, reception, reception_par } ; pieces : bilan de reception-import (a.pieces)
// textes : { reception, rangement } (étapes, comme sur l'écran). Écrit le PDF dans le flux sortie.
function pdfPointage(sortie, imp, pieces, textes, colisRecus) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: `Pointage ${imp.numero_livraison ?? ''}`, Author: 'Magasin Kablem' } });
  doc.pipe(sortie);
  const gauche = doc.page.margins.left;
  const largeur = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bas = () => doc.page.height - doc.page.margins.bottom;
  const colonnes = [['Type', 80], ['Référence', 90], ['Annoncées', 70, 'right'], ['Reçues', 70, 'right'], ['Colis', 42, 'right'], ['Écart', 64, 'right'], ['Lots reçus (colis)', 190], ['Bilan', 90]];
  const echelle = largeur / colonnes.reduce((s, [, l]) => s + l, 0);
  const cols = colonnes.map(([t, l, a]) => [t, l * echelle, a ?? 'left']);

  // En-tête
  doc.rect(gauche, 30, largeur, 3).fill(ROUGE);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text(imp.numero_livraison ? `Pointage de la livraison ${imp.numero_livraison}` : `Pointage de l'import n° ${imp.id}`, gauche, 44);
  let y = 74;

  const ligne = (valeurs, o = {}) => {
    doc.font(o.gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.taille ?? 8.5);
    const h = Math.max(...valeurs.map((v, k) => doc.heightOfString(String(v ?? ''), { width: cols[k][1] - 8 }))) + 8;
    if (y + h > bas()) {
      doc.addPage();
      y = doc.page.margins.top;
      if (!o.entete) entete();
    }
    if (o.fond) doc.rect(gauche, y, largeur, h).fill(o.fond);
    let x = gauche;
    valeurs.forEach((v, k) => {
      const couleur = o.couleurs?.[k] ?? o.couleur ?? '#141a2b';
      doc.fillColor(couleur).font(o.grasCol?.includes(k) || o.gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.taille ?? 8.5).text(String(v ?? ''), x + 4, y + 4, { width: cols[k][1] - 8, align: cols[k][2] });
      x += cols[k][1];
    });
    doc.moveTo(gauche, y + h).lineTo(gauche + largeur, y + h).lineWidth(0.5).strokeColor('#dde1ea').stroke();
    y += h;
  };
  const entete = () => ligne(cols.map(([t]) => t.toUpperCase()), { gras: true, taille: 7.5, fond: '#eef1f7', couleur: GRIS, entete: true });

  entete();
  for (const r of pieces.references) {
    const lots = r.lots.length ? r.lots.map((l) => `${l.lot} ×${l.colis}`).join('   ') : '—';
    ligne(
      [libelleType(r), r.reference, nombre(r.attendues), nombre(r.recues), r.colis, ecart(r), lots, STATUTS[r.statut] ?? r.statut],
      { grasCol: [1, 2, 3, 7], couleurs: { 5: r.ecart ? ROUGE : GRIS, 7: COULEURS[r.statut] ?? GRIS } }
    );
  }
  ligne(
    [`Total (${pieces.references.length} réf.)`, '', nombre(pieces.attendues), nombre(pieces.recues), colisRecus,
      pieces.recues - pieces.attendues ? `${pieces.recues > pieces.attendues ? '+' : '-'}${nombre(Math.abs(pieces.recues - pieces.attendues))}` : '—',
      pieces.a_reclamer ? `${pieces.a_reclamer} référence(s) hors de l'écart accepté` : 'Aucun écart', ''],
    { gras: true, fond: '#f6f7fb' }
  );

  // Numéros de page
  const pages = doc.bufferedPageRange();
  for (let k = 0; k < pages.count; k++) {
    doc.switchToPage(pages.start + k);
    doc.page.margins.bottom = 0;
    doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(
      `Pointage ${imp.numero_livraison ?? ''} · page ${k + 1} / ${pages.count}`, gauche, doc.page.height - 26, { width: largeur, align: 'right', lineBreak: false }
    );
  }
  doc.end();
}

module.exports = { pdfPointage };
