// Réception des bobines et des cosses par palette (étude n° 2, version 1.2).
//
// Le magasinier déclare chaque palette reçue : il scanne le ticket de chaque colis qu'elle porte,
// puis la termine. L'application choisit alors où la mettre, dans cet ordre :
//   1. un emplacement ENTIÈREMENT VIDE pour la palette entière (près de la référence la plus
//      nombreuse de la palette, sinon le plus proche de la porte) : un seul geste au chariot ;
//   2. sinon, colis par colis sur les palettes commencées (règles 1 à 3 du moteur), selon la place
//      qui reste sur chacune ;
//   3. sinon, la zone tampon : palette entière sur une place vide, sinon colis par colis ;
//   4. sinon, aucune place : le chef agrandit la zone tampon ou range le magasin.
// Une palette porte des bobines OU des cosses, jamais les deux :
//   - bobines (niveau 0) : une seule taille, 6 petites, 2 moyennes ou 1 grande au maximum ;
//   - cosses (niveaux 1 et 2) : 10 cosses au maximum, références mélangées autorisées.
const R = require('./rangement');
const { occupation } = require('./routes/stock');
const { parametresRangement } = require('./parametres');
const { numeroColis } = require('./reception-import');

const TYPES_PALETTE = ['bobine', 'cosse'];

// Type d'une palette (les palettes reçues avant les cosses n'ont que leur taille)
const typePalette = (p) => p.type ?? (p.taille ? 'bobine' : null);

// Nombre de colis que porte une palette pleine (null tant que son 1er colis n'est pas scanné)
function capacitePalette(p) {
  const type = typePalette(p);
  return type ? R.capacite({ type, taille_bobine: p.taille }) : null;
}

// « 3 bobines », « 1 cosse »
const nommer = (type, n) => `${n} ${type === 'cosse' ? 'cosse' : 'bobine'}${n > 1 ? 's' : ''}`;

// Colis reçus sur une palette (bobines ou cosses), avec l'emplacement attribué à chacun
async function bobinesPalette(connexion, paletteId) {
  const [lignes] = await connexion.query(
    `SELECT c.id AS controle_id, c.ticket, c.reception_id, r.type, r.taille_bobine, r.type_cosse, r.reference, r.lot,
            r.longueur, r.largeur, r.hauteur, r.poids,
            DATE_FORMAT(r.date_reception, '%Y-%m-%dT%H:%i:%s') AS date_reception,
            a.id AS affectation_id, a.emplacement, a.range_le IS NOT NULL AS est_range
     FROM controles_mobile c
     JOIN receptions r ON r.id = c.reception_id
     LEFT JOIN affectations_colis a ON a.ticket = c.ticket
     WHERE c.palette_id = ? AND c.controle = 'reception' AND c.resultat = 'conforme'
     ORDER BY c.id`,
    [paletteId]
  );
  return lignes.map((l) => ({ ...l, colis: numeroColis(l.ticket), range: !!l.est_range }));
}

// Palette telle que l'affichent le mobile et le web (« bobines » : les colis de la palette, bobines ou cosses)
async function vuePalette(connexion, p) {
  const bobines = await bobinesPalette(connexion, p.id);
  const capacite = capacitePalette(p);
  return {
    id: p.id, import_id: p.import_id, numero: p.numero, type: typePalette(p), taille: p.taille, statut: p.statut, mode: p.mode,
    emplacement: p.emplacement, capacite, n: bobines.length, pleine: capacite !== null && bobines.length >= capacite,
    a_ranger: bobines.filter((b) => b.emplacement && !b.range).length,
    bobines: bobines.map((b) => ({
      controle_id: b.controle_id, ticket: b.ticket, colis: b.colis, reference: b.reference, lot: b.lot,
      emplacement: b.emplacement, range: b.range,
    })),
  };
}

async function palettesImport(connexion, importId) {
  const [palettes] = await connexion.query('SELECT * FROM palettes_reception WHERE import_id = ? ORDER BY numero', [importId]);
  const vues = [];
  for (const p of palettes) vues.push(await vuePalette(connexion, p));
  return vues;
}

// Référence la plus nombreuse sur la palette ; à égalité, celle du lot le plus ancien
function referenceDominante(bobines) {
  const parRef = new Map();
  for (const b of bobines) {
    const r = parRef.get(b.reference) ?? { reference: b.reference, n: 0, lot: b.lot };
    r.n++;
    if (R.comparerLots(b.lot, r.lot) < 0) r.lot = b.lot;
    parRef.set(b.reference, r);
  }
  return [...parRef.values()].sort((a, b) => b.n - a.n || R.comparerLots(a.lot, b.lot))[0];
}

// Colis regroupés par ligne d'import, comme le moteur les attend
function lignesDe(bobines) {
  const lignes = new Map();
  for (const b of bobines) {
    const l = lignes.get(b.reception_id) ?? {
      id: b.reception_id, type: b.type, taille_bobine: b.taille_bobine, type_cosse: b.type_cosse, reference: b.reference, lot: b.lot,
      date_reception: b.date_reception, quantite: 0,
    };
    l.quantite++;
    lignes.set(b.reception_id, l);
  }
  return [...lignes.values()];
}

// Répartit les colis selon un plan du moteur [{ id: ligne, emplacement, quantite, regle, motif }]
// (colis pris dans l'ordre des numéros). Renvoie les colis placés et ceux qui restent.
function repartir(bobines, plan) {
  const restantes = new Map();
  for (const b of [...bobines].sort((x, y) => (x.colis ?? 0) - (y.colis ?? 0))) {
    restantes.set(b.reception_id, [...(restantes.get(b.reception_id) ?? []), b]);
  }
  const places = [];
  for (const p of plan) {
    if (!p.emplacement) continue;
    for (const b of (restantes.get(p.id) ?? []).splice(0, p.quantite)) {
      places.push({ bobine: b, emplacement: p.emplacement, regle: p.regle, motif: p.motif });
    }
  }
  return { places, reste: [...restantes.values()].flat() };
}

// Choisit l'emplacement des colis pas encore rangés d'une palette (sous le verrou du stock).
// Renvoie { mode, emplacement, places: [{ bobine, emplacement, regle, motif }] }, ou null sans aucune place.
async function placerPalette(connexion, palette, bobines) {
  const aPlacer = bobines.filter((b) => !b.range);
  if (!aPlacer.length) return null;
  const type = typePalette(palette) ?? aPlacer[0].type;
  const { capaciteTampon, limites } = await parametresRangement(connexion);
  const enPlace = (await occupation(connexion, true)).filter((l) => l.emplacement);
  const entiere = (code, regle, motif) => ({
    mode: 'entiere', emplacement: code, places: aPlacer.map((b) => ({ bobine: b, emplacement: code, regle, motif })),
  });

  // Palette déjà posée puis rouverte (colis oublié) : même emplacement s'il reste de la place
  if (palette.mode === 'entiere' && palette.emplacement && bobines.some((b) => b.range)) {
    const dedans = enPlace.filter((l) => l.emplacement === palette.emplacement).reduce((t, l) => t + Number(l.quantite), 0);
    if (dedans + aPlacer.length <= capacitePalette({ ...palette, type })) {
      return entiere(palette.emplacement, 'palette', 'Même emplacement que le reste de la palette');
    }
  }

  // 1. Emplacement entièrement vide pour la palette entière, à son niveau (bobines : 0 ; cosses : 1 et 2).
  //    La palette compte comme un seul produit qui ne va que sur un emplacement vide : le moteur
  //    applique ses règles 4 (près de la même référence) et 5 (le plus proche de la porte).
  const dominante = referenceDominante(aPlacer);
  const palettePleine = {
    id: 0, type, taille_bobine: type === 'bobine' ? 'grande' : null, type_cosse: type === 'cosse' ? 'plat' : null, palette_entiere: true,
    reference: dominante.reference, lot: dominante.lot, quantite: 1, date_reception: '',
  };
  const [vide] = R.proposerPlan([palettePleine], enPlace, { capaciteTampon: 0, limites });
  if (vide?.emplacement) return entiere(vide.emplacement, vide.regle, `Emplacement vide : ${vide.motif.charAt(0).toLowerCase()}${vide.motif.slice(1)}`);

  // 2. Colis par colis dans les rayonnages : palettes commencées (règles 1 à 3), selon la place qui reste
  const rayon = repartir(aPlacer, R.proposerPlan(lignesDe(aPlacer), enPlace, { capaciteTampon: 0, limites }));
  if (!rayon.reste.length) return { mode: 'divisee', emplacement: null, places: rayon.places };

  // 3. Rien en rayon : la palette entière sur une place vide de la zone tampon
  if (rayon.reste.length === aPlacer.length) {
    const [tampon] = R.proposerPlan([palettePleine], enPlace, { capaciteTampon, limites });
    if (tampon?.emplacement && R.estTampon(tampon.emplacement)) {
      return entiere(tampon.emplacement, 6, `Zone tampon : plus d'emplacement vide ${type === 'cosse' ? 'aux niveaux 1 et 2' : 'au niveau 0'}`);
    }
  }

  // 4. Le reste colis par colis en zone tampon (place commencée compatible, sinon vide)
  const dejaPlaces = rayon.places.map((p) => ({ ...p.bobine, quantite: 1, emplacement: p.emplacement }));
  const tampon = repartir(rayon.reste, R.proposerPlan(lignesDe(rayon.reste), [...enPlace, ...dejaPlaces], { capaciteTampon, limites }));
  if (tampon.reste.length) return null;
  return { mode: 'divisee', emplacement: null, places: [...rayon.places, ...tampon.places] };
}

module.exports = {
  TYPES_PALETTE, typePalette, capacitePalette, nommer, bobinesPalette, vuePalette, palettesImport, placerPalette, referenceDominante,
};
