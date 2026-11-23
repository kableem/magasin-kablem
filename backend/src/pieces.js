// Pièces des colis en stock : pour la visibilité seulement (le stock, le FIFO et les sorties se comptent en colis).
// Les pièces d'un colis viennent de son ticket scanné à la réception. Un produit entré sans ticket lu (inventaire, ancien import) n'a pas de pièces connues.

// Pour chaque ligne d'import : colis reçus, pièces, et si tous ses colis ont la même quantité
async function piecesParLigne(connexion, receptionIds) {
  const ids = [...new Set(receptionIds.filter(Boolean))];
  const infos = new Map();
  if (!ids.length) return infos;
  const [lignes] = await connexion.query(
    `SELECT c.reception_id, COUNT(*) AS colis,
            SUM(c.pieces) AS pieces, MIN(c.pieces) AS mini, MAX(c.pieces) AS maxi, SUM(c.pieces IS NULL) AS sans
     FROM controles_mobile c
     JOIN receptions r ON r.id = c.reception_id
     WHERE c.reception_id IN (?) AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite') AND c.ticket IS NOT NULL
     GROUP BY c.reception_id`,
    [ids]
  );
  for (const l of lignes) {
    if (Number(l.sans) > 0) continue; // un colis sans quantité lue : pièces inconnues
    infos.set(l.reception_id, { colis: Number(l.colis), pieces: Number(l.pieces), mini: Number(l.mini), maxi: Number(l.maxi) });
  }
  return infos;
}

// Pièces de `quantite` colis d'une ligne : exactes si tous ses colis ont la même quantité, ou s'il s'agit de
// tous ses colis ; sinon estimées (moyenne par colis). null si inconnues.
function piecesDe(info, quantite) {
  if (!info || !info.colis) return null;
  if (info.mini === info.maxi) return { pieces: quantite * info.mini, approx: false };
  if (quantite === info.colis) return { pieces: info.pieces, approx: false };
  return { pieces: Math.round((quantite * info.pieces) / info.colis), approx: true };
}

// Additionne des pièces : inconnues (null) dès qu'une part est inconnue ; « environ » dès qu'une part est estimée
function cumulerPieces(cible, p) {
  const premier = !('pieces' in cible);
  cible.pieces = premier ? (p?.pieces ?? null) : cible.pieces === null || !p ? null : cible.pieces + p.pieces;
  cible.pieces_approx = (premier ? false : cible.pieces_approx) || !!p?.approx;
}

// Ajoute pieces / pieces_approx à des lignes de stock ({ reception_id, quantite })
async function avecPieces(connexion, lignes) {
  const infos = await piecesParLigne(connexion, lignes.map((l) => l.reception_id));
  return lignes.map((l) => {
    const p = piecesDe(infos.get(l.reception_id), l.quantite);
    return { ...l, pieces: p?.pieces ?? null, pieces_approx: p?.approx ?? false };
  });
}

module.exports = { piecesParLigne, piecesDe, avecPieces, cumulerPieces };
