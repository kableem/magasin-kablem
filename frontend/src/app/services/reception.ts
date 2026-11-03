import { HttpClient, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type TypeProduit = 'bobine' | 'cosse' | 'connecteur';

export const TYPES_PRODUIT: { valeur: TypeProduit; libelle: string }[] = [
  { valeur: 'bobine', libelle: 'Bobine' },
  { valeur: 'cosse', libelle: 'Cosse' },
  { valeur: 'connecteur', libelle: 'Connecteur' },
];

export type TailleBobine = 'grande' | 'moyenne' | 'petite';

export const TAILLES_BOBINE: { valeur: TailleBobine; libelle: string }[] = [
  { valeur: 'grande', libelle: 'Grande' },
  { valeur: 'moyenne', libelle: 'Moyenne' },
  { valeur: 'petite', libelle: 'Petite' },
];

// Un carton de connecteurs : dimensions en cm, poids en kg
export interface Carton {
  longueur: number | null;
  largeur: number | null;
  hauteur: number | null;
  poids: number | null;
}

// Limites d'une palette de connecteurs (réglables par l'administrateur)
export interface LimitesConnecteurs {
  longueur: number; // cm
  largeur: number; // cm
  hauteur_n3: number; // cm, hauteur utile au niveau 3
  hauteur_n4: number; // cm, hauteur utile au niveau 4
  taux: number; // % du volume utilisable
  poids_max: number; // kg par palette
}

export interface Parametres {
  tampon_capacite: number;
  tampon_max: number;
  connecteurs: LimitesConnecteurs;
  reclamation_delai_jours: number;
}

// ---------- Réclamations (anomalies constatées à la réception d'un import) ----------
export type MotifReclamation = 'manquant' | 'non_conforme' | 'endommage' | 'non_commande' | 'autre';

export const MOTIFS_RECLAMATION: { valeur: MotifReclamation; libelle: string; aide: string }[] = [
  { valeur: 'manquant', libelle: 'Manquant', aide: 'Annoncé mais pas reçu' },
  { valeur: 'non_conforme', libelle: 'Non conforme', aide: 'Produit différent dans le carton' },
  { valeur: 'endommage', libelle: 'Endommagé', aide: 'Reçu abîmé, inutilisable' },
  { valeur: 'non_commande', libelle: 'Non commandé', aide: 'Reçu en trop, pas dans la commande' },
  { valeur: 'autre', libelle: 'Autre', aide: 'Préciser dans le commentaire' },
];

export function libelleMotif(m: MotifReclamation | string): string {
  return MOTIFS_RECLAMATION.find((x) => x.valeur === m)?.libelle ?? m;
}

// Réclamation d'un produit d'import : la quantité réclamée n'entre pas dans le stock
export interface Reclamation {
  quantite: number;
  motif: MotifReclamation;
  commentaire: string | null;
  date?: string;
  par?: string | null;
}

// Suivi avec le fournisseur (Italie)
export type StatutReclamation = 'ouverte' | 'envoyee' | 'reglee';
export type SolutionReclamation = 'avoir' | 'renvoi' | 'remplacement' | 'autre';
export const STATUTS_RECLAMATION: { valeur: StatutReclamation; libelle: string }[] = [
  { valeur: 'ouverte', libelle: 'Ouverte' },
  { valeur: 'envoyee', libelle: "Envoyée à l'Italie" },
  { valeur: 'reglee', libelle: 'Réglée' },
];
export const SOLUTIONS_RECLAMATION: { valeur: SolutionReclamation; libelle: string }[] = [
  { valeur: 'avoir', libelle: 'Avoir' },
  { valeur: 'renvoi', libelle: 'Renvoi' },
  { valeur: 'remplacement', libelle: 'Remplacement' },
  { valeur: 'autre', libelle: 'Autre' },
];
export function libelleStatut(s: string): string {
  return STATUTS_RECLAMATION.find((x) => x.valeur === s)?.libelle ?? s;
}
export function libelleSolution(s: string | null): string {
  return SOLUTIONS_RECLAMATION.find((x) => x.valeur === s)?.libelle ?? '';
}

// Nombre de réclamations par statut (filtres de la page Réclamations)
export interface CompteursReclamations {
  ouvertes: number;
  envoyees: number;
  reglees: number;
  en_retard: number;
  delai_jours: number;
}

// Produit réclamé, vu depuis la page Réclamations
export interface ProduitReclame {
  id: number;
  reception_id: number;
  type: TypeProduit;
  taille_bobine: TailleBobine | null;
  type_cosse?: TypeCosse | null;
  reference: string;
  lot: string;
  quantite_annoncee: number;
  quantite: number;
  motif: MotifReclamation;
  commentaire: string | null;
  date_reclamation: string;
  par: string | null;
  statut: StatutReclamation;
  solution: SolutionReclamation | null;
  note_suivi: string | null;
  date_envoi: string | null;
  date_reglement: string | null;
  date_suivi: string | null;
  suivi_par: string | null;
  age_jours: number;
  en_retard: boolean;
}

export interface ImportReclame {
  import_id: number;
  statut: 'en_attente' | 'ajoute';
  numero_livraison: string | null;
  date_import: string;
  date_ajout_stock: string | null;
  produits: ProduitReclame[];
}

export interface FiltresReclamations {
  statut?: string;
  reference?: string;
  motif?: string;
  du?: string;
  au?: string;
  import?: number;
}

// Produit d'un import (bobine, cosse ou connecteur).
// Connecteur : une ligne = un carton (quantité 1) avec ses dimensions et son poids ;
// à la saisie, on envoie la liste des cartons.
// Emplacement imposé d'un colis (rangement mobile)
export interface AffectationColis {
  id: number;
  colis: number;
  emplacement: string;
  range: boolean; // rangé à cet emplacement, donc au stock
  palette?: number | null; // palette de réception (bobines reçues palette par palette)
}

export interface ProduitImport {
  id?: number;
  affectations?: AffectationColis[];
  type: TypeProduit | null;
  taille_bobine: TailleBobine | null;
  type_cosse?: TypeCosse | null; // obligatoire pour une bobine
  reference: string;
  lot: string;
  quantite: number | null;
  longueur?: number | null;
  largeur?: number | null;
  hauteur?: number | null;
  poids?: number | null;
  cartons?: Carton[]; // saisie des connecteurs
  commentaire?: string | null; // facultatif
  reclamation?: Reclamation | null; // anomalie constatée à la réception
  // Réception mobile : produits scannés (reçus), en trop, rangés
  recus?: number;
  en_trop?: number;
  ranges?: number;
  // numéros des colis (ticket fournisseur) : distinguent les produits de même référence et même lot
  colis_recus?: number[];
  colis_en_trop?: number[];
  colis_ranges?: number[];
}

// Étape d'un import, partagée avec le mobile
export type EtapeImport = 'en_attente' | 'reception_en_cours' | 'receptionne' | 'a_valider' | 'ajoute' | 'range';
export const ETAPES_IMPORT: Record<EtapeImport, string> = {
  en_attente: 'En attente',
  reception_en_cours: 'Réception en cours',
  receptionne: 'Réceptionné',
  a_valider: 'À valider',
  ajoute: 'En rangement',
  range: 'Rangé',
};
export interface AnomalieReception {
  type: 'manquant' | 'en_trop' | 'hors_import';
  reception_id?: number;
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
  ranges: number;
  anomalies: AnomalieReception[];
}

export type StatutImport = 'en_attente' | 'ajoute';

// Import = un arrivage (ex. depuis l'Italie) qui regroupe plusieurs produits
export interface ImportArrivage {
  id: number;
  source_id: number | null; // import de la base de l'Italie
  numero_livraison: string | null;
  date_envoi: string | null;
  statut: StatutImport;
  date_creation: string;
  date_ajout_stock: string | null; // date de réception = date de l'ajout au stock
  cree_par: string | null;
  ajoute_par: string | null;
  produits: ProduitImport[];
  // Ordre d'arrivée : on termine l'import le plus ancien avant de passer au suivant
  ordre_attente: number | null; // 1 = le prochain à ajouter au stock
  bloque_par: { id: number; numero_livraison: string | null; arrivee: string } | null; // import plus ancien à terminer d'abord
  // Réception physique sur le mobile
  reception: 'non_commencee' | 'en_cours' | 'terminee';
  reception_debut: string | null;
  reception_fin: string | null;
  reception_par: string | null;
  reception_ecarts: number;
  ajout_force: boolean; // ajouté au stock sans réception mobile (secours)
  motif_force: string | null;
  etape: EtapeImport;
  avancement: AvancementReception | null;
}

// Proposition de rangement d'un produit (calculée par le serveur)
export interface PlacementPropose {
  id: number;
  emplacement: string | null; // code (ex. D011), place tampon (T05), ou null si aucune place
  quantite: number; // nombre de produits de la ligne placés à cet emplacement
  regle: number;
  motif: string;
  produit: ProduitImport;
}

// Ligne de stock : quantité d'une ligne d'import à un emplacement (une ligne de quantité N =
// N produits identiques, éventuellement répartis sur plusieurs emplacements).
// Classée par référence puis en ordre FIFO.
export interface LigneStock {
  id: number; // identifiant du (premier) placement
  ids: number[]; // placements regroupés : produits identiques (réf., lot, date) au même emplacement
  reception_id: number; // ligne de l'import
  reference: string;
  type: TypeProduit;
  taille_bobine: TailleBobine | null;
  type_cosse?: TypeCosse | null;
  lot: string;
  quantite: number;
  emplacement: string | null; // affecté dans Gestion de stock (ex. C215)
  date_reception: string;
  // Connecteurs : dimensions d'un carton (cm) et poids (kg) ; totaux de la ligne regroupée
  longueur?: number | null;
  largeur?: number | null;
  hauteur?: number | null;
  poids?: number | null;
  volume?: number | null; // cm³
  poids_total?: number | null; // kg
}

// "Bobine · Grande", "Cosse"…
// Destinations possibles d'une sortie vers la production (obligatoire)
export const DESTINATIONS_EXPORT = ['P1', 'P2', 'P3', 'CET', 'MCW'] as const;
export type DestinationExport = (typeof DESTINATIONS_EXPORT)[number];

// Un prélèvement FIFO d'une sortie : quelle quantité de quel lot, à quel emplacement
export interface Prelevement {
  lot: string;
  date_reception: string;
  emplacement: string | null;
  quantite: number;
  place_liberee?: boolean; // l'emplacement est vide après la sortie
}

// Un lot disponible pour une sortie choisie par l'administrateur (sans FIFO), dans l'ordre du FIFO
export interface LotDisponible {
  ids: number[]; // placements regroupés (même lot, même date, même emplacement)
  lot: string;
  date_reception: string;
  emplacement: string | null;
  quantite: number;
}

export interface ApercuExport {
  reference: string;
  quantite: number;
  disponible: number;
  prelevements: Prelevement[];
}

// Une sortie vers la production (historique de la page Export)
export interface ExportProduction {
  id: number;
  date_export: string;
  reference: string;
  type: TypeProduit;
  taille_bobine: TailleBobine | null;
  type_cosse?: TypeCosse | null;
  quantite: number;
  destination: string | null;
  utilisateur: string | null;
  details: Prelevement[];
  origine: 'web' | 'mobile' | 'web_secours';
  motif_force: string | null;
  hors_fifo?: number; // 1 : l'administrateur a sorti un autre produit que celui proposé par le FIFO
}

export function libelleProduit(r: { type: TypeProduit | null; taille_bobine: TailleBobine | null; type_cosse?: TypeCosse | null }): string {
  const type = TYPES_PRODUIT.find((t) => t.valeur === r.type)?.libelle ?? '';
  const taille = TAILLES_BOBINE.find((t) => t.valeur === r.taille_bobine)?.libelle;
  if (r.type === 'cosse' && r.type_cosse) return `${type} · ${r.type_cosse === 'axiale' ? 'axiale' : 'plate'}`;
  return taille ? `${type} · ${taille}` : type;
}

// Cosses : axiale (petite, 4 par palette) ou plate (10 par palette)
export type TypeCosse = 'axiale' | 'plat';

// 2300 → "2 300", comme dans l'outil actuel du magasin
export function formatNombre(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('fr-FR');
}

@Injectable({ providedIn: 'root' })
export class ReceptionService {
  private http = inject(HttpClient);
  private api = 'http://localhost:3000/api';

  // ---------- Imports ----------
  // Synchronisation avec la base de l'Italie : copie les nouveaux imports (en attente)
  synchroniser(): Observable<{ ajoutes: { id: number; numero: string; produits: number }[]; ignores: { numero: string; raison: string }[] }> {
    return this.http.post<{ ajoutes: { id: number; numero: string; produits: number }[]; ignores: { numero: string; raison: string }[] }>(
      `${this.api}/imports/synchroniser`,
      {}
    );
  }

  getSynchronisation(): Observable<{ disponibles: number; derniere_synchronisation: string | null }> {
    return this.http.get<{ disponibles: number; derniere_synchronisation: string | null }>(`${this.api}/imports/synchronisation`);
  }

  getImports(): Observable<ImportArrivage[]> {
    return this.http.get<ImportArrivage[]>(`${this.api}/imports`);
  }

  // Import saisi à la main par l'administrateur (essais) : type d'après le catalogue Articles
  creerImportManuel(
    numero: string,
    produits: { reference: string; lot: string; quantite: number | null; longueur?: number | null; largeur?: number | null; hauteur?: number | null; poids?: number | null }[]
  ): Observable<{ id: number; numero: string; produits: number }> {
    return this.http.post<{ id: number; numero: string; produits: number }>(`${this.api}/imports/manuel`, { numero, produits });
  }

  creerImport(): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.api}/imports`, {});
  }

  supprimerImport(id: number): Observable<void> {
    return this.http.delete<void>(`${this.api}/imports/${id}`);
  }

  ajouterProduit(importId: number, produit: ProduitImport): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.api}/imports/${importId}/produits`, produit);
  }

  retirerProduit(importId: number, produitId: number): Observable<void> {
    return this.http.delete<void>(`${this.api}/imports/${importId}/produits/${produitId}`);
  }

  getPlanRangement(importId: number): Observable<PlacementPropose[]> {
    return this.http.get<PlacementPropose[]>(`${this.api}/imports/${importId}/plan-rangement`);
  }

  // Ajoute l'import au stock et range ses produits selon les placements (vérifiés par le serveur)
  // motif : obligatoire si le plan proposé par le système a été modifié
  // motifForce : ajout sans réception mobile (secours, administrateur et chef), motif obligatoire
  ajouterAuStock(
    importId: number,
    placements?: { id: number; emplacement: string; quantite: number }[],
    motif?: MotifChangement,
    motifForce?: string
  ): Observable<{ id: number; produits: number; enTampon: number; secours: boolean; a_ranger: number; ajoutes_automatiquement: number[] }> {
    return this.http.post<{ id: number; produits: number; enTampon: number; secours: boolean; a_ranger: number; ajoutes_automatiquement: number[] }>(
      `${this.api}/imports/${importId}/ajouter-au-stock`,
      {
        placements,
        motif: motif?.motif || undefined,
        commentaire: motif?.commentaire.trim() || undefined,
        ...(motifForce ? { force: true, motif_force: motifForce } : {}),
      }
    );
  }

  // ---------- Stock ----------
  getStock(): Observable<LigneStock[]> {
    return this.http.get<LigneStock[]>(`${this.api}/stock`);
  }

  // Le chef change l'emplacement imposé d'un colis pas encore rangé (motif obligatoire)
  changerAffectation(id: number, emplacement: string, motif: MotifChangement): Observable<{ id: number; colis: number; depuis: string; emplacement: string }> {
    return this.http.put<{ id: number; colis: number; depuis: string; emplacement: string }>(`${this.api}/imports/affectations/${id}`, {
      emplacement,
      motif: motif.motif || undefined,
      commentaire: motif.commentaire.trim() || undefined,
    });
  }

  // ---------- Exports (sorties vers la production, FIFO imposé par le serveur) ----------
  getExports(): Observable<ExportProduction[]> {
    return this.http.get<ExportProduction[]>(`${this.api}/exports`);
  }

  apercuExport(reference: string, quantite: number): Observable<ApercuExport> {
    return this.http.get<ApercuExport>(`${this.api}/exports/apercu`, { params: { reference, quantite } });
  }

  exporter(
    reference: string,
    quantite: number,
    destination: DestinationExport,
    motifForce: string
  ): Observable<{ id: number; quantite: number; placesLiberees: string[]; prelevements: Prelevement[] }> {
    return this.http.post<{ id: number; quantite: number; placesLiberees: string[]; prelevements: Prelevement[] }>(
      `${this.api}/exports`,
      // Sortie de secours du chef : la sortie normale passe par l'application mobile
      { reference, quantite, destination, force: true, motif_force: motifForce }
    );
  }

  // Administrateur : tous les lots disponibles d'une référence, pour choisir ce qu'il sort (sans FIFO)
  lotsDisponibles(reference: string): Observable<{ reference: string; disponible: number; lignes: LotDisponible[] }> {
    return this.http.get<{ reference: string; disponible: number; lignes: LotDisponible[] }>(`${this.api}/exports/disponible`, {
      params: { reference },
    });
  }

  exporterChoix(
    reference: string,
    choix: { ids: number[]; quantite: number }[],
    destination: DestinationExport,
    motifForce: string
  ): Observable<{ id: number; quantite: number; hors_fifo: boolean; placesLiberees: string[]; prelevements: Prelevement[] }> {
    return this.http.post<{ id: number; quantite: number; hors_fifo: boolean; placesLiberees: string[]; prelevements: Prelevement[] }>(
      `${this.api}/exports`,
      { reference, choix, destination, force: true, motif_force: motifForce }
    );
  }

  // ---------- Paramètres ----------
  getTableauDeBord(): Observable<TableauDeBord> {
    return this.http.get<TableauDeBord>(`${this.api}/tableau-de-bord`);
  }

  // ---------- Réclamations ----------
  reclamer(importId: number, produitId: number, r: Reclamation): Observable<unknown> {
    return this.http.put(`${this.api}/imports/${importId}/produits/${produitId}/reclamation`, r);
  }

  annulerReclamation(importId: number, produitId: number): Observable<unknown> {
    return this.http.delete(`${this.api}/imports/${importId}/produits/${produitId}/reclamation`);
  }

  suivreReclamation(id: number, suivi: { statut: StatutReclamation; solution?: SolutionReclamation | null; note?: string | null }): Observable<unknown> {
    return this.http.put(`${this.api}/reclamations/${id}/suivi`, suivi);
  }

  getCompteursReclamations(): Observable<CompteursReclamations> {
    return this.http.get<CompteursReclamations>(`${this.api}/reclamations/compteurs`);
  }

  setDelaiReclamation(delai_jours: number): Observable<{ reclamation_delai_jours: number }> {
    return this.http.put<{ reclamation_delai_jours: number }>(`${this.api}/parametres/reclamations`, { delai_jours });
  }

  getReclamations(filtres: FiltresReclamations): Observable<ImportReclame[]> {
    return this.http.get<ImportReclame[]>(`${this.api}/reclamations`, { params: nettoyer(filtres) });
  }

  // Fichier PDF ou Excel des réclamations (mêmes filtres que la page),
  // ou brouillon de mail Outlook (.eml) d'un import avec le PDF en pièce jointe
  // ---------- Journal des alertes du mobile (administrateur, chef de magasin) ----------
  getJournal(filtres: FiltresJournal): Observable<LigneJournal[]> {
    return this.http.get<LigneJournal[]>(`${this.api}/journal`, { params: nettoyer(filtres) });
  }

  getResumeJournal(filtres: FiltresJournal): Observable<ResumeJournal> {
    return this.http.get<ResumeJournal>(`${this.api}/journal/resume`, { params: nettoyer(filtres) });
  }

  getUtilisateursJournal(): Observable<{ id: number; matricule: string; nom: string; role: string }[]> {
    return this.http.get<{ id: number; matricule: string; nom: string; role: string }[]>(`${this.api}/journal/utilisateurs`);
  }

  telechargerJournal(format: 'pdf' | 'excel', filtres: FiltresJournal): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.api}/journal/${format}`, { params: nettoyer(filtres), responseType: 'blob', observe: 'response' });
  }

  telechargerReclamations(format: 'pdf' | 'excel' | 'mail', filtres: FiltresReclamations): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.api}/reclamations/${format}`, {
      params: nettoyer(filtres),
      responseType: 'blob',
      observe: 'response',
    });
  }

  getParametres(): Observable<Parametres> {
    return this.http.get<Parametres>(`${this.api}/parametres`);
  }

  setLimitesConnecteurs(limites: LimitesConnecteurs): Observable<{ connecteurs: LimitesConnecteurs }> {
    return this.http.put<{ connecteurs: LimitesConnecteurs }>(`${this.api}/parametres/connecteurs`, limites);
  }

  // Étiquettes QR des places de la zone tampon (de T{de} à T{a}), en PDF
  telechargerEtiquettesTampon(de: number, a: number): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.api}/parametres/tampon/etiquettes`, { params: { de, a }, responseType: 'blob', observe: 'response' });
  }

  setCapaciteTampon(capacite: number): Observable<{ tampon_capacite: number }> {
    return this.http.put<{ tampon_capacite: number }>(`${this.api}/parametres/tampon`, { capacite });
  }

  // « Ranger le magasin » : suivi des déplacements faits librement par les magasiniers sur le mobile
  getSuiviRanger(filtres: FiltresRanger): Observable<SuiviRanger> {
    return this.http.get<SuiviRanger>(`${this.api}/ranger`, { params: nettoyer(filtres) });
  }

  rangerAutomatiquement(): Observable<{ ranges: number; enTampon: number; sansPlace: number }> {
    return this.http.post<{ ranges: number; enTampon: number; sansPlace: number }>(
      `${this.api}/stock/ranger-automatiquement`,
      {}
    );
  }

  // Changement d'emplacement (administrateur, chef de magasin) : motif obligatoire, enregistré dans l'historique
  affecterEmplacement(
    id: number,
    emplacement: string | null,
    ids: number[],
    motif: MotifChangement
  ): Observable<{ id: number; emplacement: string | null }> {
    return this.http.put<{ id: number; emplacement: string | null }>(`${this.api}/stock/${id}/emplacement`, {
      emplacement,
      ids,
      motif: motif.motif,
      commentaire: motif.commentaire.trim() || null,
    });
  }

  // Compare le stock du magasin à la base (lecture seule)
  verifierStock(): Observable<VerificationStock> {
    return this.http.get<VerificationStock>(`${this.api}/stock/verification`);
  }

  getHistoriqueEmplacements(filtres: { reference?: string; emplacement?: string; origine?: string; par?: string; du?: string; au?: string }): Observable<MouvementEmplacement[]> {
    return this.http.get<MouvementEmplacement[]>(`${this.api}/stock/historique`, { params: nettoyer(filtres) });
  }

  // Tout l'historique des emplacements (mêmes filtres) en PDF ou en Excel
  telechargerHistoriqueEmplacements(
    format: 'pdf' | 'excel',
    filtres: { reference?: string; emplacement?: string; origine?: string; par?: string; du?: string; au?: string },
  ): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.api}/stock/historique/${format}`, {
      params: nettoyer(filtres),
      responseType: 'blob',
      observe: 'response',
    });
  }
}

// ---------- Historique des changements d'emplacement ----------
export type MotifDeplacement = 'palette_abimee' | 'regroupement' | 'rapprocher_porte' | 'erreur_rangement' | 'emplacement_bloque' | 'autre';
export const MOTIFS_DEPLACEMENT: { valeur: MotifDeplacement; libelle: string }[] = [
  { valeur: 'palette_abimee', libelle: 'Palette abîmée' },
  { valeur: 'regroupement', libelle: 'Regroupement / gain de place' },
  { valeur: 'rapprocher_porte', libelle: 'Rapprocher de la porte' },
  { valeur: 'erreur_rangement', libelle: "Correction d'une erreur de rangement" },
  { valeur: 'emplacement_bloque', libelle: 'Emplacement bloqué ou en réparation' },
  { valeur: 'autre', libelle: 'Autre (préciser)' },
];
export interface MotifChangement {
  motif: MotifDeplacement | '';
  commentaire: string;
}
export type OrigineMouvement = 'deplacement' | 'plan_import' | 'automatique' | 'regroupement' | 'inventaire';
export const ORIGINES_MOUVEMENT: Record<OrigineMouvement, string> = {
  deplacement: 'Déplacement',
  plan_import: "Plan d'import modifié",
  regroupement: 'Ranger le magasin',
  inventaire: 'Inventaire',
  automatique: 'Automatique',
};
// « Ranger le magasin » : les magasiniers rangent librement sur le mobile (sans suggestion du système) ;
// chaque déplacement est contrôlé et historisé avec le matricule
export interface FiltresRanger {
  du?: string; // AAAA-MM-JJ
  au?: string;
  par?: string; // matricule
  reference?: string;
  emplacement?: string; // départ ou arrivée
}
interface Personne {
  matricule: string | null; // null : compte supprimé depuis
  nom: string | null;
  prenom: string | null;
  role?: string | null;
}
export interface PersonneRanger extends Personne {
  matricule: string;
  utilisateur_id: number;
  deplacements: number;
  produits: number;
  liberes: number;
  refus: number;
  dernier: string | null;
}
export interface MouvementRanger extends Personne {
  id: number;
  date: string;
  reference: string;
  lot: string;
  type: TypeProduit;
  taille_bobine: TailleBobine | null;
  type_cosse?: TypeCosse | null;
  quantite: number;
  colis: number | null;
  depuis: string;
  vers: string;
  depuis_liberee: boolean;
  commentaire: string | null;
}
export interface RefusRanger extends Personne {
  id: number;
  date: string;
  resultat: string;
  reference: string | null;
  lot: string | null;
  depuis: string | null;
  vers: string | null;
  message: string;
}
export interface SuiviRanger {
  resume: { deplacements: number; produits: number; liberes: number; refus: number; personnes: number };
  par_personne: PersonneRanger[];
  mouvements: MouvementRanger[];
  refus: RefusRanger[];
  utilisateurs: Personne[];
}

export interface MouvementEmplacement {
  id: number;
  date: string;
  origine: OrigineMouvement;
  reference: string;
  lot: string;
  type: TypeProduit;
  taille_bobine: TailleBobine | null;
  type_cosse?: TypeCosse | null;
  quantite: number;
  colis?: number | null;
  depuis: string | null;
  vers: string | null;
  depuis_liberee?: boolean;
  motif: MotifDeplacement | null;
  motif_libelle: string | null;
  commentaire: string | null;
  par: string | null;
  role: string | null;
  nom?: string | null;
  prenom?: string | null;
}

// ---------- Synchronisation : contrôle du stock ----------
export type StatutControle = 'ok' | 'alerte' | 'erreur';
export interface ControleStock {
  cle: string;
  titre: string;
  statut: StatutControle;
  message: string;
  details: string[];
  total_details: number;
}
export interface VerificationStock {
  date: string;
  statut: StatutControle;
  resume: { produits: number; references: number; palettes: number; erreurs: number; alertes: number };
  controles: ControleStock[];
}

// Retire les filtres vides avant l'envoi
function nettoyer(filtres: object): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [cle, valeur] of Object.entries(filtres)) {
    if (valeur !== undefined && valeur !== null && String(valeur).trim() !== '') params[cle] = String(valeur).trim();
  }
  return params;
}

// ---------- Tableau de bord (administrateur et chef de magasin) ----------
export interface ZoneRemplissage {
  cle: 'bobines' | 'cosses' | 'connecteurs' | 'tampon';
  libelle: string;
  detail: string;
  total: number;
  libres: number;
  partiels: number;
  pleins: number;
  places_occupees: number;
  produits: number;
  taux: number; // % de la capacité utilisée
}

export interface AlerteTableau {
  niveau: 'critique' | 'attention' | 'info';
  message: string;
  lien: string;
}

export interface ChiffresActivite {
  imports: number;
  entres: number;
  sorties: number;
  sortis: number;
}

export interface TableauDeBord {
  remplissage: ZoneRemplissage[];
  alertes: AlerteTableau[];
  imports_en_attente: number;
  activite: {
    aujourdhui: ChiffresActivite;
    semaine: ChiffresActivite;
    jours: { jour: string; entres: number; sortis: number }[];
    destinations: { destination: string; sorties: number; quantite: number }[];
  };
  reclamations: {
    par_motif: { motif: MotifReclamation; produits: number; quantite: number }[];
    suivi: { ouvertes: number; envoyees: number; reglees: number; en_retard: number; delai_jours: number };
    dernieres: { id: number; import_id: number; reference: string; lot: string; type: TypeProduit; quantite: number; motif: MotifReclamation; date: string }[];
  };
}

// ---------- Journal des alertes du mobile ----------
export interface FiltresJournal {
  du?: string;
  au?: string;
  utilisateur?: string;
  reference?: string;
  controle?: string; // reception | rangement | export | ranger
  resultat?: string;
  niveau?: string; // alertes (défaut) | tout
  manuel?: string; // 1 = saisies manuelles
}

export interface LigneJournal {
  id: number;
  controle: 'reception' | 'rangement' | 'export' | 'ranger';
  controle_libelle: string;
  resultat: string;
  titre: string;
  couleur: 'vert' | 'orange' | 'rouge';
  reference: string | null;
  lot: string | null;
  colis: number | null;
  quantite_ticket: number | null;
  quantite_attendue: number | null;
  ecart: number | null;
  emplacement_prevu: string | null;
  emplacement_scanne: string | null;
  saisie_manuelle: boolean;
  message: string;
  date: string;
  import_id: number | null;
  numero_livraison: string | null;
  preparation_id: number | null;
  destination: string | null;
  utilisateur_id: number | null;
  matricule: string | null;
  par: string | null;
  role: string | null;
}

export interface ResumeJournal {
  total: number;
  alertes: number;
  manuels: number;
  par_resultat: { resultat: string; titre: string; couleur: string; n: number; alerte: boolean }[];
  par_magasinier: { id: number; matricule: string; nom: string; controles: number; alertes: number; manuels: number; taux_alertes: number }[];
}

export const RESULTATS_ALERTE: { valeur: string; libelle: string }[] = [
  { valeur: 'faux_emplacement', libelle: "Ce n'est pas son emplacement" },
  { valeur: 'mauvais_produit', libelle: 'Mauvais produit / lot non FIFO' },
  { valeur: 'ecart_quantite', libelle: 'Écart de quantité / colis en trop' },
  { valeur: 'inconnu', libelle: 'Produit inconnu / hors import' },
  { valeur: 'stock_modifie', libelle: 'Stock modifié : sortie refusée' },
  { valeur: 'deplacement_refuse', libelle: 'Ranger le magasin : déplacement refusé' },
];
