// Cosses plates reçues en cartons (migration 037).
// Un carton : des cosses d'une seule référence et d'un seul lot, chacune avec son ticket vert.
// Son étiquette (imprimée depuis le web) porte un QR « référence;lot;pièces;JJ/MM/AAAA HH:MM:SS.mmm » :
// la date système de la 1re impression, à la milliseconde, rend chaque étiquette unique.
// Un carton est toujours sur une palette de cosses (palettes-cosses.js) : c'est la palette entière qui se range
// sur un emplacement vide et qui se déplace ; rien ne s'y ajoute. Les cosses sortent une par une à l'export.
const R = require('./rangement');

const deux = (n) => String(n).padStart(2, '0');
const trois = (n) => String(n).padStart(3, '0');

// Date → « 2026-11-06 10:42:31.517 » (base) et « 06/11/2026 10:42:31.517 » (étiquette), heure locale
const dateBase = (d) => `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())} ${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())}.${trois(d.getMilliseconds())}`;
const dateEtiquette = (base) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?/.exec(String(base));
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}.${(m[5] ?? '0').padEnd(3, '0')}` : '';
};

// Carton lu en base, sa date d'étiquette en texte (avec les millisecondes)
const SELECT_CARTON = `SELECT c.id, c.import_id, c.palette_id, pc.numero AS palette_numero, c.numero, c.reference, c.lot, c.statut, c.emplacement, c.ouvert_par,
       DATE_FORMAT(c.date_etiquette, '%Y-%m-%d %H:%i:%s.%f') AS date_etiquette
  FROM cartons c LEFT JOIN palettes_cosses pc ON pc.id = c.palette_id`;

// Lot complet d'un ticket : « 202614653-2 »
const lotComplet = (ticket) => `${ticket.lot}${ticket.suffixe ? '-' + ticket.suffixe : ''}`;

// QR de l'étiquette d'un carton
const qrCarton = (c) => `${c.reference};${c.lot};${c.pieces};${dateEtiquette(c.date_etiquette)}`;

// Lit le QR d'une étiquette de carton ; null si ce n'est pas une étiquette de carton
function lireEtiquetteCarton(texte) {
  const m = /^\s*([^;]+);([^;]+);(\d+);(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})\.(\d{3})\s*$/.exec(String(texte ?? ''));
  if (!m) return null;
  const [, reference, lot, pieces, j, mo, a, heure, ms] = m;
  return {
    reference: reference.trim().toUpperCase().replace(/\s+/g, ' '),
    lot: lot.trim(),
    pieces: Number(pieces),
    date: `${a}-${mo}-${j} ${heure}.${ms}`,
  };
}

// Cosses d'un carton (scans de réception), avec leur ligne d'import et leurs pièces
async function cossesDuCarton(connexion, cartonId) {
  const [cosses] = await connexion.query(
    `SELECT c.id AS controle_id, c.reception_id, c.ticket, c.reference, c.lot, c.pieces, c.resultat
     FROM controles_mobile c
     WHERE c.carton_id = ? AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite', 'inconnu')
     ORDER BY c.id`,
    [cartonId]
  );
  return cosses.map((x) => ({ ...x, colis: x.ticket ? Number(String(x.ticket).split('|').pop()) : null, pieces: x.pieces === null ? null : Number(x.pieces) }));
}

// Vue d'un carton pour le web et le mobile
async function vueCarton(connexion, carton) {
  const cosses = await cossesDuCarton(connexion, carton.id);
  // cosses encore dans le carton : rangées et pas encore sorties (export)
  let enStock = 0;
  if (carton.statut === 'range') {
    const tickets = cosses.filter((x) => x.reception_id && x.ticket).map((x) => x.ticket);
    const [sortis] = tickets.length
      ? await connexion.query("SELECT COUNT(DISTINCT ticket) AS n FROM controles_mobile WHERE controle = 'export' AND resultat IN ('prelevement_ok', 'sortie_terminee') AND ticket IN (?)", [tickets])
      : [[{ n: 0 }]];
    // les cosses descendues (carton ouvert à l'export) ne sont plus dans le carton
    const [descendus] = tickets.length
      ? await connexion.query('SELECT COUNT(*) AS n FROM descentes_carton_cosses WHERE pose_le IS NOT NULL AND ticket IN (?)', [tickets])
      : [[{ n: 0 }]];
    enStock = tickets.length - Number(sortis[0].n) - Number(descendus[0].n);
  }
  const pieces = cosses.every((x) => x.pieces !== null) ? cosses.reduce((t, x) => t + x.pieces, 0) : null;
  return {
    id: carton.id,
    import_id: carton.import_id,
    palette_id: carton.palette_id ?? null,
    palette_numero: carton.palette_numero ?? null,
    numero: carton.numero,
    reference: carton.reference,
    lot: carton.lot,
    statut: carton.statut,
    cosses: cosses.length,
    pieces,
    imprime: !!carton.date_etiquette,
    date_etiquette: carton.date_etiquette ? dateEtiquette(carton.date_etiquette) : null,
    qr: carton.date_etiquette && pieces !== null ? qrCarton({ ...carton, pieces }) : null,
    emplacement: carton.statut === 'range' ? carton.emplacement : null,
    en_stock: enStock, // cosses encore dans le carton (après les sorties et la descente)
    ouvert_export: carton.statut === 'range' && enStock < cosses.filter((x) => x.reception_id).length, // entamé à l'export
    hors_stock: cosses.filter((x) => !x.reception_id).length, // référence absente du catalogue : pas encore au stock
    liste: cosses.map((x) => ({ controle_id: x.controle_id, colis: x.colis, pieces: x.pieces, reference: x.reference, lot: x.lot, resultat: x.resultat })),
  };
}

// Date d'étiquette unique : maintenant, ou 1 ms après la dernière déjà donnée
async function nouvelleDateEtiquette(connexion) {
  const [[{ derniere }]] = await connexion.query("SELECT DATE_FORMAT(MAX(date_etiquette), '%Y-%m-%d %H:%i:%s.%f') AS derniere FROM cartons");
  let d = new Date();
  if (derniere) {
    const [jour, heure] = derniere.split(' ');
    const [a, mo, j] = jour.split('-').map(Number);
    const [h, mi, s] = heure.split(':');
    const max = new Date(a, mo - 1, j, Number(h), Number(mi), Math.floor(Number(s)), Math.round((Number(s) % 1) * 1000));
    if (d <= max) d = new Date(max.getTime() + 1);
  }
  return dateBase(d);
}

// Emplacement entièrement vide pour une palette de cosses (cartons et cosses séparées), le plus proche de la porte ;
// sinon une place tampon vide ; null s'il n'y en a aucun. occupation : stock + places réservées.
function emplacementPourCarton(occupation, capaciteTampon) {
  const pris = new Set(occupation.filter((l) => l.emplacement && Number(l.quantite) > 0).map((l) => l.emplacement));
  // en haut, avec les connecteurs : le niveau 3 d'abord, puis l'élévateur (les niveaux 1-2 sont pour les cosses séparées)
  const rayon = R.emplacementsHaut().find((c) => !pris.has(c));
  if (rayon) return { code: rayon, tampon: false };
  const tampon = R.placesTampon(capaciteTampon).find((c) => !pris.has(c));
  return tampon ? { code: tampon, tampon: true } : null;
}

module.exports = { SELECT_CARTON, lotComplet, lireEtiquetteCarton, qrCarton, dateEtiquette, cossesDuCarton, vueCarton, nouvelleDateEtiquette, emplacementPourCarton };
