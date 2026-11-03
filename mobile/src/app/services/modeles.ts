// Modèles partagés avec l'API (mêmes noms que l'application web : frontend/src/app/services)
import { codeDuNumero, estCodeValide } from './plan';

export type Role = 'admin' | 'chef_magasin' | 'magasinier' | 'planificateur';

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
  planificateur: 'Planificateur',
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
  // ticket fournisseur (un ticket = un colis)
  colis?: { numero: number; confection: number | null; recus: number; attendus: number };
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
  const reference = (morceaux[0] ?? '').toUpperCase();
  // ticket fournisseur : référence ; confection ; colis ; lot ; suffixe
  const lot = morceaux.length === 5 ? morceaux[3] : (morceaux[1] ?? '');
  return { reference, lot };
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
  type: 'manquant' | 'en_trop' | 'hors_import';
  reference: string;
  lot: string;
  quantite: number;
}

export interface AvancementReception {
  attendus: number;
  recus: number;
  manquants: number;
  en_trop: number;
  hors_import: number;
}

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
  capacite: number | null; // null : vide, ou connecteurs (volume et poids)
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
  deja_terminee?: boolean;
}
