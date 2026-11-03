// Produits réservés par les sorties en préparation sur le mobile : une autre sortie
// (mobile ou secours web) ne peut pas les prendre.

// Une préparation abandonnée ne bloque pas le stock indéfiniment
const DUREE_MAX_MINUTES = 120;

async function expirerPreparations(connexion) {
  await connexion.query(
    `UPDATE preparations_export SET statut = 'annulee', date_fin = NOW(), motif_fin = 'Expirée (plus de ${DUREE_MAX_MINUTES} min)'
     WHERE statut = 'en_cours' AND date_creation < NOW() - INTERVAL ${DUREE_MAX_MINUTES} MINUTE`
  );
}

// Lignes de stock (lignesEnStock) moins ce que les sorties en préparation ont réservé
async function retirerReserves(connexion, lignes) {
  const [reserve] = await connexion.query(
    `SELECT l.placement_id, SUM(l.quantite) AS quantite
     FROM preparation_lignes l JOIN preparations_export p ON p.id = l.preparation_id AND p.statut = 'en_cours'
     GROUP BY l.placement_id`
  );
  const parPlacement = new Map(reserve.map((r) => [r.placement_id, Number(r.quantite)]));
  return lignes
    .map((l) => ({ ...l, quantite: l.quantite - (parPlacement.get(l.id) ?? 0) }))
    .filter((l) => l.quantite > 0);
}

module.exports = { DUREE_MAX_MINUTES, expirerPreparations, retirerReserves };
