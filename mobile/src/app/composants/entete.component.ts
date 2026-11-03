import { Component, DestroyRef, effect, inject, input, output, untracked } from '@angular/core';
import { AlertController, IonButtons, IonHeader, IonIcon, IonRouterOutlet, IonToolbar } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { chevronBack, homeOutline } from 'ionicons/icons';
import { NavigationService } from '../services/navigation.service';

// En-tête commun : bleu nuit Kab-lem, filet rouge (comme l'application web), module en pastille.
// À gauche « Retour » : étape précédente de l'écran s'il en a une (etape = true, l'écran reçoit
// (precedent)), sinon l'écran d'avant. À droite « Menu » : retour au menu principal.
// Le geste « retour » du téléphone fait comme le bouton « Retour ».
// confirmer = message affiché avant de quitter quand un travail n'est pas encore enregistré.
// <app-entete titre="Réception" module="Import" retour="/import" [etape]="…" (precedent)="…"> [actions] </app-entete>
@Component({
  selector: 'app-entete',
  standalone: true,
  imports: [IonHeader, IonToolbar, IonButtons, IonIcon],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        @if (retour() || etape()) {
          <ion-buttons slot="start">
            <button type="button" class="nav" (click)="precedentClic()" aria-label="Retour à l'écran précédent">
              <ion-icon name="chevron-back"></ion-icon><small>Retour</small>
            </button>
          </ion-buttons>
        }
        <div class="titres" [class.sans-retour]="!retour() && !etape()">
          @if (module()) {
            <span class="module" [attr.data-module]="module()">{{ module() }}</span>
          }
          <h1>{{ titre() }}</h1>
        </div>
        <ion-buttons slot="end">
          <ng-content></ng-content>
          <button type="button" class="nav" (click)="menuClic()" aria-label="Menu principal">
            <ion-icon name="home-outline"></ion-icon><small>Menu</small>
          </button>
        </ion-buttons>
      </ion-toolbar>
      <div class="filet"></div>
    </ion-header>
  `,
  styles: `
    ion-toolbar { --background: var(--k-degrade-nuit); --color: #fff; --min-height: 68px; --padding-start: 8px; --padding-end: 8px; }
    .nav { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; width: 58px; height: 54px; padding: 0; font: inherit; color: #fff; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 16px; transition: background 0.12s, transform 0.12s; }
    .nav:active { background: rgba(255, 255, 255, 0.26); transform: scale(0.95); }
    .nav ion-icon { font-size: 25px; }
    .nav small { font-size: 11px; font-weight: 700; line-height: 1.1; letter-spacing: 0.02em; }
    .titres { display: flex; flex-direction: column; justify-content: center; min-height: 68px; padding: 4px 0 4px 12px; }
    .titres.sans-retour { padding-left: 14px; }
    .module { align-self: flex-start; padding: 1px 9px; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #cfd6ee; background: rgba(255, 255, 255, 0.12); border-radius: 999px; }
    .module[data-module='Export'] { color: #fff; background: var(--k-rouge); }
    h1 { margin: 2px 0 0; font-size: 21px; font-weight: 700; line-height: 1.1; color: #fff; }
    .filet { height: 4px; background: linear-gradient(90deg, var(--k-rouge) 0%, var(--k-rouge) 35%, #ff5a4f 100%); }
  `,
})
export class EnteteComponent {
  private navigation = inject(NavigationService);
  private alertes = inject(AlertController);
  private outlet = inject(IonRouterOutlet, { optional: true });

  readonly titre = input.required<string>();
  readonly module = input<string>('');
  readonly retour = input<string | null>(null);
  readonly etape = input(false);
  readonly confirmer = input<string | null>(null);
  readonly precedent = output<void>();

  constructor() {
    addIcons({ chevronBack, homeOutline });
    effect(() => {
      const etape = this.etape();
      untracked(() => this.suivre(etape));
    });
    inject(DestroyRef).onDestroy(() => this.navigation.oublier(this));
  }

  precedentClic(): void {
    if (this.etape()) {
      this.retourEtape();
      return;
    }
    this.siAccepte(() => this.navigation.precedent(this.retour() ?? '/menu', this.outlet));
  }

  menuClic(): void {
    this.siAccepte(() => this.navigation.menu());
  }

  // Signale au service si l'écran est dans une étape (le retour du téléphone y revient)
  private suivre(etape: boolean): void {
    this.navigation.etape(this, etape ? () => this.retourEtape() : null);
  }

  private retourEtape(): void {
    this.siAccepte(
      () => {
        this.precedent.emit();
        // l'écran est peut-être encore dans une étape : le retour du téléphone doit continuer d'y revenir
        setTimeout(() => this.suivre(this.etape()));
      },
      () => this.suivre(this.etape())
    );
  }

  private async siAccepte(action: () => void, sinon?: () => void): Promise<void> {
    const message = this.confirmer();
    if (!message) {
      action();
      return;
    }
    const alerte = await this.alertes.create({
      header: 'Quitter sans enregistrer ?',
      message,
      buttons: [
        { text: 'Rester', role: 'cancel' },
        { text: 'Quitter', role: 'confirm' },
      ],
    });
    await alerte.present();
    const { role } = await alerte.onDidDismiss();
    if (role === 'confirm') action();
    else sinon?.();
  }
}
