import { Routes } from '@angular/router';
import { connecteGuard } from './services/auth.service';

export const routes: Routes = [
  { path: 'connexion', loadComponent: () => import('./pages/connexion/connexion.page').then((m) => m.ConnexionPage) },
  { path: 'menu', canActivate: [connecteGuard], loadComponent: () => import('./pages/menu/menu.page').then((m) => m.MenuPage) },
  { path: 'import', canActivate: [connecteGuard], loadComponent: () => import('./pages/import/import.page').then((m) => m.ImportPage) },
  { path: 'export', canActivate: [connecteGuard], loadComponent: () => import('./pages/export/export.page').then((m) => m.ExportPage) },
  { path: 'reception', canActivate: [connecteGuard], loadComponent: () => import('./pages/reception/reception.page').then((m) => m.ReceptionPage) },
  { path: 'rangement', canActivate: [connecteGuard], loadComponent: () => import('./pages/rangement/rangement.page').then((m) => m.RangementPage) },
  { path: 'inventaire', canActivate: [connecteGuard], loadComponent: () => import('./pages/inventaire/inventaire.page').then((m) => m.InventairePage) },
  { path: 'ranger', canActivate: [connecteGuard], loadComponent: () => import('./pages/ranger/ranger.page').then((m) => m.RangerPage) },
  { path: 'consulter', canActivate: [connecteGuard], loadComponent: () => import('./pages/consulter/consulter.page').then((m) => m.ConsulterPage) },
  // lien imprimé sur les étiquettes d'emplacement (ouvert par l'appareil photo du téléphone)
  { path: 'e/:code', canActivate: [connecteGuard], loadComponent: () => import('./pages/consulter/consulter.page').then((m) => m.ConsulterPage) },
  { path: 'attente', canActivate: [connecteGuard], loadComponent: () => import('./pages/attente/attente.page').then((m) => m.AttentePage) },
  { path: '', redirectTo: 'menu', pathMatch: 'full' },
  { path: '**', redirectTo: 'menu' },
];
