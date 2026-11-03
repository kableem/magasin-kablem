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
const lettres = (premiere: string, derniere: string): string[] => {
  const a = premiere.charCodeAt(0);
  const b = derniere.charCodeAt(0);
  const pas = b >= a ? 1 : -1;
  return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => String.fromCharCode(a + i * pas));
};

// bloc-façade → niveau → numéros, du mur du fond au bout ouvert
const NUMEROTATION: Record<string, Record<number, string[]>> = {
  'A-1': { 1: suite(12, 22), 2: suite(23, 33) },
  'B-1': { 1: suite(122, 132), 2: suite(133, 143) },
  'B-2': { 1: suite(67, 77), 2: suite(78, 88) },
  'C-1': { 1: suite(232, 242), 2: suite(243, 253) },
  'C-2': { 1: suite(177, 187), 2: suite(188, 198) },
  'D-1': { 1: suite(342, 352), 2: suite(353, 363) },
  'D-2': { 1: suite(287, 297), 2: suite(298, 308) },
  'E-2': { 1: suite(614, 627), 2: suite(628, 641), 3: lettres('A', 'N') },
  'E-1': { 1: suite(697, 684), 2: suite(711, 698), 3: ['AC', 'AB', ...lettres('Z', 'O')] },
  'F-2': { 1: suite(773, 757), 2: suite(790, 774) },
  'F-1': { 1: suite(858, 842), 2: suite(875, 859) },
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

// Code d'emplacement valide : bloc A à H, niveau 0 à 4, numéro existant ; ou place tampon T01…
export function estCodeValide(c: string): boolean {
  if (/^T\d{2}$/.test(c)) return true;
  const m = /^([A-H])([0-4])(\d{2})$/.exec(c);
  if (!m) return false;
  const [facades, n] = BLOCS[m[1]];
  return Number(m[3]) <= facades * n - 1;
}
