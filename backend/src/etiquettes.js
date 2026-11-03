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

module.exports = { pdfEtiquettesTampon };
