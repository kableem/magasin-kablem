import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { IonButton, IonContent, IonFooter, IonIcon, IonSpinner, IonToolbar } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { trashOutline, cloudUploadOutline, wifi, cloudOfflineOutline, checkmarkDoneOutline, keypadOutline } from 'ionicons/icons';
import { ControlesService } from '../../services/controles.service';
import { ResultatComponent } from '../../composants/resultat.component';
import { EnteteComponent } from '../../composants/entete.component';
import { EmplPipe } from '../../composants/empl.pipe';

// Scans gardés sans réseau, et résultats des derniers envois
@Component({
  selector: 'app-attente',
  standalone: true,
  imports: [EmplPipe, DatePipe, IonContent, IonButton, IonIcon, IonSpinner, IonFooter, IonToolbar, ResultatComponent, EnteteComponent],
  template: `
    <app-entete titre="En attente" module="Import" retour="/import"></app-entete>
    <ion-content class="ion-padding">
      <div class="reseau k-apparait" [class.coupe]="!enLigne()">
        <ion-icon [name]="enLigne() ? 'wifi' : 'cloud-offline-outline'"></ion-icon>
        <div>
          <strong>{{ enLigne() ? 'Réseau disponible' : 'Pas de réseau' }}</strong>
          <small>{{ enLigne() ? 'Les scans gardés partent automatiquement.' : 'Les scans sont gardés sur le téléphone.' }}</small>
        </div>
      </div>

      @if (controles.attente().length) {
        <div class="k-section"><h2>{{ controles.attente().length }} scan(s) à envoyer</h2></div>
        <ul class="liste">
          @for (o of controles.attente(); track o.uuid) {
            <li class="k-carte">
              <span class="type" [class.rangement]="o.controle === 'rangement'">{{ o.controle === 'reception' ? 'R' : 'G' }}</span>
              <div class="texte">
                <b>{{ o.controle === 'reception' ? 'Réception' : 'Rangement' }}
                  @if (o.corps.emplacement) {
                    <span class="k-etiquette mini">{{ o.corps.emplacement | empl }}</span>
                  }
                </b>
                <small class="mono qr">{{ o.corps.qr }}</small>
                <small>
                  {{ o.date | date: 'dd/MM HH:mm:ss' }}
                  @if (o.corps.saisie_manuelle) {
                    · <ion-icon name="keypad-outline"></ion-icon> manuelle
                  }
                  @if (o.derniereErreur) {
                    · <span class="err">{{ o.derniereErreur }}</span>
                  }
                </small>
              </div>
              <button type="button" class="suppr" (click)="controles.supprimerAttente(o.uuid)" aria-label="Supprimer"><ion-icon name="trash-outline"></ion-icon></button>
            </li>
          }
        </ul>
      } @else {
        <div class="tout-envoye k-apparait">
          <ion-icon name="checkmark-done-outline"></ion-icon>
          <strong>Tout est envoyé</strong>
          <small>Aucun scan en attente sur ce téléphone.</small>
        </div>
      }

      @if (controles.recents().length) {
        <div class="k-section"><h2>Derniers résultats</h2></div>
        <div class="resultats">
          @for (r of controles.recents(); track r.uuid) {
            <app-resultat [r]="r" [compact]="true"></app-resultat>
          }
        </div>
      }
    </ion-content>

    @if (controles.attente().length) {
      <ion-footer class="k-pied">
        <ion-toolbar>
          <ion-button expand="block" class="k-btn-principal" [disabled]="controles.envoiEnCours()" (click)="envoyer()">
            @if (controles.envoiEnCours()) {
              <ion-spinner name="crescent"></ion-spinner>
            } @else {
              <ion-icon slot="start" name="cloud-upload-outline"></ion-icon> Envoyer maintenant ({{ controles.attente().length }})
            }
          </ion-button>
        </ion-toolbar>
      </ion-footer>
    }
  `,
  styles: `
    .reseau { display: flex; align-items: center; gap: 12px; padding: 14px 16px; color: var(--k-vert); background: var(--k-vert-clair); border-radius: 18px; }
    .reseau.coupe { color: var(--k-erreur); background: var(--k-erreur-clair); }
    .reseau ion-icon { flex: none; font-size: 30px; }
    .reseau strong { display: block; font-size: 17px; }
    .reseau small { color: var(--k-texte); opacity: 0.75; }
    .liste { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .liste li { display: flex; align-items: center; gap: 12px; padding: 12px; }
    .type { display: grid; place-items: center; width: 42px; height: 42px; flex: none; font-weight: 900; color: #fff; background: linear-gradient(150deg, #1f6fd1, #13296b); border-radius: 14px; }
    .type.rangement { background: linear-gradient(150deg, #1fa463, #0f6b3a); }
    .texte { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .texte b { display: flex; align-items: center; gap: 8px; font-size: 16px; }
    .mini { font-size: 13px; padding: 0 8px; border-left-width: 4px; }
    .texte small { font-size: 12.5px; color: var(--k-gris); }
    .qr { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .err { color: var(--k-erreur); font-weight: 700; }
    .suppr { display: grid; place-items: center; width: 44px; height: 44px; flex: none; font-size: 22px; color: var(--k-erreur); background: var(--k-erreur-clair); border: 0; border-radius: 14px; }
    .tout-envoye { display: flex; flex-direction: column; align-items: center; gap: 4px; margin-top: 18px; padding: 26px 16px; text-align: center; background: var(--k-surface); border: 1px solid var(--k-bord); border-radius: 22px; }
    .tout-envoye ion-icon { font-size: 44px; color: var(--k-vert); }
    .tout-envoye strong { font-size: 19px; color: var(--k-nuit); }
    .tout-envoye small { color: var(--k-gris); }
    .resultats { display: grid; gap: 12px; }
  `,
})
export class AttentePage {
  readonly controles = inject(ControlesService);
  readonly enLigne = signal(navigator.onLine);

  constructor() {
    addIcons({ trashOutline, cloudUploadOutline, wifi, cloudOfflineOutline, checkmarkDoneOutline, keypadOutline });
    window.addEventListener('online', () => this.enLigne.set(true));
    window.addEventListener('offline', () => this.enLigne.set(false));
  }

  envoyer(): void {
    this.controles.envoyerAttente();
  }
}
