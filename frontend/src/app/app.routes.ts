import { Routes } from '@angular/router';
import { Login } from './pages/login/login';
import { Stock } from './pages/stock/stock';
import { Import } from './pages/import/import';
import { Export } from './pages/export/export';
import { Reclamations } from './pages/reclamations/reclamations';
import { EmplacementTest } from './pages/emplacement-test/emplacement-test';
import { Utilisateurs } from './pages/utilisateurs/utilisateurs';
import { Articles } from './pages/articles/articles';
import { inject } from '@angular/core';
import { AuthService } from './services/auth';
import { TableauDeBordPage } from './pages/tableau-de-bord/tableau-de-bord';
import { Journal } from './pages/journal/journal';
import { adminGuard, authGuard, gestionnaireGuard, inviteGuard, pageAccueil } from './guards/auth-guard';

export const routes: Routes = [
  { path: '', redirectTo: () => pageAccueil(inject(AuthService)).slice(1), pathMatch: 'full' },
  {
    path: 'tableau-de-bord',
    component: TableauDeBordPage,
    canActivate: [authGuard, gestionnaireGuard],
    title: 'Tableau de bord · Magasin Kablem',
  },
  { path: 'login', component: Login, canActivate: [inviteGuard], title: 'Connexion · Magasin Kablem' },
  { path: 'stock', component: Stock, canActivate: [authGuard], title: 'Gestion de stock · Magasin Kablem' },
  { path: 'import', component: Import, canActivate: [authGuard], title: 'Import · Magasin Kablem' },
  { path: 'export', component: Export, canActivate: [authGuard], title: 'Export · Magasin Kablem' },
  { path: 'reclamations', component: Reclamations, canActivate: [authGuard], title: 'Réclamations · Magasin Kablem' },
  {
    path: 'journal',
    component: Journal,
    canActivate: [authGuard, gestionnaireGuard],
    title: 'Journal des alertes · Magasin Kablem',
  },
  // Plan du magasin (blocs A à H, numéros des étiquettes) ; l'ancienne page d'essai renvoie ici
  { path: 'emplacements', component: EmplacementTest, canActivate: [authGuard], title: 'Emplacements · Magasin Kablem' },
  { path: 'emplacement-test', redirectTo: 'emplacements' },
  {
    path: 'utilisateurs',
    component: Utilisateurs,
    canActivate: [authGuard, adminGuard],
    title: 'Utilisateurs · Magasin Kablem',
  },
  {
    path: 'articles',
    component: Articles,
    canActivate: [authGuard, gestionnaireGuard], // catalogue des articles : administrateur et chef de magasin
    title: 'Articles · Magasin Kablem',
  },
  { path: 'produits', redirectTo: 'stock' },
  { path: '**', redirectTo: () => pageAccueil(inject(AuthService)).slice(1) },
];
