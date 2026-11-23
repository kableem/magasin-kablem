// Étiquettes QR des places de la zone tampon, imprimables depuis le web (même dessin que la planche
// complète de scripts/etiquettes-emplacements.js). Le QR contient seulement le code de la place (« T31 »).
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const JAUNE = '#FFD21F';

// Écrit dans `sortie` (réponse HTTP) un PDF A4 de 12 étiquettes par page pour ces codes
async function pdfEtiquettesTampon(codes, sortie) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Étiquettes QR · zone tampon', Author: 'Kab-lem Tunisia' } });
  doc.pipe(sortie);
  const L = doc.page.width;
  const H = doc.page.height;
  const marge = 28;
  const colonnes = 3;
  const lignes = 4;
  const ecart = 10;
  const haut = marge; // pas d'en-tête : la page ne contient que les étiquettes
  const largeur = (L - 2 * marge - (colonnes - 1) * ecart) / colonnes;
  const hauteur = (H - haut - marge - (lignes - 1) * ecart) / lignes;
  const parPage = colonnes * lignes;

  for (let debut = 0; debut < codes.length; debut += parPage) {
    if (debut) doc.addPage({ size: 'A4', margin: 0 });
    const page = codes.slice(debut, debut + parPage);

    for (let k = 0; k < page.length; k++) {
      const code = page[k];
      const x = marge + (k % colonnes) * (largeur + ecart);
      const y = haut + Math.floor(k / colonnes) * (hauteur + ecart);
      doc.save().lineWidth(0.6).dash(3, { space: 3 }).strokeColor('#9aa3b5').rect(x - 3, y - 3, largeur + 6, hauteur + 6).stroke().restore();
      doc.roundedRect(x, y, largeur, hauteur, 8).fill(JAUNE);
      doc.rect(x, y, 9, hauteur).fill('#111111');
      doc.fillColor('#111111').font('Helvetica-Bold').fontSize(40).text(code, x + 9, y + 10, { width: largeur - 9, align: 'center' });
      const cote = Math.min(largeur - 46, hauteur - 104);
      const qx = x + 9 + (largeur - 9 - cote) / 2;
      const qy = y + 60;
      const png = await QRCode.toBuffer(code, { errorCorrectionLevel: 'M', margin: 1, scale: 8, color: { dark: '#000000', light: '#ffffff' } });
      doc.roundedRect(qx - 6, qy - 6, cote + 12, cote + 12, 6).fill('#ffffff');
      doc.image(png, qx, qy, { width: cote, height: cote });
      doc.fillColor('#111111').font('Helvetica-Bold').fontSize(9).text('ATTENTE DE RANGEMENT', x + 9, y + hauteur - 30, { width: largeur - 9, align: 'center' });
      doc.fillColor('#333333').font('Helvetica').fontSize(8).text('Zone tampon (au sol)', x + 9, y + hauteur - 17, { width: largeur - 9, align: 'center' });
    }
  }
  doc.end();
}

// Étiquettes de cartons de cosses, au format des tickets verts (115 × 75 mm, une étiquette par page).
// QR : « référence;lot;pièces;JJ/MM/AAAA HH:MM:SS.mmm » (date système de la 1re impression : QR unique).
const MM = 72 / 25.4;
async function pdfEtiquettesCartons(cartons, sortie) {
  const L = 115 * MM;
  const H = 75 * MM;
  const doc = new PDFDocument({ size: [L, H], margin: 0, autoFirstPage: false, info: { Title: 'Étiquettes de cartons', Author: 'Kab-lem Tunisia' } });
  // Impression en taille réelle par défaut (pas « Ajuster à la page », qui agrandit l'étiquette)
  doc._root.data.ViewerPreferences = doc.ref({ PrintScaling: 'None' });
  doc.pipe(sortie);
  for (const c of cartons) {
    doc.addPage({ size: [L, H], margin: 0 });
    const m = 4 * MM;
    const cote = 32 * MM; // QR de 32 mm : bien lu par le téléphone, sans prendre toute l'étiquette
    const png = await QRCode.toBuffer(c.qr, { errorCorrectionLevel: 'M', margin: 1, scale: 10 });
    doc.image(png, m, m, { width: cote, height: cote });
    doc.fillColor('#111111').font('Helvetica').fontSize(6).text(c.qr, m, m + cote + 1.5 * MM, { width: cote, align: 'center' });
    // Texte à droite du QR
    const x = m + cote + 4 * MM;
    const l = L - x - m;
    let y = m;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111').text(`CARTON N° ${c.numero}`, x, y, { width: l });
    y += 6.5 * MM;
    const ligne = (titre, valeur, taille = 13) => {
      doc.font('Helvetica').fontSize(7).fillColor('#444444').text(titre, x, y, { width: l });
      y += 3 * MM;
      doc.font('Helvetica-Bold').fontSize(taille).fillColor('#111111').text(valeur, x, y, { width: l });
      y += taille + 4; // hauteur du texte, puis un petit espace
    };
    ligne('Codice Articolo', c.reference, 16);
    ligne('Lotto', c.lot, 11);
    ligne('Contenu', `${c.cosses} cosse${c.cosses > 1 ? 's' : ''}`, 12);
    ligne('Pièces', String(c.pieces).replace(/\B(?=(\d{3})+(?!\d))/g, ' '), 12); // « 15 000 »
    ligne('Imprimé le', c.date_etiquette, 9);
    doc.font('Helvetica').fontSize(6.5).fillColor('#444444')
      .text(`Import ${c.numero_livraison ?? 'n° ' + c.import_id}`, x, H - m - 3 * MM, { width: l });
  }
  doc.end();
}

module.exports = { pdfEtiquettesTampon, pdfEtiquettesCartons };
