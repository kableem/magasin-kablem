// Réception séparée : ce qui arrive en plus entre au stock, avec sa réclamation (décision du 2026-11-06).
//   - colis en trop d'une ligne d'import : la ligne compte ces colis en plus ;
//   - produit absent de l'import (hors import) : une ligne d'import est créée pour lui, si sa référence est au
//     catalogue Articles (sinon son type est inconnu : il attend l'ajout au catalogue, puis « Entrer au stock »).
// Les réclamations sont créées avant (fin de réception) ; elles ne sont pas déduites du stock.
const { typesDuCatalogue } = require('./articles');

// Colis en trop des lignes de l'import (avancement RI.avancement)
async function integrerEnTrop(connexion, av) {
  let n = 0;
  for (const l of av.lignes.values()) {
    if (!l.en_trop) continue;
    await connexion.query('UPDATE receptions SET quantite = quantite + ? WHERE id = ?', [l.en_trop, l.id]);
    n += l.en_trop;
  }
  return n;
}

// Produits hors import pas encore au stock : une ligne par référence et lot, si la référence est au catalogue.
// Renvoie { integres: [{ id, reference, lot, quantite, type }], en_attente: [références absentes du catalogue] }.
async function integrerHorsImport(connexion, importId, utilisateurId) {
  const [scans] = await connexion.query(
    `SELECT id, reference, lot FROM controles_mobile
     WHERE import_id = ? AND controle = 'reception' AND resultat = 'inconnu' AND reference IS NOT NULL AND reception_id IS NULL
     ORDER BY id FOR UPDATE`,
    [importId]
  );
  const catalogue = await typesDuCatalogue(connexion, scans.map((s) => s.reference));
  const groupes = new Map();
  const enAttente = new Set();
  for (const s of scans) {
    const t = catalogue.get(s.reference.toUpperCase());
    // connecteur : il faut les dimensions de son carton, absentes du ticket
    if (!t || t.type === 'connecteur') {
      enAttente.add(s.reference);
      continue;
    }
    const cle = `${s.reference}|${s.lot}`;
    groupes.set(cle, { reference: s.reference, lot: s.lot, ...t, ids: [...(groupes.get(cle)?.ids ?? []), s.id] });
  }
  const integres = [];
  for (const g of groupes.values()) {
    const [r] = await connexion.query(
      `INSERT INTO receptions (import_id, type, taille_bobine, type_cosse, reference, lot, date_reception, quantite, commentaire, utilisateur_id)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, 'Hors import : reçu en plus de l''import (réclamation)', ?)`,
      [importId, g.type, g.type === 'bobine' ? g.taille_bobine : null, g.type === 'cosse' ? (g.type_cosse ?? 'plat') : null, g.reference, g.lot, g.ids.length, utilisateurId]
    );
    // les scans comptent maintenant comme reçus (en écart) sur cette ligne
    await connexion.query("UPDATE controles_mobile SET reception_id = ?, resultat = 'ecart_quantite' WHERE id IN (?)", [r.insertId, g.ids]);
    integres.push({ id: r.insertId, reference: g.reference, lot: g.lot, quantite: g.ids.length, type: g.type });
  }
  return { integres, en_attente: [...enAttente] };
}

module.exports = { integrerEnTrop, integrerHorsImport };
