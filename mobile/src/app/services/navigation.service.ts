import { Injectable, inject } from '@angular/core';
import { IonRouterOutlet, NavController } from '@ionic/angular/standalone';

// Navigation commune à tous les écrans : bouton « Retour », bouton « Menu » et geste « retour » du téléphone.
// Un écran à plusieurs étapes (import choisi, emplacement en cours de comptage…) ajoute une entrée dans
// l'historique du navigateur : le retour du téléphone revient alors à l'étape précédente de l'écran
// au lieu de le quitter. L'entrée est retirée dès que l'écran revient à sa première étape.
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private nav = inject(NavController);
  private proprietaire: object | null = null; // en-tête de l'écran qui a une étape en cours
  private revenir: (() => void) | null = null;
  private url = ''; // adresse de l'écran quand l'entrée a été ajoutée
  private ignorer = 0; // retours lancés par l'application elle-même

  constructor() {
    window.addEventListener('popstate', () => {
      if (this.ignorer) {
        this.ignorer--;
        return;
      }
      if (!this.proprietaire) return;
      const revenir = this.revenir;
      const memeEcran = this.adresse() === this.url;
      this.proprietaire = null;
      this.revenir = null;
      if (memeEcran) revenir?.();
    });
  }

  // L'écran entre dans une étape intérieure (revenir = retour à l'étape précédente), ou en sort (null)
  etape(proprietaire: object, revenir: (() => void) | null): void {
    if (revenir) {
      if (!this.proprietaire) {
        history.pushState({ ...history.state, kEtape: true }, '');
        this.url = this.adresse();
      }
      this.proprietaire = proprietaire;
      this.revenir = revenir;
    } else if (this.proprietaire === proprietaire) {
      this.proprietaire = null;
      this.revenir = null;
      this.ignorer++;
      history.back();
    }
  }

  // En-tête détruit sans passer par ses boutons (déconnexion…) : on oublie son étape
  oublier(proprietaire: object): void {
    if (this.proprietaire === proprietaire) {
      this.proprietaire = null;
      this.revenir = null;
    }
  }

  // Écran précédent : vrai retour dans l'historique quand l'écran d'avant est connu, sinon l'écran parent
  precedent(parent: string, outlet: IonRouterOutlet | null): void {
    const entree = this.liberer();
    if (outlet?.canGoBack()) history.go(entree ? -2 : -1);
    else this.nav.navigateBack(parent, { replaceUrl: entree });
  }

  menu(): void {
    const entree = this.liberer();
    this.nav.navigateRoot('/menu', { replaceUrl: entree, animationDirection: 'back' });
  }

  private liberer(): boolean {
    const entree = !!this.proprietaire;
    this.proprietaire = null;
    this.revenir = null;
    return entree;
  }

  private adresse(): string {
    return location.pathname + location.search;
  }
}
