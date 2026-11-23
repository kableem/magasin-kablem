import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService, peutGererMagasin } from '../services/auth';

// Pages protégées : redirige vers /login si l'utilisateur n'est pas connecté
export const authGuard: CanActivateFn = (route, state) => {
  const auth = inject(AuthService);
  if (auth.connecte()) return true;
  return inject(Router).createUrlTree(['/login'], { queryParams: { retour: state.url } });
};

// Page de login : inutile d'y revenir si l'utilisateur est déjà connecté
export const inviteGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.connecte() ? inject(Router).createUrlTree([pageAccueil(auth)]) : true;
};

// Pages d'administration : réservées au rôle admin
export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.utilisateur()?.role === 'admin' ? true : inject(Router).createUrlTree(['/stock']);
};

// Administrateur et chef de magasin (tableau de bord)
export const gestionnaireGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return peutGererMagasin(auth.utilisateur()) ? true : inject(Router).createUrlTree(['/stock']);
};

// Page d'accueil : tableau de bord (administrateur, chef de magasin), stock (magasinier)
export function pageAccueil(auth: AuthService): string {
  return peutGererMagasin(auth.utilisateur()) ? '/tableau-de-bord' : '/stock';
}
