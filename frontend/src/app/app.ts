import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService, estPlanificateur, peutGererMagasin } from './services/auth';
import { LIBELLES_ROLES } from './services/utilisateur';
import { ToastService } from './services/toast';

interface LienMenu {
  chemin: string;
  libelle: string;
  icone: string; // tracé SVG (Material Icons, 24×24)
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly auth = inject(AuthService);
  protected readonly toast = inject(ToastService);
  private router = inject(Router);

  protected readonly libellesRoles = LIBELLES_ROLES;
  protected readonly sidebarOuverte = signal(false); // mobile : tiroir ouvert
  protected readonly sidebarReduite = signal(false); // bureau : icônes seulement
  protected readonly menuUtilisateur = signal(false);

  protected readonly estAdmin = computed(() => this.auth.utilisateur()?.role === 'admin');
  // Tableau de bord : administrateur et chef de magasin
  protected readonly peutGerer = computed(() => peutGererMagasin(this.auth.utilisateur()));
  protected readonly planificateur = computed(() => estPlanificateur(this.auth.utilisateur()));
  protected readonly lienTableau: LienMenu = {
    chemin: '/tableau-de-bord',
    libelle: 'Tableau de bord',
    icone: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  };

  // Contrôle du travail des magasiniers (scans du mobile)
  protected readonly lienJournal: LienMenu = {
    chemin: '/journal',
    libelle: 'Journal des alertes',
    icone: 'M12 2 1 21h22L12 2zm1 16h-2v-2h2v2zm0-4h-2v-4h2v4z',
  };

  protected readonly liensMagasin: LienMenu[] = [
    {
      chemin: '/stock',
      libelle: 'Gestion de stock',
      icone: 'M20 2H4c-1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z',
    },
    {
      chemin: '/import',
      libelle: 'Import',
      icone: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    },
    {
      chemin: '/export',
      libelle: 'Export',
      icone: 'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
    },
    {
      chemin: '/reclamations',
      libelle: 'Réclamations',
      icone: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    },
    {
      chemin: '/emplacements',
      libelle: 'Emplacements',
      icone: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z',
    },
  ];

  protected readonly liensAdmin: LienMenu[] = [
    {
      chemin: '/articles',
      libelle: 'Articles',
      icone: 'M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-2 6H6v-2h12v2zm-4 4H6v-2h8v2z',
    },
    {
      chemin: '/utilisateurs',
      libelle: 'Utilisateurs',
      icone: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    },
  ];

  constructor() {
    // Ferme le tiroir et le menu utilisateur après chaque navigation
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      this.sidebarOuverte.set(false);
      this.menuUtilisateur.set(false);
    });
  }

  protected basculerSidebar(): void {
    if (window.matchMedia('(max-width: 900px)').matches) {
      this.sidebarOuverte.update((v) => !v);
    } else {
      this.sidebarReduite.update((v) => !v);
    }
  }
}
