import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, tap, throwError } from 'rxjs';
import { api } from './config';
import { Session } from './modeles';

// Même connexion que l'application web : matricule + mot de passe -> jeton JWT
const CLE_SESSION = 'kablem_mobile_session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  readonly session = signal<Session | null>(this.lire());

  connexion(matricule: string, motDePasse: string) {
    return this.http.post<Session>(api('/auth/login'), { matricule, motDePasse }).pipe(
      // Le planificateur ne gère que les articles, sur le web : pas d'accès à l'application mobile
      map((s) => {
        if (s.utilisateur?.role === 'planificateur') {
          throw new HttpErrorResponse({ status: 403, error: { message: "Le planificateur n'a pas accès à l'application mobile : utilisez le site web (Articles)." } });
        }
        return s;
      }),
      tap((s) => {
        localStorage.setItem(CLE_SESSION, JSON.stringify(s));
        this.session.set(s);
      })
    );
  }

  deconnexion(): void {
    localStorage.removeItem(CLE_SESSION);
    this.session.set(null);
    this.router.navigateByUrl('/connexion', { replaceUrl: true });
  }

  private lire(): Session | null {
    try {
      const s: Session = JSON.parse(localStorage.getItem(CLE_SESSION) ?? 'null');
      if (!s?.token) return null;
      // Jeton expiré : on ne garde pas la session
      const { exp } = JSON.parse(atob(s.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return exp * 1000 > Date.now() ? s : null;
    } catch {
      return null;
    }
  }
}

// Ajoute le jeton à chaque appel de l'API ; session expirée -> retour à la connexion
export const jetonInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const token = auth.session()?.token;
  const requete = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(requete).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401 && token) auth.deconnexion();
      return throwError(() => err);
    })
  );
};

// Pas connecté : connexion, puis retour à la page demandée (ex. lien d'une étiquette /e/D011)
export const connecteGuard: CanActivateFn = (_route, etat) => {
  const auth = inject(AuthService);
  if (auth.session()) return true;
  return inject(Router).createUrlTree(['/connexion'], { queryParams: etat.url && etat.url !== '/' ? { retour: etat.url } : {} });
};
