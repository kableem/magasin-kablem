// Plan du magasin (le même que la page Emplacements du web, frontend/src/app/pages/emplacements/plan-magasin.ts).
//
// Blocs A à H, niveaux 0 (sol) à 4 (haut). A et H : une seule façade, contre un mur ; les autres : deux façades.
// La porte de sortie vers la production est dans le mur du fond, dans l'allée entre D et E.
// Code de l'application = lettre du bloc + niveau + numéro sur 2 chiffres (ex. A110, E127).
// Par niveau d'une façade : 11 emplacements (14 pour E, 17 pour F) ; façade 1 = 00 → n-1, façade 2 = n → 2n-1.
// Niveau 0 = bobines ; niveaux 1-2 = cosses (et le niveau 3 du bloc E) ; les autres niveaux = connecteurs.
//
// Numéros du magasin : ceux imprimés sur les étiquettes du rayonnage (0012, 0614, A … N, AB, AC, Z … O).
// Ils ne concernent que les places des cosses ; le QR d'une étiquette contient exactement ce texte.

const BLOCS = {
  A: { nbFacades: 1, emplacements: 11, niveauxCosses: [1, 2] },
  B: { nbFacades: 2, emplacements: 11, niveauxCosses: [1, 2] },
  C: { nbFacades: 2, emplacements: 11, niveauxCosses: [1, 2] },
  D: { nbFacades: 2, emplacements: 11, niveauxCosses: [1, 2] },
  E: { nbFacades: 2, emplacements: 14, niveauxCosses: [1, 2, 3] },
  F: { nbFacades: 2, emplacements: 17, niveauxCosses: [1, 2] },
  G: { nbFacades: 2, emplacements: 11, niveauxCosses: [1, 2] },
  H: { nbFacades: 1, emplacements: 11, niveauxCosses: [1, 2] },
};
const NIVEAUX = [0, 1, 2, 3, 4];

// Allée d'accès : 0 = allée de la porte (D façade 1 et E façade 2), puis en s'éloignant
const ALLEE = {
  D1: 0, D2: 1, C1: 1, C2: 2, B1: 2, B2: 3, A1: 3,
  E2: 0, E1: 1, F2: 1, F1: 2, G2: 2, G1: 3, H1: 3,
};

const codeEmplacement = (bloc, niveau, numero) => `${bloc}${niveau}${String(numero).padStart(2, '0')}`;

// Décompose un code (ex. E127) ; null si l'emplacement n'existe pas
function lireCode(code) {
  const m = /^([A-H])([0-4])(\d{2})$/.exec(code || '');
  if (!m) return null;
  const bloc = m[1];
  const niveau = Number(m[2]);
  const numero = Number(m[3]);
  const { nbFacades, emplacements: n } = BLOCS[bloc];
  if (numero > nbFacades * n - 1) return null;
  const facade = numero < n ? 1 : 2;
  // Position dans le rayonnage : 0 = contre le mur du fond … n - 1 = bout ouvert
  const position = facade === 2 ? 2 * n - 1 - numero : bloc === 'D' ? numero : n - 1 - numero;
  return { code, bloc, niveau, numero, facade, position, allee: ALLEE[`${bloc}${facade}`] };
}

// Type de produit rangé à cet emplacement : bobine, cosse ou connecteur (null : code inconnu)
function typeEmplacement(code) {
  const e = lireCode(code);
  if (!e) return null;
  if (e.niveau === 0) return 'bobine';
  return BLOCS[e.bloc].niveauxCosses.includes(e.niveau) ? 'cosse' : 'connecteur';
}

// Tous les codes du magasin
const TOUS = Object.entries(BLOCS).flatMap(([bloc, { nbFacades, emplacements }]) =>
  NIVEAUX.flatMap((niveau) => Array.from({ length: nbFacades * emplacements }, (_, n) => codeEmplacement(bloc, niveau, n)))
);

// ---------- Numéros du magasin ----------

// 0614 → 0627, ou 0697 → 0684 (sens décroissant)
function suite(premier, dernier) {
  const pas = dernier >= premier ? 1 : -1;
  return Array.from({ length: Math.abs(dernier - premier) + 1 }, (_, i) => String(premier + i * pas).padStart(4, '0'));
}
// A → N, ou Z → O : lettres comme les colonnes d'Excel
const rangLettre = (l) => [...l].reduce((s, c) => s * 26 + c.charCodeAt(0) - 64, 0);
function nomLettre(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function lettres(premiere, derniere) {
  const a = rangLettre(premiere);
  const b = rangLettre(derniere);
  const pas = b >= a ? 1 : -1;
  return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => nomLettre(a + i * pas));
}

// bloc-façade → niveau → numéros, du mur du fond (position 0) au bout ouvert
const NUMEROTATION = {
  'A-1': { 1: suite(12, 22), 2: suite(23, 33) },
  'B-1': { 1: suite(122, 132), 2: suite(133, 143) },
  'B-2': { 1: suite(67, 77), 2: suite(78, 88) },
  'C-1': { 1: suite(232, 242), 2: suite(243, 253) },
  'C-2': { 1: suite(177, 187), 2: suite(188, 198) },
  'D-1': { 1: suite(342, 352), 2: suite(353, 363) },
  'D-2': { 1: suite(287, 297), 2: suite(298, 308) },
  'E-2': { 1: suite(614, 627), 2: suite(628, 641), 3: lettres('A', 'N') },
  // Niveau 3 de la façade B : AC, AB puis Z → O (il n'y a pas d'étiquette « AA »)
  'E-1': { 1: suite(697, 684), 2: suite(711, 698), 3: ['AC', 'AB', ...lettres('Z', 'O')] },
  'F-2': { 1: suite(773, 757), 2: suite(790, 774) },
  'F-1': { 1: suite(858, 842), 2: suite(875, 859) },
};

// Code → numéro du magasin (ex. A110 → 0012), et l'inverse
const NUMERO_DU_CODE = new Map();
for (const code of TOUS) {
  const e = lireCode(code);
  const numero = NUMEROTATION[`${e.bloc}-${e.facade}`]?.[e.niveau]?.[e.position];
  if (numero) NUMERO_DU_CODE.set(code, numero);
}
const CODE_DU_NUMERO = new Map([...NUMERO_DU_CODE].map(([code, numero]) => [numero, code]));

// « 0012 » ou « 12 » → A110 ; « AC » → E313 ; null si ce n'est pas un numéro du magasin
function codeDuNumero(texte) {
  const t = String(texte ?? '').trim().toUpperCase();
  if (/^\d{1,4}$/.test(t)) return CODE_DU_NUMERO.get(t.padStart(4, '0')) ?? null;
  return CODE_DU_NUMERO.get(t) ?? null;
}

// Nom d'un emplacement pour les messages : « 0012 (A110) », ou le code seul s'il n'a pas de numéro
function nomEmplacement(code) {
  const numero = NUMERO_DU_CODE.get(code);
  return numero ? `${numero} (${code})` : code;
}

// Dans un message pour le téléphone, chaque code qui a une étiquette est précisé par son numéro :
// « allez en E127 » → « allez en 0614 (E127) » (le magasinier lit le numéro sur l'étiquette)
const avecNumeros = (texte) => String(texte ?? '').replace(/\b[A-H][0-4]\d{2}\b/g, (c) => nomEmplacement(c));

module.exports = {
  BLOCS, NIVEAUX, ALLEE, TOUS, codeEmplacement, lireCode, typeEmplacement,
  NUMERO_DU_CODE, codeDuNumero, nomEmplacement, avecNumeros,
};
