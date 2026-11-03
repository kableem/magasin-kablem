// Plan du magasin (le même que le serveur, backend/src/plan.js) : 8 blocs (A à H), 5 niveaux (0 = sol … 4 = haut).
// - Blocs A et H : une seule façade, contre un mur ; blocs B à G : deux façades.
// - 11 emplacements par niveau et par façade ; bloc E : 14 (cosses aux niveaux 1, 2 et 3) ; bloc F : 17.
// - Code = lettre du bloc + niveau + numéro sur 2 chiffres (ex. C215).
// - 1 emplacement = 1 palette.
//
// La porte de sortie vers la production est dans le mur du fond, dans l'allée entre D et E.
// Numéros de l'application, par façade de n emplacements : façade 1 de 00 à n-1, façade 2 de n à 2n-1.
// - D façade 1 (allée de la porte) : 00 contre la porte → 10 au bout ouvert.
// - Autres façades 1 : 00 au bout ouvert → n-1 contre le mur ; façades 2 : n au bout ouvert → 2n-1 contre le mur.
// Les étiquettes du rayonnage portent les numéros du magasin (0012, 0614, A … N…) : voir NUMEROS_MAGASIN.

export interface Emplacement {
  code: string;
  bloc: string;
  niveau: number;
  facade: 1 | 2;
  numero: number;
  position: number; // place dans le rayonnage : 0 = contre le mur du fond … 10 = bout ouvert (13 pour le bloc E d'essai)
}

export interface Facade {
  id: string; // ex. "B-2"
  bloc: string;
  numero: 1 | 2;
  libelle: string;
  allee: string; // allée depuis laquelle on accède à la façade
  normale: 1 | -1; // +1 : la façade regarde vers le bloc D, -1 : vers le bloc A
  // Du niveau 4 (haut) au niveau 0 (sol), pour l'affichage vu de face
  niveaux: { niveau: number; emplacements: Emplacement[] }[];
}

export interface Bloc {
  lettre: string;
  contreMur: boolean;
  nbEmplacements: number; // emplacements par niveau d'une façade
  niveauxCosses: number[]; // niveaux réservés aux cosses dans ce bloc
  facades: Facade[];
}

export const NIVEAUX = [0, 1, 2, 3, 4];
export const EMPLACEMENTS_PAR_FACADE = 11;

export interface DefinitionBloc {
  lettre: string;
  nbFacades: 1 | 2;
  emplacements?: number; // par niveau d'une façade (11 par défaut)
  niveauxCosses?: number[]; // niveaux 1 et 2 par défaut
}

const DEFINITION_BLOCS: DefinitionBloc[] = [
  { lettre: 'A', nbFacades: 1 },
  { lettre: 'B', nbFacades: 2 },
  { lettre: 'C', nbFacades: 2 },
  { lettre: 'D', nbFacades: 2 },
  { lettre: 'E', nbFacades: 2, emplacements: 14, niveauxCosses: [1, 2, 3] },
  { lettre: 'F', nbFacades: 2, emplacements: 17 },
  { lettre: 'G', nbFacades: 2 },
  { lettre: 'H', nbFacades: 1 },
];

export function codeEmplacement(bloc: string, niveau: number, numero: number): string {
  return `${bloc}${niveau}${String(numero).padStart(2, '0')}`;
}

// Numéro de l'emplacement situé à la position p (0 = mur du fond … n - 1 = bout ouvert),
// n = emplacements par niveau (11 : façade 1 de 00 à 10, façade 2 de 11 à 21)
function numeroA(bloc: string, facade: 1 | 2, p: number, n: number): number {
  if (facade === 2) return 2 * n - 1 - p; // 11 au bout ouvert → 21 contre le mur
  return bloc === 'D' ? p : n - 1 - p; // D : 00 contre la porte ; autres : 00 au bout ouvert
}

function construireFacade(bloc: string, numero: 1 | 2, nbFacades: number, lettres: string[], nbEmplacements: number): Facade {
  const i = lettres.indexOf(bloc);
  // Façade 1 regarde vers le bloc suivant (côté D), façade 2 vers le bloc précédent (côté A).
  // Dernier bloc à une seule façade (contre le mur du bout, comme A) : il regarde vers le bloc précédent.
  const dernierContreMur = nbFacades === 1 && i > 0 && i === lettres.length - 1;
  const normale: 1 | -1 = numero === 1 && !dernierContreMur ? 1 : -1;
  const allee =
    normale === 1
      ? bloc === 'D' ? 'allée de la porte' : `allée ${bloc}-${lettres[i + 1]}`
      : lettres[i - 1] === 'D' ? 'allée de la porte' : `allée ${lettres[i - 1]}-${bloc}`;
  return {
    id: `${bloc}-${numero}`,
    bloc,
    numero,
    libelle: nbFacades === 1 ? 'Façade unique' : `Façade ${numero}`,
    allee,
    normale,
    niveaux: [...NIVEAUX].reverse().map((niveau) => ({
      niveau,
      emplacements: Array.from({ length: nbEmplacements }, (_, p) => {
        const n = numeroA(bloc, numero, p, nbEmplacements);
        return { code: codeEmplacement(bloc, niveau, n), bloc, niveau, facade: numero, numero: n, position: p };
      }).sort((x, y) => x.numero - y.numero),
    })),
  };
}

export function construireBlocs(definitions: DefinitionBloc[]): Bloc[] {
  const lettres = definitions.map((b) => b.lettre);
  return definitions.map(({ lettre, nbFacades, emplacements = EMPLACEMENTS_PAR_FACADE, niveauxCosses = [1, 2] }) => ({
    lettre,
    contreMur: nbFacades === 1,
    nbEmplacements: emplacements,
    niveauxCosses,
    facades: Array.from({ length: nbFacades }, (_, i) =>
      construireFacade(lettre, (i + 1) as 1 | 2, nbFacades, lettres, emplacements)
    ),
  }));
}

export function tousLesEmplacements(blocs: Bloc[]): Emplacement[] {
  return blocs.flatMap((b) => b.facades.flatMap((f) => f.niveaux.flatMap((n) => n.emplacements)));
}

export const BLOCS: Bloc[] = construireBlocs(DEFINITION_BLOCS);

export const TOUS_LES_EMPLACEMENTS: Emplacement[] = tousLesEmplacements(BLOCS);

// Classement du magasin : niveaux réservés à chaque type de produit (bloc E : le niveau 3 est aussi pour les cosses)
export const NIVEAUX_PAR_TYPE: Record<'bobine' | 'cosse' | 'connecteur', number[]> = {
  bobine: [0],
  cosse: [1, 2, 3],
  connecteur: [3, 4],
};

export const LIBELLE_NIVEAUX_TYPE: Record<'bobine' | 'cosse' | 'connecteur', string> = {
  bobine: 'niveau 0',
  cosse: 'niveaux 1 et 2 (et 3 du bloc E)',
  connecteur: 'niveaux 3 et 4',
};

// Type de produit rangé à un niveau donné, hors bloc E (voir typeEmplacement)
export function typeDuNiveau(niveau: number): 'bobine' | 'cosse' | 'connecteur' {
  return niveau === 0 ? 'bobine' : niveau <= 2 ? 'cosse' : 'connecteur';
}

// Type de produit rangé à cet emplacement (bloc E : le niveau 3 est pour les cosses)
export function typeEmplacement(e: Emplacement): 'bobine' | 'cosse' | 'connecteur' {
  if (e.niveau === 0) return 'bobine';
  return BLOCS.find((b) => b.lettre === e.bloc)?.niveauxCosses.includes(e.niveau) ? 'cosse' : 'connecteur';
}

// ---------- Numéros du magasin (ceux des étiquettes du rayonnage) ----------
// Façade A = côté porte, façade B = l'autre côté :
//  - blocs A à D : façade A = façade 1 de l'application (regarde vers D), façade B = façade 2 ;
//  - blocs E et F (après la porte) : façade A = façade 2 (regarde vers la porte), façade B = façade 1.
// Le premier numéro est contre le mur du fond, le dernier au bout ouvert : A110 = 0012 … A100 = 0022.

// 0614 → 0627, ou 0697 → 0684 (sens décroissant)
function suite(premier: number, dernier: number): string[] {
  const pas = dernier >= premier ? 1 : -1;
  return Array.from({ length: Math.abs(dernier - premier) + 1 }, (_, i) => String(premier + i * pas).padStart(4, '0'));
}

// A → N, ou Z → O : lettres comme les colonnes d'Excel (A … Z, AA, AB…)
function rangLettre(l: string): number {
  return [...l].reduce((s, c) => s * 26 + c.charCodeAt(0) - 64, 0);
}
function nomLettre(n: number): string {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function lettres(premiere: string, derniere: string): string[] {
  const a = rangLettre(premiere);
  const b = rangLettre(derniere);
  const pas = b >= a ? 1 : -1;
  return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => nomLettre(a + i * pas));
}

// bloc-façade de l'application → niveau → numéros, du mur du fond au bout ouvert
const NUMEROTATION: Record<string, Record<number, string[]>> = {
  'A-1': { 1: suite(12, 22), 2: suite(23, 33) },
  'B-1': { 1: suite(122, 132), 2: suite(133, 143) },
  'B-2': { 1: suite(67, 77), 2: suite(78, 88) },
  'C-1': { 1: suite(232, 242), 2: suite(243, 253) },
  'C-2': { 1: suite(177, 187), 2: suite(188, 198) },
  'D-1': { 1: suite(342, 352), 2: suite(353, 363) },
  'D-2': { 1: suite(287, 297), 2: suite(298, 308) },
  'E-2': { 1: suite(614, 627), 2: suite(628, 641), 3: lettres('A', 'N') },
  // Niveau 3 de la façade B : AC, AB puis Z → O (il n'y a pas d'étiquette « AA ») = 14 places
  'E-1': { 1: suite(697, 684), 2: suite(711, 698), 3: ['AC', 'AB', ...lettres('Z', 'O')] },
  'F-2': { 1: suite(773, 757), 2: suite(790, 774) },
  'F-1': { 1: suite(858, 842), 2: suite(875, 859) },
};

// Code de l'application → numéro du magasin (ex. A110 → 0012)
export const NUMEROS_MAGASIN = new Map<string, string>(
  TOUS_LES_EMPLACEMENTS.flatMap((e) => {
    const numeros = NUMEROTATION[`${e.bloc}-${e.facade}`]?.[e.niveau];
    return numeros?.[e.position] ? [[e.code, numeros[e.position]] as [string, string]] : [];
  })
);

const CODE_DU_NUMERO = new Map<string, string>([...NUMEROS_MAGASIN].map(([code, numero]) => [numero, code]));

// « 0012 » ou « 12 » → A110 ; « AC » → E313 ; null si ce n'est pas un numéro du magasin
export function codeDuNumero(texte: string | null | undefined): string | null {
  const t = String(texte ?? '').trim().toUpperCase();
  return CODE_DU_NUMERO.get(/^\d{1,4}$/.test(t) ? t.padStart(4, '0') : t) ?? null;
}

// Nom d'un emplacement pour l'affichage : « 0012 (A110) », ou le code seul s'il n'a pas de numéro
export function nomEmplacement(code: string | null | undefined): string {
  if (!code) return '';
  const numero = NUMEROS_MAGASIN.get(code);
  return numero ? `${numero} (${code})` : code;
}

// Capacité d'un emplacement (= 1 palette) : 1 grande bobine, 2 moyennes ou 6 petites ;
// cosses : 10 plates et 3 axiales (petites), comptées à part sur la même palette ; 1 palette de connecteurs
export const BOBINES_PAR_PALETTE: Record<'grande' | 'moyenne' | 'petite', number> = {
  grande: 1,
  moyenne: 2,
  petite: 6,
};
export const COSSES_PAR_PALETTE = 10;
export const COSSES_AXIALES_PAR_PALETTE = 3;

interface LigneRangee {
  id: number;
  type: 'bobine' | 'cosse' | 'connecteur';
  taille_bobine: 'grande' | 'moyenne' | 'petite' | null;
  type_cosse?: 'axiale' | 'plat' | null;
  quantite?: number; // nombre de produits identiques (1 par défaut)
}

export const estAxiale = (l: LigneRangee) => l.type === 'cosse' && l.type_cosse === 'axiale';

// Palette de cosses : plates et axiales, chacune avec sa capacité
export function remplissageCosses(lignes: LigneRangee[]): { plates: number; axiales: number } {
  const axiales = nombreProduits(lignes.filter(estAxiale));
  return { plates: nombreProduits(lignes) - axiales, axiales };
}

// Nombre de produits (bobines ou palettes) dans une liste de lignes
export function nombreProduits(lignes: LigneRangee[]): number {
  return lignes.reduce((s, l) => s + (l.quantite ?? 1), 0);
}

export function capacitePalette(l: LigneRangee): number {
  if (l.type === 'bobine' && l.taille_bobine) return BOBINES_PAR_PALETTE[l.taille_bobine];
  if (l.type === 'cosse') return estAxiale(l) ? COSSES_AXIALES_PAR_PALETTE : COSSES_PAR_PALETTE;
  return 1;
}

// Deux lignes peuvent partager une palette : bobines de même taille, ou cosses entre elles
export function peutPartager(a: LigneRangee, b: LigneRangee): boolean {
  if (a.type === 'bobine' && b.type === 'bobine') return a.taille_bobine === b.taille_bobine;
  return a.type === 'cosse' && b.type === 'cosse';
}

// Toute la ligne (sa quantité) peut-elle aller dans un emplacement qui contient déjà « occupants » ?
export function placeDisponible(l: LigneRangee, occupants: LigneRangee[]): boolean {
  const autres = occupants.filter((o) => o.id !== l.id);
  if (autres.length && !autres.every((o) => peutPartager(o, l))) return false;
  // cosses : les plates et les axiales sont comptées chacune à part
  const memes = l.type === 'cosse' ? autres.filter((o) => estAxiale(o) === estAxiale(l)) : autres;
  return nombreProduits(memes) + (l.quantite ?? 1) <= capacitePalette(l);
}

// ---------- Distance depuis la porte (même calcul que le serveur) ----------

// Zone tampon : places T01, T02… au sol devant les blocs A et B (nombre réglable par l'administrateur)
export function codeTampon(n: number): string {
  return `T${String(n).padStart(2, '0')}`;
}

export function estTampon(code: string | null | undefined): boolean {
  return /^T\d{2}$/.test(code ?? '');
}

export function placesTampon(capacite: number): string[] {
  return Array.from({ length: capacite }, (_, i) => codeTampon(i + 1));
}

// Place tampon sous forme d'« emplacement » (pour la sélection et le détail)
export function emplacementTampon(n: number): Emplacement {
  return { code: codeTampon(n), bloc: 'T', niveau: 0, facade: 1, numero: n, position: n - 1 };
}

// Allée d'accès : 0 = allée de la porte (D façade 1), 1 = C-D, 2 = B-C, 3 = A-B
// (plan d'essai, au-delà de la porte : E façade 2 dans l'allée de la porte, puis E-F, F-G, G-H)
const ALLEE: Record<string, number> = {
  D1: 0, D2: 1, C1: 1, C2: 2, B1: 2, B2: 3, A1: 3,
  E2: 0, E1: 1, F2: 1, F1: 2, G2: 2, G1: 3, H1: 3,
};
const ECART_ENTRE_ALLEES = 6.4;

// Distance à pied depuis la porte, en nombre d'emplacements
export function distancePorte(e: Emplacement): number {
  const allee = ALLEE[`${e.bloc}${e.facade}`];
  return allee === 0 ? e.position : 10 + allee * ECART_ENTRE_ALLEES + (10 - e.position);
}

// À distance égale de la porte : D, C, B, A, puis E, F, G, H (comme le serveur) ; puis le code
const ORDRE_BLOCS = 'DCBAEFGH';
function ordreProximite(a: Emplacement, b: Emplacement): number {
  return distancePorte(a) - distancePorte(b) || ORDRE_BLOCS.indexOf(a.bloc) - ORDRE_BLOCS.indexOf(b.bloc) || a.code.localeCompare(b.code);
}

// Rang de chaque emplacement dans son niveau : 1 = le plus proche de la porte
export function rangsProximite(emplacements: Emplacement[]): Map<string, number> {
  return new Map<string, number>(
    NIVEAUX.flatMap((niveau) =>
      emplacements
        .filter((e) => e.niveau === niveau)
        .sort(ordreProximite)
        .map((e, i) => [e.code, i + 1] as [string, number])
    )
  );
}

export const RANG_PROXIMITE = rangsProximite(TOUS_LES_EMPLACEMENTS);

export const EMPLACEMENTS_PAR_PROXIMITE = [...TOUS_LES_EMPLACEMENTS].sort(
  (a, b) => a.niveau - b.niveau || ordreProximite(a, b)
);

// ---------- Connecteurs : volume, poids, taille du carton (mêmes calculs que le serveur) ----------

export interface LimitesPaletteConnecteur {
  longueur: number;
  largeur: number;
  hauteur_n3: number;
  hauteur_n4: number;
  taux: number;
  poids_max: number;
}

interface CartonMesure {
  longueur?: number | null;
  largeur?: number | null;
  hauteur?: number | null;
  poids?: number | null;
}

export function volumeCarton(c: CartonMesure): number {
  return Number(c.longueur) * Number(c.largeur) * Number(c.hauteur);
}

// Hauteur utile et volume utilisable d'une palette à ce niveau (zone tampon : comme le niveau 3)
export function limitesNiveau(niveau: number, l: LimitesPaletteConnecteur) {
  const hauteur = niveau === 4 ? l.hauteur_n4 : l.hauteur_n3;
  return { hauteur, volumeMax: (l.longueur * l.largeur * hauteur * l.taux) / 100 };
}

function cartonRentre(c: CartonMesure, l: LimitesPaletteConnecteur, hauteur: number): boolean {
  const L = Number(c.longueur), lg = Number(c.largeur);
  return Number(c.hauteur) <= hauteur && ((L <= l.longueur && lg <= l.largeur) || (L <= l.largeur && lg <= l.longueur));
}

// Message si le carton ne peut aller sur aucune palette (refusé à la saisie), sinon null
export function controlerCarton(c: CartonMesure, l: LimitesPaletteConnecteur): string | null {
  const noms: Record<string, string> = { longueur: 'longueur', largeur: 'largeur', hauteur: 'hauteur', poids: 'poids' };
  for (const champ of Object.keys(noms)) {
    const v = Number((c as Record<string, unknown>)[champ]);
    if (!Number.isFinite(v) || v <= 0) return `${noms[champ]} manquant(e) ou invalide`;
  }
  if (Number(c.poids) > l.poids_max) return `${c.poids} kg dépasse la limite de ${l.poids_max} kg par palette`;
  const ok = [3, 4].some((n) => {
    const lim = limitesNiveau(n, l);
    return cartonRentre(c, l, lim.hauteur) && volumeCarton(c) <= lim.volumeMax;
  });
  if (!ok) {
    return `ne rentre sur aucune palette (${l.longueur} × ${l.largeur} cm, hauteur ${l.hauteur_n3} cm au niveau 3, ${l.hauteur_n4} cm au niveau 4)`;
  }
  return null;
}

// Une ligne de connecteurs (un ou plusieurs cartons) peut-elle aller sur cet emplacement ?
// (contrôle approché pour proposer des emplacements ; le serveur vérifie carton par carton)
export function placeConnecteur(
  ligne: { volume?: number | null; poids_total?: number | null; hauteur?: number | null },
  occupants: { volume?: number | null; poids_total?: number | null; type: string }[],
  niveau: number,
  l: LimitesPaletteConnecteur
): boolean {
  if (occupants.some((o) => o.type !== 'connecteur')) return false;
  const lim = limitesNiveau(niveau, l);
  const volume = occupants.reduce((s, o) => s + Number(o.volume ?? 0), 0) + Number(ligne.volume ?? 0);
  const poids = occupants.reduce((s, o) => s + Number(o.poids_total ?? 0), 0) + Number(ligne.poids_total ?? 0);
  return Number(ligne.hauteur ?? 0) <= lim.hauteur && volume <= lim.volumeMax && poids <= l.poids_max + 1e-9;
}
