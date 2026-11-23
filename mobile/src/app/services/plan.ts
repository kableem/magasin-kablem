// Plan du magasin (le même que le serveur, backend/src/plan.js, et le web) : blocs A à H.
// Code de l'application = lettre du bloc + niveau + numéro sur 2 chiffres (ex. A110, E127).
// Les étiquettes du rayonnage portent les numéros du magasin (0012, 0614, A … N, AB, AC, Z … O) :
// ici, le lien entre les deux, pour lire une étiquette scannée et afficher le numéro au magasinier.

// Lettre → [façades, emplacements par niveau d'une façade]
const BLOCS: Record<string, [number, number]> = {
  A: [1, 11], B: [2, 11], C: [2, 11], D: [2, 11], E: [2, 14], F: [2, 17], G: [2, 11], H: [1, 11],
};

// Code d'un emplacement à la position p (0 = contre le mur du fond … n - 1 = bout ouvert)
function code(bloc: string, facade: 1 | 2, niveau: number, p: number): string {
  const n = BLOCS[bloc][1];
  const numero = facade === 2 ? 2 * n - 1 - p : bloc === 'D' ? p : n - 1 - p;
  return `${bloc}${niveau}${String(numero).padStart(2, '0')}`;
}

// 0614 → 0627, ou 0697 → 0684
function suite(premier: number, dernier: number): string[] {
  const pas = dernier >= premier ? 1 : -1;
  return Array.from({ length: Math.abs(dernier - premier) + 1 }, (_, i) => String(premier + i * pas).padStart(4, '0'));
}
// Numéros qui commencent à la place n° « debut » (les places d'avant n'ont pas d'étiquette)
const apres = (debut: number, numeros: string[]): string[] => {
  const liste: string[] = [];
  numeros.forEach((n, i) => (liste[debut + i] = n));
  return liste;
};
const lettres = (premiere: string, derniere: string): string[] => {
  const a = premiere.charCodeAt(0);
  const b = derniere.charCodeAt(0);
  const pas = b >= a ? 1 : -1;
  return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => String.fromCharCode(a + i * pas));
};

// bloc-façade → niveau → numéros, du mur du fond au bout ouvert
const NUMEROTATION: Record<string, Record<number, string[]>> = {
  'A-1': { 0: suite(1, 11), 1: suite(12, 22), 2: suite(23, 33), 3: suite(34, 44), 4: suite(45, 55) },
  'B-1': { 0: suite(111, 121), 1: suite(122, 132), 2: suite(133, 143), 3: suite(144, 154), 4: suite(155, 165) },
  'B-2': { 0: suite(56, 66), 1: suite(67, 77), 2: suite(78, 88), 3: suite(89, 99), 4: suite(100, 110) },
  'C-1': { 0: suite(221, 231), 1: suite(232, 242), 2: suite(243, 253), 3: suite(254, 264), 4: suite(265, 275) },
  'C-2': { 0: suite(166, 176), 1: suite(177, 187), 2: suite(188, 198), 3: suite(199, 209), 4: suite(210, 220) },
  // niveaux 3 et 4 : les 2 premières places (côté mur du fond, près du bureau) sont bloquées, sans étiquette
  'D-1': { 0: suite(331, 341), 1: suite(342, 352), 2: suite(353, 363), 3: apres(2, suite(366, 374)), 4: apres(2, suite(377, 385)) },
  'D-2': { 0: suite(276, 286), 1: suite(287, 297), 2: suite(298, 308), 3: suite(309, 319), 4: suite(320, 330) },
  'E-2': { 1: suite(614, 627), 2: suite(628, 641), 3: lettres('A', 'N'), 4: suite(642, 655), 5: suite(656, 669) },
  'E-1': { 1: suite(697, 684), 2: suite(711, 698), 3: ['AC', 'AB', ...lettres('Z', 'O')], 4: suite(725, 712), 5: suite(739, 726) },
  'F-2': { 1: suite(773, 757), 2: suite(790, 774), 3: suite(807, 791), 4: suite(824, 808) },
  'F-1': { 1: suite(858, 842), 2: suite(875, 859), 3: suite(892, 876), 4: suite(909, 893) },
};

const NUMERO_DU_CODE = new Map<string, string>();
for (const [cle, niveaux] of Object.entries(NUMEROTATION)) {
  const [bloc, facade] = cle.split('-');
  for (const [niveau, numeros] of Object.entries(niveaux)) {
    numeros.forEach((numero, p) => NUMERO_DU_CODE.set(code(bloc, Number(facade) as 1 | 2, Number(niveau), p), numero));
  }
}
const CODE_DU_NUMERO = new Map([...NUMERO_DU_CODE].map(([c, numero]) => [numero, c]));

// « 0012 » ou « 12 » → A110 ; « AC » → E313 ; null si ce n'est pas un numéro du magasin
export function codeDuNumero(texte: string): string | null {
  const t = texte.trim().toUpperCase();
  return CODE_DU_NUMERO.get(/^\d{1,4}$/.test(t) ? t.padStart(4, '0') : t) ?? null;
}

// Numéro de l'étiquette d'un emplacement (ex. A110 → 0012), null s'il n'en a pas
export const numeroMagasin = (c: string | null | undefined): string | null => (c ? NUMERO_DU_CODE.get(c) ?? null : null);

// Ce qu'on affiche au magasinier : le numéro de l'étiquette s'il existe, sinon le code
export const nomEmplacement = (c: string | null | undefined): string => numeroMagasin(c) ?? c ?? '';

// Dans un texte (message du serveur, même ancien), chaque code qui a une étiquette devient son numéro :
// « rangé en D100 » ou « 0342 (D100) » → « rangé en 0342 »
export const avecNumeros = (texte: string | null | undefined): string =>
  String(texte ?? '')
    .replace(/\b(\d{4}|[A-Z]{1,2}) \(([A-H][0-5]\d{2})\)/g, (tout, numero, code) => (numeroMagasin(code) === numero ? numero : tout))
    .replace(/\b[A-H][0-5]\d{2}\b/g, (code) => numeroMagasin(code) ?? code);

// Code d'emplacement valide : bloc A à H, niveau 0 à 4 (0 à 5 pour le bloc E), numéro existant ; ou place tampon T01…
export function estCodeValide(c: string): boolean {
  if (/^T\d{2}$/.test(c)) return true;
  const m = /^([A-H])([0-5])(\d{2})$/.exec(c);
  if (!m) return false;
  if (Number(m[2]) === 5 && m[1] !== 'E') return false; // seul le bloc E a un niveau 5
  const [facades, n] = BLOCS[m[1]];
  return Number(m[3]) <= facades * n - 1;
}
