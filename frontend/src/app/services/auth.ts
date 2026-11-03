import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, tap } from 'rxjs';

export interface Utilisateur {
  id: number;
  matricule: string;
  nom: string;
  prenom: string;
  role: 'admin' | 'chef_magasin' | 'magasinier' | 'planificateur';
}

// Gèrent le magasin (emplacements, plan de rangement, paramètres) : administrateur et chef de magasin.
// Seul l'administrateur gère les utilisateurs.
// Planificateur : uniquement la gestion des articles
export function estPlanificateur(u: { role: string } | null | undefined): boolean {
  return u?.role === 'planificateur';
}

export function peutGererMagasin(u: { role: string } | null | undefined): boolean {
  return u?.role === 'admin' || u?.role === 'chef_magasin';
}

interface Session {
  token: string;
  utilisateur: Utilisateur;
}

const CLE_SESSION = 'kablem_session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private apiUrl = 'http://localhost:3000/api/auth';

  private session = signal<Session | null>(this.lireSession());
  readonly utilisateur = computed(() => this.session()?.utilisateur ?? null);
  readonly connecte = computed(() => this.session() !== null);

  get token(): string | null {
    return this.session()?.token ?? null;
  }

  login(matricule: string, motDePasse: string, seSouvenir: boolean): Observable<Session> {
    return this.http.post<Session>(`${this.apiUrl}/login`, { matricule, motDePasse }).pipe(
      tap((session) => {
        // "Se souvenir de moi" : localStorage, sinon la session se ferme avec le navigateur
        const stockage = seSouvenir ? localStorage : sessionStorage;
        stockage.setItem(CLE_SESSION, JSON.stringify(session));
        this.session.set(session);
      })
    );
  }

  logout(): void {
    localStorage.removeItem(CLE_SESSION);
    sessionStorage.removeItem(CLE_SESSION);
    this.session.set(null);
    this.router.navigate(['/login']);
  }

  private lireSession(): Session | null {
    try {
      const brut = localStorage.getItem(CLE_SESSION) ?? sessionStorage.getItem(CLE_SESSION);
      if (!brut) return null;
      const session: Session = JSON.parse(brut);
      return this.tokenExpire(session.token) ? null : session;
    } catch {
      return null;
    }
  }

  private tokenExpire(token: string): boolean {
    try {
      const { exp } = JSON.parse(atob(token.split('.')[1]));
      return exp * 1000 < Date.now();
    } catch {
      return true;
    }
  }
}
