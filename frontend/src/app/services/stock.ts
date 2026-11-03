import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type TypeMouvement = 'import' | 'export';

export interface ArticleEmplacement {
  produit_id: number;
  reference: string | null;
  nom: string;
  unite: string;
  quantite: number;
}

export interface Emplacement {
  id?: number;
  code: string;
  zone: string;
  description?: string | null;
  capacite?: number | null;
  total?: number;
  nb_articles?: number;
  articles?: ArticleEmplacement[];
}

export interface Mouvement {
  id?: number;
  type: TypeMouvement;
  produit_id: number | null;
  emplacement_id: number | null;
  quantite: number | null;
  document?: string;
  tiers?: string;
  lot?: string;
  commentaire?: string;
  // champs renvoyés par l'API
  reference?: string | null;
  produit?: string;
  unite?: string;
  emplacement?: string;
  utilisateur?: string | null;
  created_at?: string;
}

@Injectable({ providedIn: 'root' })
export class StockService {
  private http = inject(HttpClient);
  private apiUrl = 'http://localhost:3000/api';

  getEmplacements(): Observable<Emplacement[]> {
    return this.http.get<Emplacement[]>(`${this.apiUrl}/emplacements`);
  }

  ajouterEmplacement(e: Emplacement): Observable<Emplacement> {
    return this.http.post<Emplacement>(`${this.apiUrl}/emplacements`, e);
  }

  modifierEmplacement(id: number, e: Emplacement): Observable<Emplacement> {
    return this.http.put<Emplacement>(`${this.apiUrl}/emplacements/${id}`, e);
  }

  supprimerEmplacement(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/emplacements/${id}`);
  }

  getMouvements(type: TypeMouvement): Observable<Mouvement[]> {
    return this.http.get<Mouvement[]>(`${this.apiUrl}/mouvements`, { params: { type } });
  }

  enregistrerMouvement(m: Mouvement): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.apiUrl}/mouvements`, m);
  }
}
