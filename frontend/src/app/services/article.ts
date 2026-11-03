import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

// Catalogue des articles du magasin (fichier « DESCRIPTION MP ») : bobines, cosses et familles de connecteurs
export type FamilleArticle = 'bobine' | 'cosse' | 'connecteur';

export interface Article {
  id: number;
  reference: string;
  famille: FamilleArticle;
  categorie: string; // BOBINE, COSSE, ou famille de connecteur (GCOR, NASTRO, COMPOSANT PLASTIQUE…)
  bobines_par_palette?: number | null; // bobines : 1 grande, 2 moyennes, 6 petites
  type_cosse?: TypeCosse | null; // cosses : axiale ou plat
  date_creation?: string;
}

// Type d'une cosse (fichier « Copie de cosses » du magasin)
export type TypeCosse = 'axiale' | 'plat';
export const TYPES_COSSE: { valeur: TypeCosse; libelle: string; pluriel: string }[] = [
  { valeur: 'axiale', libelle: 'Axiale', pluriel: 'Axiales' },
  { valeur: 'plat', libelle: 'Plat', pluriel: 'Plates' },
];

// Changement du catalogue (historique) : taille d'une bobine, ou type d'une cosse
export interface ChangementTaille {
  id: number;
  reference: string;
  famille: 'bobine' | 'cosse';
  avant: number | null; // bobines : bobines par palette
  apres: number | null;
  type_cosse_avant: TypeCosse | null; // cosses
  type_cosse_apres: TypeCosse | null;
  date: string;
  matricule: string | null;
  par: string | null;
}

export interface ResumeArticles {
  famille: FamilleArticle;
  categorie: string;
  n: number;
}

export const FAMILLES_ARTICLE: { valeur: FamilleArticle; libelle: string; pluriel: string }[] = [
  { valeur: 'bobine', libelle: 'Bobine', pluriel: 'Bobines' },
  { valeur: 'cosse', libelle: 'Cosse', pluriel: 'Cosses' },
  { valeur: 'connecteur', libelle: 'Connecteur', pluriel: 'Connecteurs' },
];

// Taille d'une bobine selon le nombre de bobines par palette : c'est la taille donnée aux prochains imports
export const TAILLES_PALETTE: { par: number; taille: 'petite' | 'moyenne' | 'grande'; libelle: string; pluriel: string }[] = [
  { par: 6, taille: 'petite', libelle: 'Petite', pluriel: 'Petites' },
  { par: 2, taille: 'moyenne', libelle: 'Moyenne', pluriel: 'Moyennes' },
  { par: 1, taille: 'grande', libelle: 'Grande', pluriel: 'Grandes' },
];
export const taillePalette = (par: number | null | undefined) => TAILLES_PALETTE.find((t) => t.par === (par ?? 6)) ?? TAILLES_PALETTE[0];

@Injectable({ providedIn: 'root' })
export class ArticleService {
  private http = inject(HttpClient);
  private apiUrl = 'http://localhost:3000/api/articles';

  getArticles(): Observable<Article[]> {
    return this.http.get<Article[]>(this.apiUrl);
  }

  getResume(): Observable<ResumeArticles[]> {
    return this.http.get<ResumeArticles[]>(`${this.apiUrl}/resume`);
  }

  ajouter(article: Omit<Article, 'id'>): Observable<Article> {
    return this.http.post<Article>(this.apiUrl, article);
  }

  modifier(id: number, article: Omit<Article, 'id'>): Observable<Article> {
    return this.http.put<Article>(`${this.apiUrl}/${id}`, article);
  }

  // Taille d'une bobine (bobines par palette) : vaut pour les prochains imports, notée dans l'historique
  changerTaille(id: number, bobinesParPalette: number): Observable<Article & { change: boolean; avant: number | null }> {
    return this.http.put<Article & { change: boolean; avant: number | null }>(`${this.apiUrl}/${id}/taille`, { bobines_par_palette: bobinesParPalette });
  }

  // Type d'une cosse (axiale : 3 par palette, plat : 10) : vaut pour les prochains imports, noté dans l'historique
  changerTypeCosse(id: number, type: TypeCosse): Observable<Article & { change: boolean; avant: TypeCosse | null }> {
    return this.http.put<Article & { change: boolean; avant: TypeCosse | null }>(`${this.apiUrl}/${id}/type-cosse`, { type_cosse: type });
  }

  getChangementsTaille(reference?: string): Observable<ChangementTaille[]> {
    return this.http.get<ChangementTaille[]>(`${this.apiUrl}/changements-taille`, { params: reference ? { reference } : {} });
  }

  supprimer(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }
}
