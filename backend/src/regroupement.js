// « Ranger le magasin » (étude n° 2) : propositions de déplacements pour recréer des emplacements
// entièrement vides, où les prochaines palettes se poseront d'un seul geste.
//
// PLUS APPELÉ PAR L'APPLICATION depuis le 2026-10-29 : à la demande du directeur, les magasiniers
// rangent sans suggestion du système (routes/mobile-ranger.js : déplacements libres, contrôlés et
// historisés). Gardé pour la discussion à venir sur le rangement automatique avant chaque import.
//
// Deux sortes de déplacements, et seulement ceux qui libèrent une place :
//   1. palette entière de la zone tampon vers un emplacement vide de son niveau (un geste au chariot),
//      les plus anciens lots d'abord ;
//   2. regroupement de bobines : vider une palette partielle dans d'autres palettes de même taille.
//      Les palettes les moins remplies d'abord (le moins de bobines à porter) ; chaque bobine va de
//      préférence avec la même référence et le même lot, puis la même référence, puis la palette la plus
//      remplie (pour la compléter), en rayon avant la zone tampon, puis la plus proche.
// Les places réservées à une palette de réception pas encore posée ne sont ni vidées ni remplies au-delà
// de leur capacité. Les propositions sont classées du moins coûteux au plus coûteux.
const R = require('./rangement');

const DISTANCE_TAMPON = 1000; // la zone tampon passe après les rayonnages
const distance = (code) => (R.estTampon(code) ? DISTANCE_TAMPON : R.distance(code));
const capaciteBobine = (taille) => R.capacite({ type: 'bobine', taille_bobine: taille });

// Contenu de chaque emplacement : unités (une par produit), réservées ou non
function contenuParPlace(occupation) {
  const places = new Map();
  for (const l of occupation) {
    if (!l.emplacement) continue;
    const n = Number(l.quantite);
    for (let k = 0; k < n; k++) {
      places.set(l.emplacement, [...(places.get(l.emplacement) ?? []), { ...l, quantite: 1 }]);
    }
  }
  return places;
}

// Lignes du moteur (une par ligne d'import) pour un ensemble d'unités
function lignes(unites) {
  const m = new Map();
  for (const u of unites) {
    const l = m.get(u.reception_id) ?? { ...u, id: u.reception_id, quantite: 0 };
    l.quantite++;
    m.set(u.reception_id, l);
  }
  return [...m.values()];
}

const resume = (unites) =>
  lignes(unites).map((l) => ({ reception_id: l.reception_id, reference: l.reference, lot: l.lot, type: l.type, taille_bobine: l.taille_bobine, quantite: l.quantite }));

function proposerRegroupements(occupation, { capaciteTampon, limites }) {
  const places = contenuParPlace(occupation);
  const occ = (c) => places.get(c) ?? [];
  const etat = () => [...places.entries()].flatMap(([c, us]) => us.map((u) => ({ ...u, emplacement: c })));
  const propositions = [];

  // 1. Palettes de la zone tampon → emplacement vide de leur niveau
  const tampon = R.placesTampon(capaciteTampon)
    .filter((c) => occ(c).length && occ(c).every((u) => !u.reserve))
    .sort((a, b) => R.ordreFifo(occ(a).slice().sort(R.ordreFifo)[0], occ(b).slice().sort(R.ordreFifo)[0]));
  for (const depuis of tampon) {
    const unites = occ(depuis);
    const type = unites[0].type;
    const candidats = R.emplacementsDuType(type).filter((c) => !occ(c).length);
    // près des palettes de la même référence (référence la plus nombreuse), sinon le plus proche de la porte
    const parRef = new Map();
    for (const u of unites) parRef.set(u.reference, (parRef.get(u.reference) ?? 0) + 1);
    const ref = [...parRef.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const memeRef = [...places.entries()].filter(([c, us]) => !R.estTampon(c) && us.some((u) => u.reference === ref)).map(([c]) => distance(c));
    const ecart = (c) => (memeRef.length ? Math.min(...memeRef.map((d) => Math.abs(distance(c) - d))) : distance(c));
    const autres = etat().filter((u) => u.emplacement !== depuis);
    const vers = candidats
      .sort((a, b) => ecart(a) - ecart(b) || distance(a) - distance(b))
      .find((c) => !R.verifierPlan(lignes(unites).map((l) => ({ id: l.id, emplacement: c, quantite: l.quantite })), lignes(unites), autres, capaciteTampon, limites));
    if (!vers) continue;
    propositions.push({
      id: `palette-${depuis}`, sorte: 'palette', depuis, vers, libere: depuis, nb_bobines: 0, gestes: 1,
      produits: resume(unites),
      message: `Déplacer la palette de ${depuis} (zone tampon) vers ${vers}, emplacement vide : un seul geste.`,
    });
    places.set(vers, unites.map((u) => ({ ...u, emplacement: vers })));
    places.delete(depuis);
  }

  // 2. Regroupement des palettes partielles de bobines (rayon et zone tampon)
  const recoivent = new Set(); // une palette qui reçoit des bobines n'est plus vidée ensuite
  const partielles = (taille) =>
    [...places.entries()].filter(([c, us]) => {
      if (!us.length || us[0].type !== 'bobine' || us[0].taille_bobine !== taille) return false;
      return us.length < capaciteBobine(taille);
    });
  for (const taille of ['petite', 'moyenne']) {
    const cap = capaciteBobine(taille);
    for (;;) {
      const sources = partielles(taille)
        .filter(([c, us]) => !recoivent.has(c) && us.every((u) => !u.reserve))
        .sort(([a, x], [b, y]) => x.length - y.length || distance(b) - distance(a)); // les moins remplies, les plus loin d'abord
      let faite = false;
      for (const [depuis, unites] of sources) {
        // pas de place réservée à une palette de réception pas encore posée
        const cibles = partielles(taille).filter(([c, us]) => c !== depuis && us.every((u) => !u.reserve));
        const libres = cibles.reduce((t, [, us]) => t + (cap - us.length), 0);
        if (libres < unites.length) continue;
        const deplacements = [];
        const essai = new Map(cibles.map(([c, us]) => [c, us.length]));
        const contenus = new Map(cibles.map(([c, us]) => [c, us]));
        for (const u of unites.slice().sort(R.ordreFifo)) {
          const score = (c) => {
            const us = contenus.get(c);
            const pareil = us.some((x) => x.reference === u.reference && x.lot === u.lot) ? 0 : us.some((x) => x.reference === u.reference) ? 1 : 2;
            return [pareil, -essai.get(c), R.estTampon(c) ? 1 : 0, Math.abs(distance(c) - distance(depuis))];
          };
          const choix = [...essai.keys()]
            .filter((c) => essai.get(c) < cap)
            .sort((a, b) => {
              const [x, y] = [score(a), score(b)];
              return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3];
            })[0];
          essai.set(choix, essai.get(choix) + 1);
          contenus.set(choix, [...contenus.get(choix), u]);
          deplacements.push({ ...u, vers: choix });
        }
        // Bobines regroupées par destination
        const parVers = new Map();
        for (const d of deplacements) parVers.set(d.vers, [...(parVers.get(d.vers) ?? []), d]);
        const etapes = [...parVers.entries()].map(([vers, us]) => ({ vers, produits: resume(us) }));
        propositions.push({
          id: `regroupement-${depuis}`, sorte: 'regroupement', depuis, libere: depuis, nb_bobines: unites.length, gestes: unites.length,
          etapes,
          produits: resume(unites),
          message: `Libérer ${depuis} : déplacer ${unites.length} bobine${unites.length > 1 ? 's' : ''} vers ${etapes.map((e) => e.vers).join(', ')}.`,
        });
        for (const d of deplacements) {
          places.set(d.vers, [...occ(d.vers), { ...d, emplacement: d.vers }]);
          recoivent.add(d.vers);
        }
        places.delete(depuis);
        faite = true;
        break;
      }
      if (!faite) break;
    }
  }
  return propositions.sort((a, b) => a.gestes - b.gestes || (a.sorte === 'palette' ? -1 : 1));
}

module.exports = { proposerRegroupements };
