// Lecture du QR du ticket vert et du QR d'un emplacement.
//
// Ticket vert réel (fournisseur, ex. TE Connectivity Italia), QR du bas :
//     F0391;13000;10;202613167;1
//     référence ; confection (quantité dans le colis) ; n° de colis ; lot ; suffixe du lot (« 202613167-1 »)
// Un ticket = un colis. Le n° de colis rend chaque ticket unique : un colis ne peut pas être
// compté deux fois, et on compte les colis reçus par rapport à la quantité de la ligne d'import.
// Le QR du haut (« Codice Articolo ») ne contient que la référence : il est reconnu et refusé
// avec un message clair.
//
// Formats simples acceptés aussi (saisie manuelle, anciens essais) — un ticket par lot :
//   - JSON :            {"reference":"F0411","lotto":"202613252","qta":3}
//   - clé = valeur :    REF:F0411;LOTTO:202613252;QTA:3
//   - valeurs seules :  F0411;202613252;3   (référence, lot, quantité)

const { codeDuNumero } = require('./plan');

const CLES = {
  reference: ['reference', 'référence', 'ref', 'codice', 'code', 'articolo', 'article'],
  lot: ['lot', 'lotto', 'batch'],
  quantite: ['quantite', 'quantité', 'qte', 'qté', 'qta', 'qty', 'quantita', 'quantità', 'quantity'],
};

// Référence article : commence par une lettre et contient un chiffre (F0391, CFLR9YAT30035800002T)
const REFERENCE = /^(?=.*\d)[A-Z][A-Z0-9]{2,39}$/i;
const normaliserCle = (k) => String(k).trim().toLowerCase();
const champDe = (cle) => Object.keys(CLES).find((champ) => CLES[champ].includes(normaliserCle(cle)));

// "2 300" ou "2300,0" -> 2300 ; null si ce n'est pas un nombre entier positif
function lireQuantite(v) {
  const n = Number(String(v ?? '').replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

function complet(t) {
  const reference = String(t.reference ?? '').trim().toUpperCase();
  const lot = String(t.lot ?? '').trim();
  const quantite = lireQuantite(t.quantite);
  return reference && lot && quantite ? { reference, lot, quantite, colis: null, confection: null, suffixe: null, cle: null } : null;
}

// Ticket du fournisseur : référence ; confection ; n° de colis ; lot ; suffixe
function ticketColis(morceaux) {
  if (morceaux.length !== 5) return null;
  const [ref, confection, colis, lot, suffixe] = morceaux;
  if (!REFERENCE.test(ref) || !/^\d{5,12}$/.test(lot) || !/^\d{1,6}$/.test(colis) || !/^\d{1,4}$/.test(suffixe)) return null;
  const reference = ref.toUpperCase();
  return {
    reference,
    lot,
    quantite: 1, // un ticket = un colis = un produit
    colis: Number(colis),
    confection: lireQuantite(confection),
    suffixe,
    cle: `${reference}|${lot}-${suffixe}|${Number(colis)}`, // identifiant unique du colis
  };
}

// Renvoie le ticket lu, ou null si le texte n'est pas un ticket lisible
function lireTicket(texte) {
  const brut = String(texte ?? '').trim();
  if (!brut) return null;

  // JSON
  if (brut.startsWith('{')) {
    try {
      const objet = JSON.parse(brut);
      const t = {};
      for (const [k, v] of Object.entries(objet)) {
        const champ = champDe(k);
        if (champ) t[champ] = v;
      }
      return complet(t);
    } catch {
      return null;
    }
  }

  const morceaux = brut.split(/[;|\n\r\t]+|,(?!\d{1,2}\b)/).map((m) => m.trim()).filter(Boolean);

  const colis = ticketColis(morceaux);
  if (colis) return colis;

  // clé : valeur  /  clé = valeur
  const paires = morceaux.map((m) => /^([^:=]+?)\s*[:=]\s*(.+)$/.exec(m)).filter(Boolean);
  if (paires.length) {
    const t = {};
    for (const [, k, v] of paires) {
      const champ = champDe(k);
      if (champ) t[champ] = v;
    }
    return complet(t);
  }

  // valeurs seules, dans l'ordre référence, lot, quantité
  if (morceaux.length === 3) return complet({ reference: morceaux[0], lot: morceaux[1], quantite: morceaux[2] });
  return null;
}

// QR « Codice Articolo » du ticket : la référence seule (ex. « F0391 »)
const estQrArticle = (texte) => REFERENCE.test(String(texte ?? '').trim());

// Lots de la base qui correspondent au ticket : « 202613167 » ou « 202613167-1 »
function lotsDuTicket(ticket) {
  return ticket.suffixe ? [ticket.lot, `${ticket.lot}-${ticket.suffixe}`] : [ticket.lot];
}
const memeLot = (lotBase, ticket) => lotsDuTicket(ticket).includes(String(lotBase).trim());

// QR d'un emplacement : "D011", "EMPL:D011", "EMPLACEMENT=D011" ou {"emplacement":"D011"}
// ou le lien imprimé sur l'étiquette : « https://magasin…/e/D011 » (ouvert par l'appareil photo du téléphone)
// ou le numéro du magasin imprimé sur l'étiquette du rayonnage : « 0012 », « AC » (traduit en code : A110, E313)
function lireEmplacement(texte) {
  const numero = codeDuNumero(texte);
  if (numero) return numero;
  let brut = String(texte ?? '').trim();
  const lien = /^https?:\/\/.*\/e\/([A-Z]\d{3}|T\d{2})\/?(?:[?#].*)?$/i.exec(brut);
  if (lien) return lien[1].toUpperCase();
  if (brut.startsWith('{')) {
    try {
      const o = JSON.parse(brut);
      brut = String(o.emplacement ?? o.code ?? '');
    } catch {
      return null;
    }
  }
  brut = brut.replace(/^(empl(acement)?|emp|loc)\s*[:=\-]\s*/i, '');
  const code = brut.trim().toUpperCase();
  return /^[A-Z]\d{3}$|^T\d{2}$/.test(code) ? code : null;
}

// Message d'un QR qui n'est pas un ticket produit
function messageIllisible(texte) {
  if (estQrArticle(texte)) {
    return `Vous avez scanné le QR « Codice Articolo » (${String(texte).trim().toUpperCase()}). Scannez le QR du bas du ticket, celui avec le lot.`;
  }
  if (lireEmplacement(texte)) return "C'est l'étiquette d'un emplacement : scannez le ticket vert du produit.";
  return 'Ce QR n\'est pas un ticket vert lisible (référence, lot, colis). Rescannez le QR du bas du ticket ou saisissez-le à la main.';
}

module.exports = { lireTicket, lireEmplacement, lireQuantite, estQrArticle, lotsDuTicket, memeLot, messageIllisible };
