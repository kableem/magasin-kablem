import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, tap, throwError } from 'rxjs';
import { api } from './config';
import { Session } from './modeles';

// Même connexion que l'application web : matricule + mot de passe -> jeton JWT
const CLE_SESSION = 'kablem_mobile_session';
// Dernière action (appel au serveur : scan, écran ouvert) : 30 minutes sans action = déconnecté (comme le serveur)
const CLE_ACTION = 'kablem_mobile_derniere_action';
const INACTIVITE_MS = 30 * 60 * 1000;
const MESSAGE_INACTIF = 'Déconnecté après 30 minutes sans action : reconnectez-vous.';
const derniereAction = () => Number(localStorage.getItem(CLE_ACTION)) || 0;

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  // Message affiché sur l'écran de connexion après une déconnexion forcée (session fermée par le serveur)
  readonly motif = signal('');
  readonly session = signal<Session | null>(this.lire());

  constructor() {
    // L'écran de connexion revient tout seul après 30 minutes sans action, sans attendre le prochain scan
    setInterval(() => {
      if (this.session() && Date.now() - derniereAction() > INACTIVITE_MS) this.sessionFermee(MESSAGE_INACTIF);
    }, 30 * 1000);
  }

  // Chaque appel au serveur compte comme une action
  action(): void {
    localStorage.setItem(CLE_ACTION, String(Date.now()));
  }

  // appareil 'mobile' : un seul téléphone à la fois par compte (refusé si le compte est déjà connecté sur un téléphone)
  connexion(matricule: string, motDePasse: string) {
    return this.http.post<Session>(api('/auth/login'), { matricule, motDePasse, appareil: 'mobile' }).pipe(
      tap((s) => {
        localStorage.setItem(CLE_SESSION, JSON.stringify(s));
        this.action();
        this.motif.set('');
        this.session.set(s);
      })
    );
  }

  // « Se déconnecter » : le compte est libéré tout de suite sur le serveur
  deconnexion(): void {
    const token = this.session()?.token;
    if (token) {
      this.http.post(api('/auth/deconnexion'), {}, { headers: { Authorization: `Bearer ${token}` } }).subscribe({ error: () => {} });
    }
    this.fermerLocalement();
  }

  // Session fermée par le serveur (compte libéré, ou expirée) : retour à la connexion, avec le message
  sessionFermee(message: string): void {
    this.motif.set(message);
    this.fermerLocalement();
  }

  private fermerLocalement(): void {
    localStorage.removeItem(CLE_SESSION);
    this.session.set(null);
    this.router.navigateByUrl('/connexion', { replaceUrl: true });
  }

  private lire(): Session | null {
    try {
      const s: Session = JSON.parse(localStorage.getItem(CLE_SESSION) ?? 'null');
      if (!s?.token) return null;
      // 30 minutes sans action (application fermée entre-temps) : déconnecté
      if (Date.now() - derniereAction() > INACTIVITE_MS) {
        this.motif.set(MESSAGE_INACTIF);
        return null;
      }
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
  if (token) auth.action();
  return next(requete).pipe(
    catchError((err: HttpErrorResponse) => {
      // session fermée (compte libéré, ouvert ailleurs) ou expirée : retour à la connexion avec le message
      if (err.status === 401 && token && auth.session()?.token === token) auth.sessionFermee(err.error?.message ?? 'Session expirée : reconnectez-vous.');
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
