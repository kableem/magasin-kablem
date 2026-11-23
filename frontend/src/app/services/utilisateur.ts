import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type Role = 'admin' | 'chef_magasin' | 'magasinier';

export interface Utilisateur {
  id?: number;
  matricule: string;
  nom: string;
  prenom: string;
  role: Role;
  actif: boolean | number;
  motDePasse?: string;
  derniere_connexion?: string | null;
  en_ligne_mobile?: number | boolean; // connecté en ce moment sur un téléphone (un seul à la fois)
  created_at?: string;
}

export const LIBELLES_ROLES: Record<Role, string> = {
  admin: 'Administrateur',
  chef_magasin: 'Chef de magasin',
  magasinier: 'Magasinier',
};

@Injectable({ providedIn: 'root' })
export class UtilisateurService {
  private http = inject(HttpClient);
  private apiUrl = '/api/utilisateurs';

  getUtilisateurs(): Observable<Utilisateur[]> {
    return this.http.get<Utilisateur[]>(this.apiUrl);
  }

  ajouter(utilisateur: Utilisateur): Observable<Utilisateur> {
    return this.http.post<Utilisateur>(this.apiUrl, utilisateur);
  }

  // Téléphone perdu ou déchargé : le compte peut se reconnecter tout de suite sur un autre téléphone
  libererMobile(id: number): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.apiUrl}/${id}/liberer-mobile`, {});
  }

  modifier(id: number, utilisateur: Utilisateur): Observable<Utilisateur> {
    return this.http.put<Utilisateur>(`${this.apiUrl}/${id}`, utilisateur);
  }

  supprimer(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }
}
