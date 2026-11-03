// Moteur de rangement du magasin (règles définies avec le magasinier).
//
// Plan : blocs A à H, niveaux 0-4 (voir plan.js). La porte de sortie vers la production
// est dans le mur du fond, dans l'allée entre D et E.
// Zone tampon : places T01, T02… au sol devant les blocs A et B (nombre réglable).
//
// Règles :
//  - Niveau 0 = bobines, niveaux 1-2 = cosses (et le niveau 3 du bloc E), autres niveaux = connecteurs.
//  - Quantité N sur une ligne = N produits identiques, rangés un par un.
//  - 1 emplacement (ou place tampon) = 1 palette : 1 grande bobine, 2 moyennes ou 6 petites
//    (une seule taille par palette, références différentes autorisées) ;
//    cosses : 10 plates et 3 axiales au maximum, comptées à part sur la même palette (références différentes autorisées) ;
//    connecteurs : cartons de dimensions et poids variables (1 carton = 1 référence + 1 lot) ;
//    une palette accepte un carton si le volume total, le poids total (15 kg par défaut)
//    et la taille du carton restent dans les limites du niveau (réglables par l'administrateur).
//  - Choix de l'emplacement, dans cet ordre :
//      1. palette non pleine, même référence et même lot
//      2. palette non pleine, même référence
//      3. palette non pleine compatible (bobine de même taille, cosse, connecteur), autre référence
//      4. emplacement vide le plus proche des bobines de la même référence
//         (à égalité, derrière l'ancien lot : l'ancien reste plus près de la sortie)
//      5. sinon, emplacement vide le plus proche de la sortie
//      6. zone tampon (plus de place à son niveau) : palette commencée compatible, sinon place vide
//      7. aucune place, même en zone tampon : le produit ne peut pas être rangé
//  - Connecteurs : règles 1 à 5 d'abord au niveau 3, puis au niveau 4 (élévateur) seulement
//    si aucune place ne convient au niveau 3 ; ensuite zone tampon (limites du niveau 3).

const { TOUS, lireCode, typeEmplacement } = require('./plan');

// Niveaux de chaque type (bloc E : le niveau 3 est aussi pour les cosses)
const NIVEAUX_PAR_TYPE = { bobine: [0], cosse: [1, 2, 3], connecteur: [3, 4] };
const LIBELLE_NIVEAUX = { bobine: 'niveau 0', cosse: 'niveaux 1 et 2 (et 3 du bloc E)', connecteur: 'niveaux 3 et 4' };
// « se range au niveau 0 », « se range aux niveaux 1 et 2 »
const AU_NIVEAU = { bobine: 'au niveau 0', cosse: 'aux niveaux 1 et 2 (et 3 du bloc E)', connecteur: 'aux niveaux 3 et 4' };
const BOBINES_PAR_PALETTE = { grande: 1, moyenne: 2, petite: 6 };
const COSSES_PAR_PALETTE = 10; // cosses plates
const COSSES_AXIALES_PAR_PALETTE = 3; // cosses axiales (petites) : sur la même palette que les plates, comptées à part
const estAxiale = (l) => l.type === 'cosse' && l.type_cosse === 'axiale';
const LIBELLE_TAILLE = { grande: 'grande bobine', moyenne: 'bobines moyennes', petite: 'petites bobines' };

const TAMPON_MAX = 99;

// Limites d'une palette de connecteurs (valeurs par défaut ; l'administrateur peut les changer)
const LIMITES_CONNECTEUR_DEFAUT = {
  longueur: 120, // cm
  largeur: 80, // cm
  hauteur_n3: 100, // cm, hauteur utile au niveau 3
  hauteur_n4: 150, // cm, hauteur utile au niveau 4
  taux: 85, // % du volume réellement utilisable
  poids_max: 15, // kg par palette
};

const REGLES = {
  1: 'Palette commencée : même référence et même lot',
  2: 'Palette commencée : même référence',
  3: 'Palette commencée : même taille de bobine',
  '3c': 'Palette de cosses commencée : autre référence',
  '3k': 'Palette de connecteurs commencée : autre référence',
  4: 'Emplacement vide près de la même référence',
  5: 'Emplacement vide le plus proche de la sortie',
  6: 'Zone tampon : plus de place libre à son niveau',
  7: 'Aucune place libre, même en zone tampon',
};

// ---------- Zone tampon ----------

function codeTampon(n) {
  return `T${String(n).padStart(2, '0')}`;
}

function estTampon(code) {
  return /^T\d{2}$/.test(code || '');
}

function placesTampon(capacite) {
  return Array.from({ length: capacite }, (_, i) => codeTampon(i + 1));
}

// ---------- Plan et distances ----------

// Code valide : emplacement de rayonnage, ou place tampon existante
function emplacementValide(code, capaciteTampon) {
  if (estTampon(code)) {
    const n = Number(code.slice(1));
    return n >= 1 && n <= capaciteTampon;
  }
  return lireCode(code) !== null;
}

// Distance à pied depuis la porte, en nombre d'emplacements (≈ 1,3 m chacun) :
// dans l'allée de la porte on avance depuis le mur ; pour les autres allées on longe
// le bout ouvert puis on entre dans l'allée (fermée par le mur du fond).
const ECART_ENTRE_ALLEES = 6.4; // largeur d'un bloc + allée, en emplacements
function distance(code) {
  const e = lireCode(code);
  if (!e) return Infinity;
  if (e.allee === 0) return e.position;
  return 10 + e.allee * ECART_ENTRE_ALLEES + (10 - e.position);
}

// À distance égale de la porte : D, C, B, A (comme avant), puis E, F, G, H ; puis numéro croissant
const ORDRE_BLOCS = 'DCBAEFGH';
const ordreBloc = (a, b) => ORDRE_BLOCS.indexOf(a[0]) - ORDRE_BLOCS.indexOf(b[0]);

// Emplacements d'un niveau réservés à un type de produit, du plus proche au plus loin de la porte
function emplacementsParProximite(niveau, type = null) {
  return TOUS.filter((c) => Number(c[1]) === niveau && (!type || typeEmplacement(c) === type))
    .sort((a, b) => distance(a) - distance(b) || ordreBloc(a, b) || a.localeCompare(b));
}

// Cosses : tous leurs niveaux forment une seule réserve, classée par distance depuis la porte.
// On remplit colonne par colonne (D100, D200, D101, D201…) ; à même distance, le niveau le plus bas d'abord.
function emplacementsCosses() {
  return TOUS.filter((c) => typeEmplacement(c) === 'cosse').sort(
    (a, b) => distance(a) - distance(b) || a[1] - b[1] || ordreBloc(a, b) || a.localeCompare(b)
  );
}

// Emplacements d'un type de produit, dans l'ordre où on les remplit
function emplacementsDuType(type) {
  if (type === 'cosse') return emplacementsCosses();
  return NIVEAUX_PAR_TYPE[type].flatMap((n) => emplacementsParProximite(n, type));
}

// ---------- Connecteurs : volume, poids, taille du carton ----------

function niveauDe(code) {
  return estTampon(code) ? 3 : lireCode(code)?.niveau;
}

// Limites d'une palette de connecteurs à cet emplacement (zone tampon : limites du niveau 3)
function limitesPalette(code, limites = LIMITES_CONNECTEUR_DEFAUT) {
  const hauteur = niveauDe(code) === 4 ? limites.hauteur_n4 : limites.hauteur_n3;
  return {
    longueur: limites.longueur,
    largeur: limites.largeur,
    hauteur,
    volumeMax: (limites.longueur * limites.largeur * hauteur * limites.taux) / 100,
    poidsMax: limites.poids_max,
  };
}

const volumeCarton = (c) => Number(c.longueur) * Number(c.largeur) * Number(c.hauteur);
const litres = (cm3) => Math.round(cm3 / 1000);
const kg = (n) => Math.round(n * 10) / 10;
const dims = (c) => `${Number(c.longueur)} × ${Number(c.largeur)} × ${Number(c.hauteur)} cm`;

// Le carton tient-il sur la palette (posé tel quel, éventuellement tourné d'un quart de tour) ?
function cartonRentre(c, lim) {
  const L = Number(c.longueur), l = Number(c.largeur), h = Number(c.hauteur);
  return h <= lim.hauteur && ((L <= lim.longueur && l <= lim.largeur) || (L <= lim.largeur && l <= lim.longueur));
}

// Raison pour laquelle un carton ne peut pas aller sur cette palette, ou null
function refusConnecteur(carton, code, occupants, limites) {
  const lim = limitesPalette(code, limites);
  if (!cartonRentre(carton, lim)) {
    return `le carton (${dims(carton)}) ne rentre pas en ${code} : palette ${lim.longueur} × ${lim.largeur} cm, hauteur utile ${lim.hauteur} cm`;
  }
  const poids = occupants.reduce((t, o) => t + Number(o.poids), 0) + Number(carton.poids);
  if (poids > lim.poidsMax + 1e-9) {
    return `${code} dépasserait ${lim.poidsMax} kg (${kg(poids - Number(carton.poids))} kg + ${kg(Number(carton.poids))} kg)`;
  }
  const volume = occupants.reduce((t, o) => t + volumeCarton(o), 0) + volumeCarton(carton);
  if (volume > lim.volumeMax + 1e-6) {
    return `${code} est plein en volume (${litres(volume - volumeCarton(carton))} L + ${litres(volumeCarton(carton))} L > ${litres(lim.volumeMax)} L)`;
  }
  return null;
}

// Contrôle d'un carton à la saisie : refusé s'il ne peut aller sur aucune palette, même vide
function controlerCarton(c, limites = LIMITES_CONNECTEUR_DEFAUT) {
  for (const champ of ['longueur', 'largeur', 'hauteur', 'poids']) {
    const v = Number(c[champ]);
    if (!Number.isFinite(v) || v <= 0) return `Carton : ${champ} invalide (nombre positif obligatoire)`;
  }
  if (Number(c.poids) > limites.poids_max) {
    return `Carton refusé : ${kg(Number(c.poids))} kg dépasse la limite de ${limites.poids_max} kg par palette`;
  }
  const n3 = limitesPalette('D300', limites);
  const n4 = limitesPalette('D400', limites);
  const okN3 = cartonRentre(c, n3) && volumeCarton(c) <= n3.volumeMax;
  const okN4 = cartonRentre(c, n4) && volumeCarton(c) <= n4.volumeMax;
  if (!okN3 && !okN4) {
    return `Carton refusé : ${dims(c)} ne rentre sur aucune palette (${limites.longueur} × ${limites.largeur} cm, hauteur utile ${limites.hauteur_n3} cm au niveau 3 et ${limites.hauteur_n4} cm au niveau 4)`;
  }
  return null;
}

// ---------- Palettes ----------

function capacite(ligne) {
  // Palette de réception posée entière : elle ne va que sur un emplacement entièrement vide
  if (ligne.palette_entiere) return 1;
  if (ligne.type === 'bobine') return BOBINES_PAR_PALETTE[ligne.taille_bobine] || 1;
  if (ligne.type === 'cosse') return estAxiale(ligne) ? COSSES_AXIALES_PAR_PALETTE : COSSES_PAR_PALETTE;
  return Infinity; // connecteurs : limités par le volume et le poids, pas par un nombre
}

// Deux lignes peuvent partager une palette : bobines de même taille, cosses entre elles
// (plates et axiales ensemble), connecteurs entre eux
// Occupants qui comptent dans la capacité d'une unité : sur une palette de cosses,
// les plates (10 au maximum) et les axiales (4 au maximum) sont comptées chacune à part
const memeCompte = (unite, occupants) => (unite.type === 'cosse' ? occupants.filter((o) => estAxiale(o) === estAxiale(unite)) : occupants);

function peutPartager(a, b) {
  if (a.type === 'bobine' && b.type === 'bobine') return a.taille_bobine === b.taille_bobine;
  return a.type === b.type && a.type !== 'bobine';
}

// Lots comparés comme des nombres (et non comme du texte) ; lots non numériques à la fin
function comparerLots(a, b) {
  const numA = /^\d+$/.test(a);
  const numB = /^\d+$/.test(b);
  if (numA && numB) {
    const x = a.replace(/^0+(?=\d)/, '');
    const y = b.replace(/^0+(?=\d)/, '');
    return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
  }
  if (numA !== numB) return numA ? -1 : 1;
  return a.localeCompare(b, 'fr', { numeric: true });
}

// Ordre FIFO : plus petit lot, puis réception la plus ancienne
function ordreFifo(a, b) {
  return (
    comparerLots(a.lot, b.lot) ||
    ((a.date_reception || '') < (b.date_reception || '') ? -1 : (a.date_reception || '') > (b.date_reception || '') ? 1 : 0) ||
    a.id - b.id
  );
}

// ---------- Plan de rangement ----------
//
// Une ligne de stock de quantité N représente N produits identiques (même référence, même lot,
// même date de réception). Le moteur range ces produits UN PAR UN (« unités ») :
// une bobine = une unité ; une palette de cosses ou de connecteurs = une unité.
// Le résultat est regroupé par emplacement : [{ id: ligne, emplacement, quantite, regle, motif }].

// Déplie des lignes en unités (une par produit) ; garde l'emplacement si la ligne est déjà rangée
function deplier(lignes) {
  const unites = [];
  for (const l of lignes) {
    const n = Number(l.quantite ?? 1);
    for (let k = 0; k < n; k++) unites.push({ ...l, quantite: 1 });
  }
  return unites;
}

// Contenu (en unités) de chaque emplacement et place tampon
function etatMagasin(lignesRangees) {
  const contenu = new Map(); // code -> unités
  for (const u of deplier(lignesRangees.filter((l) => l.emplacement))) {
    contenu.set(u.emplacement, [...(contenu.get(u.emplacement) ?? []), u]);
  }
  return contenu;
}

function placeLibre(unite, occupants, code, limites) {
  if (occupants.length && !occupants.every((o) => peutPartager(o, unite))) return false;
  if (unite.type === 'connecteur') return !refusConnecteur(unite, code, occupants, limites);
  return memeCompte(unite, occupants).length < capacite(unite);
}

// Règles 1 à 5 parmi des emplacements candidats ; null si aucun ne convient
function chercherEnRayon(unite, contenu, candidats, limites) {
  const occ = (c) => contenu.get(c) ?? [];

  // Règles 1 à 3 : compléter une palette déjà commencée compatible, avec de la place restante
  const commencees = candidats.filter((c) => occ(c).length && placeLibre(unite, occ(c), c, limites));
  const regles = [
    [1, (o) => o.some((x) => x.reference === unite.reference && x.lot === unite.lot)],
    [2, (o) => o.some((x) => x.reference === unite.reference)],
    [3, () => true],
  ];
  for (const [regle, test] of regles) {
    const code = commencees.find((c) => test(occ(c)));
    if (code) {
      const choix = poser(unite, code, regle, contenu);
      if (regle === 3 && unite.type === 'cosse') choix.motif = REGLES['3c'];
      if (regle === 3 && unite.type === 'connecteur') choix.motif = REGLES['3k'];
      return choix;
    }
  }

  // Règle 4 : emplacement vide près des palettes de la même référence (parmi les mêmes candidats)
  const vides = candidats.filter((c) => !occ(c).length && placeLibre(unite, [], c, limites));
  const dansCandidats = new Set(candidats);
  const memeReference = [...contenu.entries()]
    .filter(([c, o]) => dansCandidats.has(c) && o.some((x) => x.reference === unite.reference))
    .map(([c]) => distance(c));
  if (vides.length && memeReference.length) {
    const ecart = (c) => Math.min(...memeReference.map((d) => Math.abs(distance(c) - d)));
    // À écart égal : le plus loin de la porte, pour que l'ancien lot (sorti en premier) reste devant
    const code = [...vides].sort((a, b) => ecart(a) - ecart(b) || distance(b) - distance(a))[0];
    return poser(unite, code, 4, contenu);
  }

  // Règle 5 : emplacement vide le plus proche de la sortie
  if (vides.length) return poser(unite, vides[0], 5, contenu);
  return null;
}

// Choisit l'emplacement d'une unité et met à jour l'état du magasin.
// capaciteTampon = 0 : pas de zone tampon (l'unité reste sans place si le rayonnage est plein).
function choisirEmplacement(unite, contenu, capaciteTampon, limites) {
  // Connecteurs : niveau 3 d'abord ; le niveau 4 (élévateur) seulement s'il ne reste rien au niveau 3
  const passes =
    unite.type === 'connecteur'
      ? [emplacementsParProximite(3, 'connecteur'), emplacementsParProximite(4, 'connecteur')]
      : [emplacementsDuType(unite.type)];
  for (const candidats of passes) {
    const choix = chercherEnRayon(unite, contenu, candidats, limites);
    if (choix) return choix;
  }

  // Règle 6 : zone tampon (palette commencée compatible, sinon place vide)
  const tampon = placesTampon(capaciteTampon);
  const code =
    tampon.find((c) => (contenu.get(c) ?? []).length && placeLibre(unite, contenu.get(c), c, limites)) ??
    tampon.find((c) => !(contenu.get(c) ?? []).length && placeLibre(unite, [], c, limites));
  if (code) return poser(unite, code, 6, contenu);

  // Règle 7 : aucune place
  return { id: unite.id, emplacement: null, regle: 7, motif: REGLES[7] };
}

function poser(unite, code, regle, contenu) {
  contenu.set(code, [...(contenu.get(code) ?? []), { ...unite, emplacement: code }]);
  return { id: unite.id, emplacement: code, regle, motif: REGLES[regle] };
}

// Regroupe les choix unité par unité en { id, emplacement, quantite } (ordre conservé)
function regrouper(choix) {
  const groupes = [];
  const index = new Map();
  for (const c of choix) {
    const cle = c.id + '|' + c.emplacement;
    if (index.has(cle)) groupes[index.get(cle)].quantite++;
    else {
      index.set(cle, groupes.length);
      groupes.push({ ...c, quantite: 1 });
    }
  }
  return groupes;
}

// Propose les emplacements des lignes à ranger (chaque unité suit les règles).
// lignesARanger : traitées par référence puis lot croissant (les produits d'une même
// référence restent ensemble), ou en FIFO strict (ordre: 'fifo').
// lignesRangees : stock déjà en place (rayonnages et zone tampon), avec emplacement et quantité.
function proposerPlan(
  lignesARanger,
  lignesRangees,
  { ordre = 'reference', capaciteTampon = 0, limites = LIMITES_CONNECTEUR_DEFAUT } = {}
) {
  const contenu = etatMagasin(lignesRangees);
  const tri =
    ordre === 'fifo'
      ? (a, b) => ordreFifo(a, b)
      : (a, b) => a.reference.localeCompare(b.reference, 'fr', { numeric: true }) || ordreFifo(a, b);
  const unites = deplier([...lignesARanger].sort(tri));
  return regrouper(unites.map((u) => choisirEmplacement(u, contenu, capaciteTampon, limites)));
}

// Vérifie un plan [{ id, emplacement, quantite }] (éventuellement modifié par l'administrateur) :
// chaque ligne doit être entièrement rangée, et chaque unité respecter les règles.
// Renvoie un message d'erreur ou null.
function verifierPlan(plan, lignesARanger, lignesRangees, capaciteTampon, limites = LIMITES_CONNECTEUR_DEFAUT) {
  const parId = new Map(lignesARanger.map((l) => [l.id, l]));
  const contenu = etatMagasin(lignesRangees);
  const totaux = new Map();
  for (const { id, emplacement, quantite } of plan) {
    const ligne = parId.get(id);
    if (!ligne) return 'Ligne ' + id + ' introuvable';
    const n = Number(quantite ?? 1);
    if (!Number.isInteger(n) || n <= 0) return 'Quantité invalide pour ' + ligne.reference;
    totaux.set(id, (totaux.get(id) ?? 0) + n);
    if (!emplacement) {
      return `Aucune place pour ${n} × ${ligne.reference} (lot ${ligne.lot}) : la zone tampon est pleine. Augmentez sa capacité ou libérez des places.`;
    }
    if (!emplacementValide(emplacement, capaciteTampon)) {
      return estTampon(emplacement)
        ? `La place ${emplacement} n'existe pas : la zone tampon a ${capaciteTampon} place(s)`
        : `L'emplacement ${emplacement} n'existe pas dans le magasin`;
    }
    const e = lireCode(emplacement);
    if (e && typeEmplacement(emplacement) !== ligne.type) {
      return `${ligne.reference} (${ligne.type}) se range ${AU_NIVEAU[ligne.type]}, pas en ${emplacement}`;
    }
    for (let k = 0; k < n; k++) {
      const occ = contenu.get(emplacement) ?? [];
      if (occ.length && !occ.every((o) => peutPartager(o, ligne))) {
        return `${emplacement} contient déjà ${occ[0].reference} : impossible d'y mettre ${ligne.reference}`;
      }
      if (ligne.type === 'connecteur') {
        const refus = refusConnecteur(ligne, emplacement, occ, limites);
        if (refus) return `${ligne.reference} (lot ${ligne.lot}) : ${refus}`;
      } else if (memeCompte(ligne, occ).length >= capacite(ligne)) {
        if (ligne.type === 'bobine') {
          return `${emplacement} est plein : une palette contient au maximum ${capacite(ligne)} ${LIBELLE_TAILLE[ligne.taille_bobine]}`;
        }
        return estAxiale(ligne)
          ? `${emplacement} est plein pour les cosses axiales : une palette en contient au maximum ${COSSES_AXIALES_PAR_PALETTE}`
          : `${emplacement} est plein : une palette contient au maximum ${COSSES_PAR_PALETTE} cosses plates`;
      }
      contenu.set(emplacement, [...occ, { ...ligne, quantite: 1, emplacement }]);
    }
  }
  for (const l of lignesARanger) {
    const placees = totaux.get(l.id) ?? 0;
    const attendu = Number(l.quantite ?? 1);
    if (placees !== attendu) return `${l.reference} (lot ${l.lot}) : ${placees} rangé(s) sur ${attendu}`;
  }
  return null;
}

// ---------- Sortie vers la production (export) ----------
//
// Le FIFO est obligatoire : le magasinier ne choisit ni le lot ni l'emplacement.
// Ordre des produits pris pour une référence :
//   1. plus petit lot, puis réception la plus ancienne (FIFO) ;
//   2. même lot et même date = produits identiques : d'abord les produits non rangés et ceux de la
//      zone tampon (libère le tampon), puis la palette la moins remplie, toutes références comprises
//      (elle se vide et libère sa place), puis l'emplacement le plus proche de la porte.
// remplissage : emplacement -> nombre total de produits sur la palette.
function ordreSortie(a, b, remplissage = new Map()) {
  const groupe = (l) => (!l.emplacement ? 0 : estTampon(l.emplacement) ? 1 : 2);
  const plein = (l) => remplissage.get(l.emplacement) ?? l.quantite;
  return (
    comparerLots(a.lot, b.lot) ||
    ((a.date_reception || '') < (b.date_reception || '') ? -1 : (a.date_reception || '') > (b.date_reception || '') ? 1 : 0) ||
    groupe(a) - groupe(b) ||
    plein(a) - plein(b) ||
    distance(a.emplacement) - distance(b.emplacement) ||
    (a.reception_id ?? 0) - (b.reception_id ?? 0) ||
    a.id - b.id
  );
}

// Lignes de stock d'une référence (placements) -> prélèvements [{ ligne, quantite }] pour sortir `quantite`.
// tousLesProduits : tout le stock, pour connaître le remplissage réel de chaque palette.
// Renvoie null si le stock de la référence est insuffisant.
function planSortie(lignes, quantite, tousLesProduits = lignes) {
  const remplissage = new Map();
  for (const l of tousLesProduits) {
    if (l.emplacement) remplissage.set(l.emplacement, (remplissage.get(l.emplacement) ?? 0) + l.quantite);
  }
  const prelevements = [];
  let reste = quantite;
  for (const l of [...lignes].sort((a, b) => ordreSortie(a, b, remplissage))) {
    if (reste <= 0) break;
    const q = Math.min(reste, l.quantite);
    prelevements.push({ ligne: l, quantite: q });
    reste -= q;
  }
  return reste > 0 ? null : prelevements;
}

module.exports = {
  REGLES,
  TAMPON_MAX,
  NIVEAUX_PAR_TYPE,
  LIBELLE_NIVEAUX,
  AU_NIVEAU,
  LIBELLE_TAILLE,
  COSSES_PAR_PALETTE,
  COSSES_AXIALES_PAR_PALETTE,
  estAxiale,
  LIMITES_CONNECTEUR_DEFAUT,
  limitesPalette,
  volumeCarton,
  controlerCarton,
  refusConnecteur,
  codeTampon,
  estTampon,
  placesTampon,
  lireCode,
  typeEmplacement,
  emplacementValide,
  distance,
  emplacementsParProximite,
  emplacementsDuType,
  capacite,
  peutPartager,
  comparerLots,
  ordreFifo,
  deplier,
  etatMagasin,
  proposerPlan,
  verifierPlan,
  ordreSortie,
  planSortie,
};
