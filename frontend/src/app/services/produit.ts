import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface Produit {
  id?: number;
  reference?: string | null;
  nom: string;
  description?: string;
  unite: string;
  seuil_min: number;
  prix: number;
  quantite?: number; // total tous emplacements, calculé par les mouvements
  categorie_id?: number | null;
  categorie?: string;
  emplacements?: { code: string; quantite: number }[];
}

export interface Categorie {
  id: number;
  nom: string;
}

export const UNITES = ['pièce', 'm', 'bobine', 'rouleau', 'boîte', 'kg'];

@Injectable({ providedIn: 'root' })
export class ProduitService {
  private http = inject(HttpClient);
  private apiUrl = 'http://localhost:3000/api';

  getProduits(): Observable<Produit[]> {
    return this.http.get<Produit[]>(`${this.apiUrl}/produits`);
  }

  ajouterProduit(produit: Produit): Observable<Produit> {
    return this.http.post<Produit>(`${this.apiUrl}/produits`, produit);
  }

  modifierProduit(id: number, produit: Produit): Observable<Produit> {
    return this.http.put<Produit>(`${this.apiUrl}/produits/${id}`, produit);
  }

  supprimerProduit(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/produits/${id}`);
  }

  getCategories(): Observable<Categorie[]> {
    return this.http.get<Categorie[]>(`${this.apiUrl}/categories`);
  }
}
