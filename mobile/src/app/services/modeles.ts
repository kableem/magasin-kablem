// Modèles partagés avec l'API (mêmes noms que l'application web : frontend/src/app/services)
import { codeDuNumero, estCodeValide } from './plan';

export type Role = 'admin' | 'chef_magasin' | 'magasinier';

export interface Utilisateur {
  id: number;
  matricule: string;
  nom: string;
  prenom: string;
  role: Role;
}

export interface Session {
  token: string;
  utilisateur: Utilisateur;
}

export const LIBELLES_ROLES: Record<Role, string> = {
  admin: 'Administrateur',
  chef_magasin: 'Chef de magasin',
  magasinier: 'Magasinier',
};

export type TypeProduit = 'bobine' | 'cosse' | 'connecteur';
export type Couleur = 'vert' | 'orange' | 'rouge';
export type TypeControle = 'reception' | 'rangement' | 'export' | 'ranger';

export interface EmplacementPrevu {
  code: string | null; // null = pas encore rangé
  quantite: number;
}

// Réponse de POST /api/mobile/reception et /api/mobile/rangement
export interface ResultatControle {
  uuid: string;
  controle: TypeControle;
  resultat: string;
  couleur: Couleur;
  titre: string;
  message: string;
  produit: {
    reference: string;
    lot: string;
    type?: TypeProduit;
    taille_bobine?: string | null;
    import_id?: number;
    numero_livraison?: string | null;
  } | null;
  quantite_ticket: number | null;
  quantite_attendue: number | null;
  ecart: number | null;
  emplacements_prevus: EmplacementPrevu[];
  emplacement_scanne: string | null;
  saisie_manuelle: boolean;
  date: string;
  rejoue?: boolean;
  // export : état de la sortie après ce scan
  preparation?: PreparationExport;
  export_id?: number;
  places_liberees?: string[];
  descente?: Descente | null; // export : carton ouvert, cosses restantes à descendre ; descente : état après ce scan
  // ticket fournisseur (un ticket = un colis)
  colis?: { numero: number; confection: number | null; recus: number; attendus: number };
  // import par référence : pièces de ce colis et compteur de sa référence (ce colis compris)
  pieces?: { reference: string; pieces: number; recues: number; attendues: number; colis: number; tolerance: number };
  // cosse déjà reçue séparée, rescannée avec un carton ouvert : elle peut y être mise
  proposition_carton?: { controle_id: number; carton_id: number; numero: number };
  // cosse entrée dans un carton ; scan = uuid du scan (pour la sortir du carton si c'était une cosse séparée)
  carton?: { id: number; numero: number; reference: string; lot: string; cosses: number; scan?: string };
  // palette de cosses : après un scan de réception (cosses, cartons), ou la palette à ranger (rangement)
  palette_cosses?: { id: number; numero: number; cosses: number; cartons?: number; contenu?: string; nb_cartons?: number; nb_separees?: number; references?: string[] };
  // réception par palette : état de la palette après ce scan
  palette?: { id: number; numero: number; type?: TypePalette; taille?: string | null; n?: number; capacite?: number; pleine?: boolean; reste?: number; bobines?: number };
  // rangement, 1re étape : emplacement où aller (POST /mobile/rangement/suggestion)
  suggestion?: SuggestionRangement;
  // ranger le magasin : le déplacement accepté
  deplacement?: DeplacementFait;
}

export interface SuggestionRangement {
  code: string;
  quantite: number; // produits prévus à cet emplacement
  ranges: number; // déjà posés
  niveau: number | null;
  tampon: boolean;
  elevateur: boolean;
}

export interface ContenuEmplacement {
  code: string;
  niveau: number | null;
  tampon: boolean;
  produits: {
    reference: string; lot: string; type: TypeProduit; taille_bobine: string | null; type_cosse?: 'axiale' | 'plat' | null; quantite: number; date_reception: string;
    colis?: number[]; // numéros des colis rangés ici (tickets fournisseur)
  }[];
  controles: { resultat: string; reference: string; lot: string; date: string; par: string }[];
  // palette de cosses (cartons et cosses séparées) : pleine, elle se déplace en entier
  palette?: { id: number; numero: number; cosses: number; separees: number; cartons: { numero: number; reference: string; lot: string; en_stock: number }[] } | null;
}

export interface LigneProduit {
  id: number;
  import_id: number;
  statut_import: 'en_attente' | 'ajoute';
  numero_livraison: string | null;
  type: TypeProduit;
  taille_bobine: string | null;
  type_cosse?: 'axiale' | 'plat' | null;
  reference: string;
  lot: string;
  quantite: number;
  statut: 'a_recevoir' | 'en_cours' | 'recue' | 'rangee' | 'en_ecart';
  nb_recus: number;
  nb_ranges: number;
  emplacements: EmplacementPrevu[];
}

export const LIBELLES_STATUT: Record<LigneProduit['statut'], string> = {
  a_recevoir: 'À recevoir',
  en_cours: 'Réception en cours',
  recue: 'Reçue',
  rangee: 'Rangée',
  en_ecart: 'En écart',
};

export const LIBELLES_TYPE: Record<TypeProduit, string> = { bobine: 'Bobine', cosse: 'Cosse', connecteur: 'Connecteur' };

// ---------- Sortie vers la production (export préparé sur le mobile) ----------
export const DESTINATIONS = ['P1', 'P2', 'P3', 'CET', 'MCW'] as const;
export type Destination = (typeof DESTINATIONS)[number];

export interface LignePreparation {
  id: number;
  ordre: number; // ordre FIFO (1 = le plus ancien)
  lot: string;
  date_reception: string;
  emplacement: string | null; // null = produit pas encore rangé
  quantite: number;
  preleves: number; // colis déjà pris (tickets fournisseur)
  valide: boolean;
  pieces?: number | null; // pièces de ces colis (visibilité), null si inconnues
  pieces_approx?: boolean;
  hors_fifo?: boolean; // pris par l'administrateur à la place du produit proposé par le FIFO
}

export interface PreparationExport {
  id: number;
  reference: string;
  quantite: number;
  destination: Destination;
  statut: 'en_cours' | 'terminee' | 'annulee';
  motif_fin: string | null;
  export_id: number | null;
  date_creation: string;
  type: TypeProduit | null;
  taille_bobine: string | null;
  type_cosse?: 'axiale' | 'plat' | null;
  lignes: LignePreparation[];
  restants: number;
  rejoue?: boolean;
}

// GET /api/mobile/mes-controles
export interface ControleResume {
  uuid: string;
  controle: TypeControle;
  resultat: string;
  couleur: Couleur;
  titre: string;
  reference: string | null;
  lot: string | null;
  emplacement_scanne: string | null;
  emplacement_prevu: string | null;
  message: string;
  saisie_manuelle: boolean;
  date: string;
}

// ---------- Lecture rapide d'un QR côté téléphone (le contrôle réel est fait par l'API) ----------
// Référence article : commence par une lettre et contient un chiffre (F0391, CFLR9YAT30035800002T)
const REFERENCE = /^(?=.*\d)[A-Z][A-Z0-9]{2,39}$/i;

// QR « Codice Articolo » du ticket : la référence seule
export const estQrArticle = (texte: string) => REFERENCE.test(texte.trim());
// Ticket ou emplacement ? Un ticket contient des « ; » (F0391;13000;10;202613167;1)
export const ressembleTicket = (texte: string) => /[;|]/.test(texte) || texte.trim().startsWith('{');

// Référence et lot d'un ticket (formulaire d'export, consultation)
export function referenceEtLot(texte: string): { reference: string; lot: string } {
  const morceaux = texte.split(/[;|\n\t]+/).map((x) => x.split(/[:=]/).pop()!.trim()).filter(Boolean);
  const reference = (morceaux[0] ?? '').toUpperCase().replace(/\s+/g, ' ');
  // ticket fournisseur : référence ; confection ; colis ; lot ; suffixe
  const lot = morceaux.length === 5 ? morceaux[3] : (morceaux[1] ?? '');
  return { reference, lot };
}

// Étiquette d'un carton de cosses (imprimée sur le web) : « référence;lot;pièces;JJ/MM/AAAA HH:MM:SS.mmm »
export const estEtiquetteCarton = (texte: string) => /^\s*[^;]+;[^;]+;\d+;\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}\.\d{3}\s*$/.test(texte);

// GET /api/mobile/carton?qr= : un carton de cosses, ses cosses, sa palette et où il est
export interface CartonConsulte {
  carton: {
    id: number; numero: number; reference: string; lot: string; statut: 'ouvert' | 'termine' | 'range'; cosses: number; pieces: number | null;
    en_stock: number; emplacement: string | null; date_etiquette: string | null;
    liste: { colis: number | null; pieces: number | null; sortie: boolean; en_stock: boolean }[];
  };
  palette: {
    id: number; numero: number; statut: 'ouverte' | 'terminee' | 'rangee'; emplacement: string | null; contenu: string; cosses: number; en_stock: number; nb_separees: number;
    cartons: { id: number; numero: number; reference: string; lot: string; cosses: number; en_stock: number; statut: string }[];
  } | null;
  import: { id: number; numero_livraison: string | null };
}

// QR d'une étiquette d'emplacement : « EMPL:D011 » -> « D011 » (le code seul est accepté aussi),
// le lien de l'étiquette « https://…/e/D011 » -> « D011 »,
// ou le numéro du magasin imprimé sur l'étiquette du rayonnage : « 0012 » -> « A110 », « AC » -> « E313 »
export const codeEmplacement = (texte: string) => {
  const lien = /^https?:\/\/.*\/e\/([A-Z]\d{3}|T\d{2})\/?(?:[?#].*)?$/i.exec(texte.trim());
  if (lien) return lien[1].toUpperCase();
  return codeDuNumero(texte) ?? texte.trim().replace(/^(empl(acement)?|emp|loc)\s*[:=-]\s*/i, '').toUpperCase();
};

// Étiquette d'emplacement : code de l'application (bloc A à H + niveau + numéro, ex. B100), T05, ou numéro du magasin
export const estCodeEmplacement = (texte: string) => estCodeValide(codeEmplacement(texte));

// ---------- Réception d'un import (lien mobile <-> web) ----------
export type EtapeImport = 'en_attente' | 'reception_en_cours' | 'receptionne' | 'a_valider' | 'ajoute' | 'range';
export const ETAPES_IMPORT: Record<EtapeImport, string> = {
  en_attente: 'En attente',
  reception_en_cours: 'Réception en cours',
  receptionne: 'Réceptionné',
  a_valider: 'À valider sur le web',
  ajoute: 'À ranger',
  range: 'Rangé',
};

export interface AnomalieReception {
  type: 'manquant' | 'en_trop' | 'hors_import' | 'pieces_manquantes' | 'pieces_en_trop';
  reference: string;
  lot: string | null; // null : écart de pièces d'une référence (import par référence)
  quantite: number;
  unite?: 'pieces';
  attendues?: number;
  recues?: number;
  colis?: number;
}

export interface AvancementReception {
  attendus: number;
  recus: number;
  manquants: number;
  en_trop: number;
  hors_import: number;
  colis_recus?: number;
}

// Import par référence (fichier de l'Italie : référence + total de pièces, sans lot ni colis) :
// attendus / recus de l'avancement sont alors des pièces
export type StatutReference = 'non_recue' | 'conforme' | 'tolere' | 'manquant' | 'en_trop';
export interface ReferenceAttendue {
  reference: string;
  type: TypeProduit;
  taille_bobine: string | null;
  type_cosse: 'axiale' | 'plat' | null;
  attendues: number;
  recues: number;
  colis: number;
  lots: { lot: string; colis: number; pieces: number }[];
  ecart: number;
  tolerance: number;
  statut: StatutReference;
}
export interface PiecesImport {
  attendues: number;
  recues: number;
  en_trop: number;
  a_reclamer: number;
  references: ReferenceAttendue[];
}

// Carton de cosses plates : une référence, un lot ; il est toujours sur une palette de cosses
export interface CartonReception {
  id: number;
  palette_id: number | null;
  palette_numero: number | null;
  numero: number;
  reference: string | null;
  lot: string | null;
  statut: 'ouvert' | 'termine' | 'range';
  cosses: number;
  pieces: number | null;
  imprime: boolean; // étiquette imprimée sur le web (il ne se rouvre plus)
  emplacement: string | null;
  en_stock: number;
  liste: { controle_id: number; colis: number | null; pieces: number | null; reference: string; lot: string }[];
}

// Palette de cosses : plusieurs cartons (références mélangées possibles) et des cosses séparées ; rangée entière
export interface PaletteCossesReception {
  id: number;
  numero: number;
  statut: 'ouverte' | 'terminee' | 'rangee';
  emplacement: string | null;
  cartons: CartonReception[];
  nb_cartons: number;
  separees: { controle_id: number; colis: number | null; reference: string; lot: string; pieces: number | null }[];
  nb_separees: number;
  cosses: number;
  pieces: number | null;
  references: string[];
  etiquettes_a_imprimer: number;
  contenu: string; // « 3 cartons + 2 cosses séparées · 26 cosses » ; connecteurs : « 4 cartons de connecteurs »
  ouverte_par_moi?: boolean;
  famille?: 'cosse' | 'connecteur' | null;
  descendue?: boolean; // palette de connecteurs du magasin descendue pour être complétée
  a_ajouter?: number; // cartons de l'import ajoutés pendant qu'elle est descendue
  en_stock?: number;
}

// « 45 000 »
export const nombre = (n: number) => Number(n).toLocaleString('fr-FR');

export interface LigneReception {
  id: number;
  reference: string;
  lot: string;
  type: TypeProduit;
  taille_bobine: string | null;
  type_cosse?: 'axiale' | 'plat' | null;
  attendue: number;
  recus: number;
  en_trop: number;
  manquants: number;
  colis_recus?: number[]; // numéros des colis scannés (même référence, même lot, colis différents)
  colis_ranges?: number[];
}

// GET /api/mobile/receptions et /api/mobile/receptions/:id
export interface ImportReception {
  id: number;
  numero_livraison: string | null;
  arrivee: string;
  ordre: number | null;
  prochain: boolean; // le prochain à ajouter au stock
  reception: 'non_commencee' | 'en_cours' | 'terminee';
  etape: EtapeImport;
  avancement: AvancementReception;
  mode?: 'detail' | 'resume';
  // 'separee' : la réception contrôle seulement, le rangement vient après sa validation ; 'palette' : rangée pendant la réception
  mode_reception?: 'separee' | 'palette';
  pieces?: PiecesImport | null; // import par référence
  cartons?: CartonReception[];
  carton_ouvert?: CartonReception | null; // le carton en cours de ce magasinier
  palettes_cosses?: PaletteCossesReception[];
  palette_ouverte?: PaletteCossesReception | null; // la palette de cosses en cours de ce magasinier
  palette_descendue?: PaletteCossesReception | null; // palette de connecteurs du magasin que ce magasinier complète
  a_des_connecteurs?: boolean; // l'import a des connecteurs (cartons sur palette)
  produits?: number;
  lignes?: LigneReception[];
  anomalies?: AnomalieReception[];
  // réception dans l'ordre d'arrivée : un import plus ancien n'est pas encore terminé
  bloque?: boolean;
  bloque_par?: { id: number; numero_livraison: string | null; arrivee: string } | null;
  palettes?: PaletteReception[];
}

// « Ranger le magasin » : déplacements libres du magasinier (sans suggestion du système),
// contrôlés et historisés par l'API avec son matricule
export interface Remplissage {
  n: number;
  capacite: number | null; // null : vide, ou connecteurs (pas de limite)
  libelle: string; // « 4/6 petites bobines », « 7/10 cosses », « vide »
}

// GET /api/mobile/ranger/produit?qr=
export interface ProduitARanger {
  reference: string;
  lot: string;
  colis: number | null;
  type: TypeProduit;
  taille_bobine: string | null;
  type_cosse?: 'axiale' | 'plat' | null;
  emplacements: { code: string; quantite: number }[]; // où ce produit est en stock
  ici: string | null; // emplacement exact du colis, s'il est connu
  carton?: { id: number; numero: number; cosses: number; qr: string } | null; // étiquette d'un carton (il se déplace seul ou avec d'autres)
  palette?: { id: number; numero: number; cosses: number; cartons: number; separees: number } | null; // sa palette : elle se déplace en entier
}

// GET /api/mobile/ranger/emplacement/:code
export interface EmplacementARanger {
  code: string;
  niveau: number | null;
  tampon: boolean;
  produits: { reference: string; lot: string; type: TypeProduit; taille_bobine: string | null; type_cosse?: 'axiale' | 'plat' | null; quantite: number }[];
  remplissage: Remplissage;
}

// Déplacement accepté (dans la réponse du contrôle « ranger »)
export interface DeplacementFait {
  depuis: string;
  vers: string;
  depuis_libre: boolean;
  depuis_remplissage: Remplissage;
  vers_remplissage: Remplissage;
  palette: boolean;
}

export interface MouvementRanger {
  id: number;
  date: string;
  reference: string;
  lot: string;
  type: TypeProduit;
  taille_bobine: string | null;
  type_cosse?: 'axiale' | 'plat' | null;
  quantite: number;
  colis: number | null;
  depuis: string;
  vers: string;
  depuis_liberee: boolean;
  commentaire: string | null;
}

// GET /api/mobile/ranger/mes-deplacements : ce que j'ai rangé aujourd'hui
export interface MesDeplacements {
  deplacements: number;
  refus: number;
  produits: number;
  liberes: number;
  mouvements: MouvementRanger[];
}

// Inventaire initial (chef de magasin, administrateur)
export interface EmplacementInventaire {
  code: string;
  niveau: number | null;
  tampon: boolean;
  contenu: { reception_id: number; reference: string; lot: string; type: TypeProduit; taille_bobine: string | null; type_cosse?: 'axiale' | 'plat' | null; quantite: number }[];
  inventorie_le: string | null;
}

export interface InventaireValide {
  code: string;
  total: number;
  ecarts: { reference: string; lot: string; application: number; compte: number }[];
  message: string;
}

// Réception des bobines et des cosses palette par palette
// (une palette porte des bobines d'une seule taille, ou jusqu'à 10 cosses ; jamais les deux)
export type TypePalette = 'bobine' | 'cosse';

// Un colis d'une palette : une bobine ou une cosse
export interface BobinePalette {
  controle_id: number;
  ticket: string;
  colis: number | null;
  reference: string;
  lot: string;
  emplacement: string | null; // emplacement donné quand la palette est terminée
  range: boolean; // posée : au stock
  motif?: string | null;
}

export interface PaletteReception {
  id: number;
  import_id: number;
  numero: number;
  type: TypePalette | null; // fixé par le 1er colis scanné
  taille: 'grande' | 'moyenne' | 'petite' | null; // bobines seulement
  statut: 'ouverte' | 'terminee' | 'rangee';
  mode: 'entiere' | 'divisee' | null; // entière : un emplacement ; divisée : colis par colis
  emplacement: string | null;
  capacite: number | null;
  n: number;
  pleine: boolean;
  a_ranger: number;
  bobines: BobinePalette[];
  tampon?: boolean;
  motif?: string | null;
}

// POST /api/mobile/receptions/:id/terminer
export interface FinReception {
  etape: EtapeImport;
  ajoute: boolean;
  ajoutes_automatiquement?: number[];
  bloque_par?: { id: number; numero_livraison: string | null; arrivee: string } | null;
  reclamations_creees?: number;
  anomalies: AnomalieReception[];
  avancement?: AvancementReception;
  pieces?: PiecesImport | null;
  hors_import_en_attente?: string[]; // références absentes du catalogue : pas encore au stock
  deja_terminee?: boolean;
}

// Carton de cosses ouvert à l'export : ses cosses restantes descendent tout de suite en cosses séparées,
// chacune à l'emplacement imposé (même référence et même lot le plus proche de la porte, sinon le plus proche vide)
export interface CosseADescendre {
  ticket: string;
  colis: number;
  reference: string;
  lot: string;
  emplacement: string | null;
  posee: boolean;
}

export interface Descente {
  id: number;
  statut: 'en_cours' | 'terminee';
  depuis: string; // emplacement du haut où est la palette
  carton_id: number;
  carton: number; // n° du carton
  reference: string;
  lot: string;
  palette: number | null;
  cosses: CosseADescendre[];
  restantes: number;
  emplacements: string[]; // places où poser les cosses restantes
}
