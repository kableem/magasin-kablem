import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { IonButton, IonContent, IonIcon, IonInput, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { personOutline, lockClosedOutline, eyeOutline, eyeOffOutline, alertCircle, arrowForward } from 'ionicons/icons';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-connexion',
  standalone: true,
  imports: [FormsModule, IonContent, IonInput, IonButton, IonIcon, IonSpinner],
  template: `
    <ion-content [fullscreen]="true">
      <div class="page">
        <section class="hero">
          <div class="motif"></div>
          <div class="logo"><img src="assets/logo-kablem.png" alt="Kab-lem Group" /></div>
          <h1>Magasin</h1>
          <p>Réception, rangement et sortie<br />contrôlés au scan</p>
        </section>

        <form class="carte k-carte k-apparait" (ngSubmit)="connexion()">
          <h2>Connexion</h2>
          <label class="k-libelle" for="matricule">Matricule</label>
          <div class="k-champ">
            <ion-icon name="person-outline"></ion-icon>
            <ion-input id="matricule" name="matricule" inputmode="numeric" placeholder="ex. 10245" [(ngModel)]="matricule" autocomplete="username"></ion-input>
          </div>
          <label class="k-libelle" for="mdp">Mot de passe</label>
          <div class="k-champ">
            <ion-icon name="lock-closed-outline"></ion-icon>
            <ion-input id="mdp" name="motDePasse" [type]="voir() ? 'text' : 'password'" placeholder="••••••" [(ngModel)]="motDePasse" autocomplete="current-password"></ion-input>
            <button type="button" class="oeil" (click)="voir.set(!voir())" [attr.aria-label]="voir() ? 'Masquer' : 'Afficher'">
              <ion-icon [name]="voir() ? 'eye-off-outline' : 'eye-outline'"></ion-icon>
            </button>
          </div>

          @if (erreur()) {
            <p class="erreur k-apparait"><ion-icon name="alert-circle"></ion-icon>{{ erreur() }}</p>
          }

          <ion-button type="submit" expand="block" class="k-btn-rouge envoyer" [disabled]="enCours() || !matricule || !motDePasse">
            @if (enCours()) {
              <ion-spinner name="crescent"></ion-spinner>
            } @else {
              Se connecter <ion-icon slot="end" name="arrow-forward"></ion-icon>
            }
          </ion-button>
          <p class="aide">Même matricule et mot de passe que l'application web.</p>
        </form>

        <p class="signature">Kab-lem Tunisia · Menzel Jemil</p>
      </div>
    </ion-content>
  `,
  styles: `
    .page { min-height: 100%; display: flex; flex-direction: column; }
    .hero { position: relative; overflow: hidden; padding: calc(44px + var(--ion-safe-area-top, 0px)) 24px 96px; text-align: center; color: #fff; background: var(--k-degrade-nuit); border-bottom: 5px solid var(--k-rouge); border-radius: 0 0 36px 36px; }
    .motif { position: absolute; inset: 0; opacity: 0.08; background-image: repeating-linear-gradient(135deg, #fff 0 2px, transparent 2px 22px); }
    .logo { position: relative; display: inline-flex; padding: 14px 20px; background: #fff; border-radius: 20px; box-shadow: 0 16px 30px -16px rgba(0, 0, 0, 0.6); }
    .logo img { height: 46px; display: block; }
    h1 { position: relative; margin: 18px 0 4px; font-size: 34px; font-weight: 900; letter-spacing: 0.01em; }
    .hero p { position: relative; margin: 0; font-size: 16px; line-height: 1.35; color: #c7d0ec; }
    .carte { position: relative; margin: -64px 18px 0; padding: 20px 20px 18px; }
    h2 { margin: 0 0 2px; font-size: 22px; font-weight: 700; color: var(--k-nuit); }
    .oeil { display: grid; place-items: center; width: 48px; height: 48px; flex: none; color: var(--k-gris); background: none; border: 0; font-size: 22px; }
    .erreur { display: flex; align-items: center; gap: 8px; margin: 14px 0 0; padding: 10px 12px; font-weight: 600; color: var(--k-erreur); background: var(--k-erreur-clair); border-radius: 12px; }
    .erreur ion-icon { flex: none; font-size: 20px; }
    .envoyer { margin-top: 22px; }
    .aide { margin: 14px 0 0; text-align: center; font-size: 13.5px; color: var(--k-gris); }
    .signature { margin: auto 0 0; padding: 24px 0 calc(18px + var(--ion-safe-area-bottom, 0px)); text-align: center; font-size: 13px; color: var(--k-gris); }
  `,
})
export class ConnexionPage {
  private auth = inject(AuthService);
  private router = inject(Router);
  matricule = '';
  motDePasse = '';
  readonly voir = signal(false);
  readonly enCours = signal(false);
  readonly erreur = signal('');

  constructor() {
    addIcons({ personOutline, lockClosedOutline, eyeOutline, eyeOffOutline, alertCircle, arrowForward });
  }

  connexion(): void {
    this.enCours.set(true);
    this.erreur.set('');
    this.auth.connexion(this.matricule.trim(), this.motDePasse).subscribe({
      next: () => {
        this.enCours.set(false);
        this.motDePasse = '';
        // retour à la page demandée avant la connexion (lien d'étiquette), sinon l'accueil
        const retour = this.router.parseUrl(this.router.url).queryParams['retour'];
        this.router.navigateByUrl(typeof retour === 'string' && retour.startsWith('/') ? retour : '/menu', { replaceUrl: true });
      },
      error: (e: HttpErrorResponse) => {
        this.enCours.set(false);
        this.erreur.set(e.status === 0 ? 'Serveur injoignable : vérifiez le Wi-Fi.' : (e.error?.message ?? 'Connexion impossible'));
      },
    });
  }
}
