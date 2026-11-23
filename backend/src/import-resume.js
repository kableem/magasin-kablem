// Import « résumé » : le fichier de l'Italie ne donne que la référence et le total de pièces
// (« Codice » / « Somma di quantità »), sans lot ni nombre de colis.
// Le lot, le n° de colis et les pièces de chaque colis sont lus sur le ticket vert à la réception ;
// à la fin, les pièces reçues de chaque référence sont comparées au total annoncé, avec une tolérance.
const { normaliserReference } = require('./articles');

// Référence : commence par une lettre ou un chiffre, contient un chiffre (« AK 15317766 », « YA/7116-4121-02 », « CAVFLR12Y0,5 N »)
const REFERENCE = /^(?=.*\d)[A-Z0-9][A-Z0-9 .,/_-]{1,49}$/;
// Lignes à ignorer : totaux du tableau croisé dynamique d'Excel
const TOTAL = /^(totale?|total général|grand total|somma)\b/i;

// « 45 000 », « 45.000 » (italien), « 45,000 », « 45000 », « 45000,00 » -> 45000 ; null sinon
function lirePieces(brut) {
  const t = String(brut ?? '').replace(/[\s\u00a0\u202f]/g, '');
  if (!t) return null;
  let n;
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) n = Number(t.replace(/[.,]/g, ''));
  else n = Number(t.replace(',', '.'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Sans tabulation, la référence peut contenir des espaces et des chiffres (« STAFFA 048290111 1 200 ») :
// on prend la plus longue référence du catalogue Articles au début de la ligne, suivie d'une quantité.
function decouperAvecCatalogue(texte, connue) {
  const espaces = [...texte.matchAll(/\s+/g)].map((m) => m.index).reverse();
  for (const i of espaces) {
    const reference = texte.slice(0, i).trim();
    const quantite = texte.slice(i).trim();
    if (connue(reference) && lirePieces(quantite) !== null) return [reference, quantite];
  }
  return null;
}

// Une ligne collée depuis Excel (« F0740<tab>125000 ») ou depuis le PDF (« F0740 125 000 »).
// connues (facultatif) : Set des références du catalogue Articles (normalisées), pour couper la ligne au bon endroit.
// Renvoie { reference, pieces }, { erreur } ou null (ligne vide, titre, en-tête, total).
function lireLigne(brut, connues = null) {
  const texte = String(brut ?? '').replace(/[\u00a0\u202f]/g, ' ').trim();
  if (!texte) return null;
  const connue = (r) => !!connues?.has(normaliserReference(r));
  let reference;
  let quantite;
  const colonnes = texte.split(/\t|;/).map((c) => c.trim()).filter(Boolean);
  const decoupe = colonnes.length < 2 && connues ? decouperAvecCatalogue(texte, connue) : null;
  if (colonnes.length >= 2) {
    reference = colonnes[0];
    quantite = colonnes[colonnes.length - 1];
  } else if (decoupe) {
    [reference, quantite] = decoupe;
  } else if (connue(texte)) {
    // la référence seule, sans quantité
    return { texte, reference: normaliserReference(texte), erreur: 'quantité manquante : ajoutez le nombre de pièces après la référence' };
  } else {
    // sans tabulation : la quantité est le nombre à la fin, avec ses espaces de milliers (« AK 15317766 45 000 »)
    const m = /^(.*?)\s+(\d{1,3}(?:[ .,]\d{3})+|\d+(?:,\d+)?)$/.exec(texte);
    if (!m) return null;
    [, reference, quantite] = m;
  }
  if (TOTAL.test(reference)) return null;
  const pieces = lirePieces(quantite);
  // en-tête (« Codice  Somma Di quantita ») : pas de nombre en dernière colonne
  if (pieces === null && !/\d/.test(quantite)) return null;
  const ref = normaliserReference(reference);
  if (!REFERENCE.test(ref) && !connue(ref)) return { texte, erreur: `référence « ${reference} » illisible` };
  if (pieces === null) return { texte, reference: ref, erreur: `quantité « ${quantite} » illisible (nombre entier de pièces)` };
  return { texte, reference: ref, pieces };
}

// Texte collé -> { lignes: [{ reference, pieces }], erreurs: ['Ligne 3 : …'] }. Une référence ne peut pas apparaître deux fois.
// connues (facultatif) : Set des références du catalogue Articles, normalisées.
function lireTexte(texte, connues = null) {
  const lignes = [];
  const erreurs = [];
  const erreursLignes = []; // { ligne, texte, message } : pour l'aperçu, ligne par ligne
  const vues = new Map();
  String(texte ?? '').split(/\r?\n/).forEach((brut, k) => {
    const l = lireLigne(brut, connues);
    if (!l) return;
    const message = l.erreur ?? (vues.has(l.reference) ? `${l.reference} est déjà à la ligne ${vues.get(l.reference)}` : null);
    if (message) {
      erreurs.push(`Ligne ${k + 1} : ${message}`);
      erreursLignes.push({ ligne: k + 1, texte: l.texte, reference: l.reference ?? null, message });
      return;
    }
    vues.set(l.reference, k + 1);
    lignes.push({ reference: l.reference, pieces: l.pieces, ligne: k + 1 });
  });
  return { lignes, erreurs, erreursLignes };
}

// Écart toléré d'une référence (pièces) : pourcentage du total annoncé, arrondi à l'inférieur
const tolerance = (attendues, pct) => Math.floor((attendues * pct) / 100);

// Bilan d'une référence : conforme, toléré (petit écart), manquant, en trop, ou non reçue
function bilanReference(attendues, recues, pct) {
  const ecart = recues - attendues;
  const tol = tolerance(attendues, pct);
  let statut;
  if (recues === 0) statut = 'non_recue';
  else if (ecart === 0) statut = 'conforme';
  else if (Math.abs(ecart) <= tol) statut = 'tolere';
  else statut = ecart < 0 ? 'manquant' : 'en_trop';
  return { ecart, tolerance: tol, statut };
}

// « 45 000 »
const nombre = (n) => Number(n).toLocaleString('fr-FR').replace(/[\u00a0\u202f]/g, ' ');

module.exports = { lireTexte, lireLigne, lirePieces, bilanReference, tolerance, nombre, REFERENCE };
