// Palettes de cosses (migration 038, décision du 2026-11-10).
// Une palette porte plusieurs cartons (références mélangées possibles) et aussi des cosses séparées,
// sans limite de nombre. Un carton est toujours sur une palette : en mode Cartons, la palette s'ouvre seule
// si le magasinier n'en a pas d'ouverte. Pas d'étiquette palette : au rangement, l'étiquette de n'importe quel
// carton (ou le ticket d'une cosse) de la palette suffit, puis l'emplacement : toute la palette entre au stock,
// seule sur un emplacement vide. Rien ne s'y ajoute ensuite ; les cosses sortent une par une à l'export.
// Palettes de connecteurs (migration 041) : mêmes palettes, famille 'connecteur' (un carton = un ticket vert,
// jamais mélangées avec des cosses). Pendant une réception, une palette de connecteurs du magasin peut être
// « descendue » (descendue_par) pour être complétée avec les cartons de l'import, puis remise à sa place ; ces
// cartons entrent au stock à sa place à la fin de la réception (entrerComplements).
const C = require('./cartons');
const { nomEmplacement } = require('./plan');

const SELECT_PALETTE = 'SELECT p.id, p.import_id, p.numero, p.famille, p.statut, p.emplacement, p.ouverte_par, p.descendue_par, p.descendue_import FROM palettes_cosses p';

// Cosses reçues sur la palette (dans un carton ou séparées), dans l'ordre des scans
async function cossesDeLaPalette(connexion, paletteId) {
  const [cosses] = await connexion.query(
    `SELECT c.id AS controle_id, c.reception_id, c.ticket, c.reference, c.lot, c.pieces, c.carton_id, ca.numero AS carton_numero
     FROM controles_mobile c LEFT JOIN cartons ca ON ca.id = c.carton_id
     WHERE c.palette_cosses_id = ? AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite', 'inconnu')
     ORDER BY c.id`,
    [paletteId]
  );
  return cosses.map((x) => ({ ...x, colis: x.ticket ? Number(String(x.ticket).split('|').pop()) : null, pieces: x.pieces === null ? null : Number(x.pieces) }));
}

// Tickets déjà sortis du stock (export) parmi ceux-ci
async function ticketsSortis(connexion, tickets) {
  const liste = tickets.filter(Boolean);
  if (!liste.length) return new Set();
  const [sortis] = await connexion.query(
    "SELECT DISTINCT ticket FROM controles_mobile WHERE controle = 'export' AND resultat IN ('prelevement_ok', 'sortie_terminee') AND ticket IN (?)",
    [liste]
  );
  return new Set(sortis.map((s) => s.ticket));
}

// Cosses descendues d'un carton ouvert à l'export (posées en cosses séparées) parmi ces tickets
async function ticketsDescendus(connexion, tickets) {
  const liste = tickets.filter(Boolean);
  if (!liste.length) return new Set();
  const [d] = await connexion.query('SELECT ticket FROM descentes_carton_cosses WHERE pose_le IS NOT NULL AND ticket IN (?)', [liste]);
  return new Set(d.map((x) => x.ticket));
}

const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;

// « 3 cartons + 2 cosses séparées · 26 cosses » ; connecteurs : « 4 cartons de connecteurs »
function contenuPalette(v) {
  if (v.famille === 'connecteur') return v.nb_cartons ? `${pluriel(v.nb_cartons, 'carton')} de connecteurs` : 'vide';
  const parts = [];
  if (v.nb_cartons) parts.push(pluriel(v.nb_cartons, 'carton'));
  if (v.nb_separees) parts.push(`${pluriel(v.nb_separees, 'cosse')} séparée${v.nb_separees > 1 ? 's' : ''}`);
  if (!parts.length) return 'vide';
  return v.nb_cartons ? `${parts.join(' + ')} · ${pluriel(v.cosses, 'cosse')}` : parts[0];
}

// « Palette n° 2 (3 cartons + 2 cosses séparées · 26 cosses) »
const nomPalette = (v) => `Palette n° ${v.numero} (${contenuPalette(v)})`;

// Vue d'une palette pour le web et le mobile
async function vuePalette(connexion, p) {
  const cosses = await cossesDeLaPalette(connexion, p.id);
  const [cartons] = await connexion.query(`${C.SELECT_CARTON} WHERE c.palette_id = ? ORDER BY c.numero`, [p.id]);
  const vuesCartons = [];
  for (const c of cartons) vuesCartons.push(await C.vueCarton(connexion, c));
  const separees = cosses.filter((x) => !x.carton_id);
  const rangee = p.statut === 'rangee';
  const sortis = rangee ? await ticketsSortis(connexion, cosses.map((x) => x.ticket)) : new Set();
  const descendus = rangee ? await ticketsDescendus(connexion, cosses.map((x) => x.ticket)) : new Set();
  if (p.famille === 'connecteur') return vueConnecteurs(connexion, p, cosses);
  const v = {
    id: p.id,
    import_id: p.import_id,
    numero: p.numero,
    famille: p.famille ?? 'cosse',
    statut: p.statut,
    emplacement: rangee ? p.emplacement : null,
    cartons: vuesCartons,
    nb_cartons: vuesCartons.filter((c) => c.cosses > 0).length,
    separees: separees.map((x) => ({ controle_id: x.controle_id, colis: x.colis, reference: x.reference, lot: x.lot, pieces: x.pieces })),
    nb_separees: separees.length,
    cosses: cosses.length,
    pieces: cosses.every((x) => x.pieces !== null) ? cosses.reduce((t, x) => t + x.pieces, 0) : null,
    references: [...new Set(cosses.map((x) => x.reference))],
    hors_stock: cosses.filter((x) => !x.reception_id).length, // référence absente du catalogue : pas encore au stock
    en_stock: rangee ? cosses.filter((x) => x.reception_id && !sortis.has(x.ticket) && !descendus.has(x.ticket)).length : 0, // après les sorties et les descentes
    etiquettes_a_imprimer: vuesCartons.filter((c) => c.statut !== 'ouvert' && c.cosses > 0 && !c.imprime).length,
  };
  return { ...v, contenu: contenuPalette(v) };
}

// Palette de connecteurs : rangée, son stock vient des emplacements (le stock d'avant la migration 041 n'a pas de
// scans de réception) ; à la réception, ses cartons scannés. a_ajouter : cartons de l'import qui la complète.
async function vueConnecteurs(connexion, p, cosses) {
  const rangee = p.statut === 'rangee';
  const [stock] = rangee
    ? await connexion.query(
        'SELECT r.reference, SUM(pl.quantite) AS n FROM placements pl JOIN receptions r ON r.id = pl.reception_id WHERE pl.palette_cosses_id = ? AND pl.quantite > 0 GROUP BY r.reference ORDER BY r.reference',
        [p.id]
      )
    : [[]];
  const enStock = stock.reduce((t, l) => t + Number(l.n), 0);
  const [[{ a_ajouter }]] = p.descendue_import
    ? await connexion.query(
        "SELECT COUNT(*) AS a_ajouter FROM controles_mobile WHERE palette_cosses_id = ? AND import_id = ? AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite', 'inconnu')",
        [p.id, p.descendue_import]
      )
    : [[{ a_ajouter: 0 }]];
  const nb = rangee ? enStock : cosses.length;
  const v = {
    id: p.id, import_id: p.import_id, numero: p.numero, famille: 'connecteur', statut: p.statut,
    emplacement: rangee ? p.emplacement : null, numero_emplacement: rangee && p.emplacement ? nomEmplacement(p.emplacement) : null,
    cartons: [], nb_cartons: nb, separees: [], nb_separees: 0, cosses: nb, pieces: null,
    references: rangee ? stock.map((l) => l.reference) : [...new Set(cosses.map((x) => x.reference))],
    hors_stock: cosses.filter((x) => !x.reception_id && !rangee).length, en_stock: enStock, etiquettes_a_imprimer: 0,
    descendue: !!p.descendue_par, descendue_par: p.descendue_par ?? null, a_ajouter: Number(a_ajouter),
    liste: rangee ? [] : cosses.map((x) => ({ controle_id: x.controle_id, colis: x.colis, reference: x.reference, lot: x.lot })),
  };
  return { ...v, contenu: contenuPalette(v) };
}

// Ouvre la palette suivante de l'import pour ce magasinier (famille : 'cosse', 'connecteur' ou null si encore vide)
async function ouvrirPalette(connexion, importId, utilisateurId, famille = null) {
  const [[{ suivant }]] = await connexion.query('SELECT COALESCE(MAX(numero), 0) + 1 AS suivant FROM palettes_cosses WHERE import_id = ? FOR UPDATE', [importId]);
  const [r] = await connexion.query('INSERT INTO palettes_cosses (import_id, numero, famille, ouverte_par) VALUES (?, ?, ?, ?)', [importId, suivant, famille, utilisateurId]);
  const [[p]] = await connexion.query(`${SELECT_PALETTE} WHERE p.id = ?`, [r.insertId]);
  return { ...p, nouvelle: true };
}

// Palette ouverte du magasinier dans cet import ; creer = true : ouverte si besoin. null sinon.
async function paletteOuverte(connexion, importId, utilisateurId, creer = false, famille = null) {
  const [[p]] = await connexion.query(
    `${SELECT_PALETTE} WHERE p.import_id = ? AND p.statut = 'ouverte' AND p.ouverte_par = ? ORDER BY p.numero DESC LIMIT 1 FOR UPDATE`,
    [importId, utilisateurId]
  );
  if (p) return p;
  return creer ? ouvrirPalette(connexion, importId, utilisateurId, famille) : null;
}

// Termine une palette : son carton ouvert est terminé (annulé s'il est vide) ; une palette vide est annulée.
// Renvoie { supprimee: true } ou { vue }.
async function terminerPalette(connexion, p) {
  const [ouverts] = await connexion.query("SELECT id FROM cartons WHERE palette_id = ? AND statut = 'ouvert' FOR UPDATE", [p.id]);
  for (const c of ouverts) {
    const [[{ n }]] = await connexion.query(
      "SELECT COUNT(*) AS n FROM controles_mobile WHERE carton_id = ? AND controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite', 'inconnu')",
      [c.id]
    );
    if (Number(n)) await connexion.query("UPDATE cartons SET statut = 'termine', date_termine = NOW() WHERE id = ?", [c.id]);
    else await connexion.query('DELETE FROM cartons WHERE id = ?', [c.id]);
  }
  if (!(await cossesDeLaPalette(connexion, p.id)).length) {
    await connexion.query('DELETE FROM cartons WHERE palette_id = ?', [p.id]); // cartons vides
    await connexion.query('DELETE FROM palettes_cosses WHERE id = ?', [p.id]);
    return { supprimee: true };
  }
  await connexion.query("UPDATE palettes_cosses SET statut = 'terminee', date_terminee = NOW() WHERE id = ?", [p.id]);
  return { vue: await vuePalette(connexion, { ...p, statut: 'terminee' }) };
}

// Palette ouverte (ou descendue) : fixe sa famille au 1er carton ; refuse le mélange cosses / connecteurs
async function verifierFamille(connexion, p, famille) {
  if (p.famille && p.famille !== famille) {
    const autre = p.famille === 'cosse' ? 'des cartons de cosses' : 'des cartons de connecteurs';
    const ici = famille === 'cosse' ? 'cette cosse' : 'ce carton de connecteurs';
    throw Object.assign(new Error(`La palette n° ${p.numero} porte ${autre} : une palette ne mélange jamais cosses et connecteurs. Touchez « Terminer la palette », puis scannez ${ici}.`), { status: 409 });
  }
  if (!p.famille) await connexion.query('UPDATE palettes_cosses SET famille = ? WHERE id = ?', [famille, p.id]);
  return { ...p, famille };
}

// Palette de connecteurs descendue par ce magasinier (une seule à la fois), ou null
async function paletteDescendue(connexion, utilisateurId, verrou = false) {
  const [[p]] = await connexion.query(`${SELECT_PALETTE} WHERE p.descendue_par = ? LIMIT 1 ${verrou ? 'FOR UPDATE' : ''}`, [utilisateurId]);
  return p ?? null;
}

// Fin de la réception (ajout au stock) : les cartons ajoutés aux palettes descendues entrent au stock à la place de
// leur palette, déjà rangés. Renvoie le nombre de cartons entrés.
async function entrerComplements(connexion, importId, utilisateurId) {
  const [cartons] = await connexion.query(
    `SELECT c.ticket, c.reception_id, c.reference, c.lot, c.palette_cosses_id, pc.emplacement, pc.numero
     FROM controles_mobile c JOIN palettes_cosses pc ON pc.id = c.palette_cosses_id
     WHERE c.import_id = ? AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite') AND c.reception_id IS NOT NULL
       AND pc.statut = 'rangee' AND pc.emplacement IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM controles_mobile x WHERE x.ticket = c.ticket AND x.controle = 'rangement' AND x.resultat = 'bon_emplacement')
     ORDER BY c.id`,
    [importId]
  );
  const parLigne = new Map();
  for (const x of cartons) {
    const cle = `${x.reception_id}|${x.palette_cosses_id}`;
    parLigne.set(cle, [...(parLigne.get(cle) ?? []), x]);
  }
  for (const liste of parLigne.values()) {
    const x = liste[0];
    await connexion.query(
      `INSERT INTO placements (reception_id, emplacement, quantite, palette_cosses_id) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE quantite = quantite + VALUES(quantite), palette_cosses_id = VALUES(palette_cosses_id)`,
      [x.reception_id, x.emplacement, liste.length, x.palette_cosses_id]
    );
  }
  for (const x of cartons) {
    await connexion.query(
      `INSERT INTO controles_mobile (uuid, controle, resultat, reference, lot, ticket, reception_id, import_id, palette_cosses_id, emplacement_scanne, message, reponse, utilisateur_id)
       VALUES (UUID(), 'rangement', 'bon_emplacement', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
      [x.reference, x.lot, x.ticket, x.reception_id, importId, x.palette_cosses_id, x.emplacement, `Ajouté à la palette n° ${x.numero} (palette complétée)`, utilisateurId]
    );
  }
  return cartons.length;
}

module.exports = { verifierFamille, paletteDescendue, entrerComplements, SELECT_PALETTE, cossesDeLaPalette, ticketsSortis, ticketsDescendus, vuePalette, contenuPalette, nomPalette, ouvrirPalette, paletteOuverte, terminerPalette };
