// Cartons de cosses ouverts à l'export (migration 040, décision du 2026-11-12).
// En haut (niveaux 3-4, et 4-5 du bloc E), il n'y a que des cartons NEUFS. Dès qu'une cosse sort d'un carton,
// les cosses qui restent deviennent des cosses séparées : le magasinier doit tout de suite les descendre sur la
// place de cosses séparées imposée — même référence et même lot, la plus proche de la porte, sinon la place
// vide la plus proche de la porte (moteur de rangement) — en scannant l'emplacement puis le ticket de chaque cosse.
// Sa sortie suivante attend que ce soit fait.
const R = require('./rangement');
const { occupation } = require('./routes/stock');
const { capaciteTampon } = require('./parametres');

// Cosses encore dans le carton : reçues dedans, au stock, ni sorties ni déjà descendues
async function cossesRestantes(connexion, cartonId) {
  const [cosses] = await connexion.query(
    `SELECT c.ticket, c.reception_id, r.reference, r.lot, r.type, r.type_cosse
     FROM controles_mobile c JOIN receptions r ON r.id = c.reception_id
     WHERE c.carton_id = ? AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite', 'inconnu') AND c.ticket IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM controles_mobile x WHERE x.ticket = c.ticket AND x.controle = 'export' AND x.resultat IN ('prelevement_ok', 'sortie_terminee'))
       AND NOT EXISTS (SELECT 1 FROM descentes_carton_cosses d WHERE d.ticket = c.ticket)
     ORDER BY c.id`,
    [cartonId]
  );
  return cosses.map((x) => ({ ...x, colis: Number(String(x.ticket).split('|').pop()) }));
}

// Places déjà promises à des cosses qui attendent d'être descendues (comptées comme occupées)
async function placesPromises(connexion) {
  const [lignes] = await connexion.query(
    `SELECT -(2000000 + d.id) AS id, d.reception_id, d.reference, d.lot, r.type, r.taille_bobine, r.type_cosse, 1 AS quantite, d.emplacement
     FROM descentes_carton_cosses d JOIN receptions r ON r.id = d.reception_id
     WHERE d.pose_le IS NULL AND d.emplacement IS NOT NULL`
  );
  return lignes.map((l) => ({ ...l, quantite: 1, reserve: true }));
}

// Cosses sorties par cette sortie qui étaient dans un carton rangé (neuf) : chaque carton ouvert devient une descente.
// tickets = tickets des cosses prises. Renvoie les identifiants des descentes créées.
async function creerDescentes(connexion, { tickets, preparationId = null, exportId = null, utilisateurId }) {
  const liste = [...new Set(tickets.filter(Boolean))];
  if (!liste.length) return [];
  const [cartons] = await connexion.query(
    `SELECT DISTINCT ca.id, ca.numero, ca.palette_id, ca.emplacement
     FROM controles_mobile c JOIN cartons ca ON ca.id = c.carton_id
     WHERE c.ticket IN (?) AND c.controle = 'reception' AND ca.statut = 'range'
       AND NOT EXISTS (SELECT 1 FROM descentes_carton d WHERE d.carton_id = ca.id)
     FOR UPDATE`,
    [liste]
  );
  const crees = [];
  for (const k of cartons) {
    // (le dernier ticket de la sortie n'est pas encore enregistré comme sorti : on l'exclut ici)
    const restantes = (await cossesRestantes(connexion, k.id)).filter((x) => !liste.includes(x.ticket));
    if (!restantes.length) continue; // carton entièrement sorti : rien à descendre
    // Places imposées : le moteur de rangement, comme des cosses séparées (même référence et même lot d'abord)
    const parLigne = new Map();
    for (const x of restantes) {
      const g = parLigne.get(x.reception_id) ?? { id: x.reception_id, type: 'cosse', taille_bobine: null, type_cosse: x.type_cosse, reference: x.reference, lot: x.lot, quantite: 0 };
      g.quantite++;
      parLigne.set(x.reception_id, g);
    }
    const enPlace = [...(await occupation(connexion, true)), ...(await placesPromises(connexion))].filter((l) => l.emplacement);
    const plan = R.proposerPlan([...parLigne.values()], enPlace, { capaciteTampon: await capaciteTampon(connexion) });
    const places = new Map(); // reception_id → [emplacement, emplacement…] (une case par cosse)
    for (const p of plan) for (let n = 0; n < p.quantite; n++) places.set(p.id, [...(places.get(p.id) ?? []), p.emplacement]);
    const [d] = await connexion.query(
      'INSERT INTO descentes_carton (carton_id, palette_cosses_id, depuis, preparation_id, export_id, utilisateur_id) VALUES (?, ?, ?, ?, ?, ?)',
      [k.id, k.palette_id, k.emplacement, preparationId, exportId, utilisateurId]
    );
    for (const x of restantes) {
      const emplacement = (places.get(x.reception_id) ?? []).shift() ?? null;
      await connexion.query(
        'INSERT INTO descentes_carton_cosses (descente_id, ticket, colis, reception_id, reference, lot, emplacement) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [d.insertId, x.ticket, x.colis, x.reception_id, x.reference, x.lot, emplacement]
      );
    }
    crees.push(d.insertId);
  }
  return crees;
}

// Descente pour le téléphone : le carton, ses cosses à poser et leur emplacement imposé
async function vueDescente(connexion, id) {
  const [[d]] = await connexion.query(
    `SELECT d.id, d.statut, d.depuis, d.carton_id, ca.numero AS carton, ca.reference, ca.lot, pc.numero AS palette
     FROM descentes_carton d JOIN cartons ca ON ca.id = d.carton_id LEFT JOIN palettes_cosses pc ON pc.id = d.palette_cosses_id
     WHERE d.id = ?`,
    [id]
  );
  if (!d) return null;
  const [cosses] = await connexion.query(
    'SELECT ticket, colis, reference, lot, emplacement, pose_le IS NOT NULL AS posee FROM descentes_carton_cosses WHERE descente_id = ? ORDER BY colis, id',
    [id]
  );
  const liste = cosses.map((x) => ({ ...x, posee: !!x.posee }));
  return {
    ...d,
    cosses: liste,
    restantes: liste.filter((x) => !x.posee).length,
    emplacements: [...new Set(liste.filter((x) => !x.posee).map((x) => x.emplacement))],
  };
}

// Descente en cours de ce magasinier (la plus ancienne), ou null
async function descenteEnCours(connexion, utilisateurId) {
  const [[d]] = await connexion.query(
    "SELECT id FROM descentes_carton WHERE statut = 'en_cours' AND utilisateur_id = ? ORDER BY id LIMIT 1",
    [utilisateurId]
  );
  return d ? vueDescente(connexion, d.id) : null;
}

// « 4 cosses du carton n° 3 (F0740 lot 202614653-2) à descendre en 0342 »
const texteDescente = (v) =>
  `Carton n° ${v.carton} ouvert : descendez ${v.restantes > 1 ? `les ${v.restantes} cosses restantes` : 'la cosse restante'} (${v.reference} lot ${v.lot}) en ${v.emplacements.join(', ')} — scannez l'emplacement, puis le ticket de chaque cosse.`;

module.exports = { cossesRestantes, creerDescentes, vueDescente, descenteEnCours, texteDescente };
