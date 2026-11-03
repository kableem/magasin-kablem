// Historique des changements d'emplacement (qui, quand, quel produit, d'où, vers où, pourquoi)

const MOTIFS_DEPLACEMENT = {
  palette_abimee: 'Palette abîmée',
  regroupement: 'Regroupement / gain de place',
  rapprocher_porte: 'Rapprocher de la porte',
  erreur_rangement: "Correction d'une erreur de rangement",
  emplacement_bloque: 'Emplacement bloqué ou en réparation',
  autre: 'Autre',
};

// Motif obligatoire (et commentaire facultatif) d'un changement d'emplacement fait à la main.
// Renvoie { motif, commentaire } ou { erreur }.
function lireMotif(corps) {
  const motif = corps?.motif;
  const commentaire = String(corps?.commentaire ?? '').trim() || null;
  if (!MOTIFS_DEPLACEMENT[motif]) {
    return { erreur: "Indiquez le motif du changement d'emplacement" };
  }
  if (motif === 'autre' && !commentaire) {
    return { erreur: 'Motif « Autre » : précisez la raison dans le commentaire' };
  }
  if (commentaire && commentaire.length > 255) {
    return { erreur: 'Le commentaire ne doit pas dépasser 255 caractères' };
  }
  return { motif, commentaire };
}

// Enregistre plusieurs mouvements d'une même opération (dans la transaction en cours).
// Produits identiques (même référence, lot, type, taille) allant du même emplacement au même emplacement :
// une seule ligne d'historique, quantités additionnées (ex. 2 cartons identiques déplacés ensemble = 1 ligne « 2 »).
async function enregistrerMouvements(connexion, mouvements) {
  const groupes = new Map();
  for (const m of mouvements) {
    const l = m.ligne;
    const cle = [m.origine, l.reference, l.lot, l.type, l.taille_bobine ?? '', m.depuis ?? '', m.vers ?? '', m.motif ?? '', m.commentaire ?? '', m.colis ?? '', m.depuisLiberee ? 1 : 0].join('|');
    const g = groupes.get(cle);
    if (g) g.quantite += Number(m.quantite);
    else groupes.set(cle, { ...m, quantite: Number(m.quantite) });
  }
  for (const m of groupes.values()) await enregistrerMouvement(connexion, m);
}

// Enregistre un mouvement (dans la transaction en cours).
// colis : n° de colis du ticket ; depuisLiberee : l'emplacement de départ est vide après ce mouvement.
async function enregistrerMouvement(connexion, { origine, ligne, quantite, depuis, vers, motif = null, commentaire = null, utilisateurId, colis = null, depuisLiberee = false }) {
  await connexion.query(
    `INSERT INTO mouvements_emplacement
       (origine, reception_id, reference, lot, type, taille_bobine, quantite, colis, depuis, vers, depuis_liberee, motif, commentaire, utilisateur_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      origine, ligne.reception_id ?? ligne.id, ligne.reference, ligne.lot, ligne.type, ligne.taille_bobine ?? null,
      quantite, colis, depuis ?? null, vers ?? null, depuisLiberee ? 1 : 0, motif, commentaire, utilisateurId ?? null,
    ]
  );
}

module.exports = { MOTIFS_DEPLACEMENT, lireMotif, enregistrerMouvement, enregistrerMouvements };
