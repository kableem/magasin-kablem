import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type Role = 'admin' | 'chef_magasin' | 'magasinier' | 'planificateur';

export interface Utilisateur {
  id?: number;
  matricule: string;
  nom: string;
  prenom: string;
  role: Role;
  actif: boolean | number;
  motDePasse?: string;
  derniere_connexion?: string | null;
  created_at?: string;
}

export const LIBELLES_ROLES: Record<Role, string> = {
  admin: 'Administrateur',
  chef_magasin: 'Chef de magasin',
  magasinier: 'Magasinier',
  planificateur: 'Planificateur',
};

@Injectable({ providedIn: 'root' })
export class UtilisateurService {
  private http = inject(HttpClient);
  private apiUrl = 'http://localhost:3000/api/utilisateurs';

  getUtilisateurs(): Observable<Utilisateur[]> {
    return this.http.get<Utilisateur[]>(this.apiUrl);
  }

  ajouter(utilisateur: Utilisateur): Observable<Utilisateur> {
    return this.http.post<Utilisateur>(this.apiUrl, utilisateur);
  }

  modifier(id: number, utilisateur: Utilisateur): Observable<Utilisateur> {
    return this.http.put<Utilisateur>(`${this.apiUrl}/${id}`, utilisateur);
  }

  supprimer(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }
}
