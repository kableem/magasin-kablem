import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService, estPlanificateur, peutGererMagasin } from '../services/auth';

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

// Pages du magasin : le planificateur n'y a pas accès (il ne gère que les articles)
export const magasinGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return estPlanificateur(auth.utilisateur()) ? inject(Router).createUrlTree(['/articles']) : true;
};

// Catalogue des articles : administrateur et planificateur
export const articlesGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const role = auth.utilisateur()?.role;
  return role === 'admin' || role === 'planificateur' ? true : inject(Router).createUrlTree(['/stock']);
};

// Administrateur et chef de magasin (tableau de bord)
export const gestionnaireGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return peutGererMagasin(auth.utilisateur()) ? true : inject(Router).createUrlTree(['/stock']);
};

// Page d'accueil : tableau de bord (administrateur, chef de magasin), stock (magasinier), articles (planificateur)
export function pageAccueil(auth: AuthService): string {
  if (estPlanificateur(auth.utilisateur())) return '/articles';
  return peutGererMagasin(auth.utilisateur()) ? '/tableau-de-bord' : '/stock';
}
