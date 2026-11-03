import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { downloadOutline, gridOutline, searchOutline, cloudUploadOutline, chevronForward } from 'ionicons/icons';
import { ControlesService } from '../../services/controles.service';
import { EnteteComponent } from '../../composants/entete.component';

// Import : les deux contrôles dans l'ordre du travail (réception puis rangement)
@Component({
  selector: 'app-import',
  standalone: true,
  imports: [RouterLink, DatePipe, IonContent, IonIcon, EnteteComponent],
  template: `
    <app-entete titre="Produits arrivés" module="Import" retour="/menu"></app-entete>
    <ion-content class="ion-padding">
      <ol class="parcours">
        <li class="k-apparait">
          <a routerLink="/reception" class="etape">
            <span class="numero">1</span>
            <span class="icone reception"><ion-icon name="download-outline"></ion-icon></span>
            <span class="texte"><strong>Réception</strong><small>Scanner le ticket vert : le produit est-il dans l'import ?</small></span>
            <ion-icon class="fleche" name="chevron-forward"></ion-icon>
          </a>
        </li>
        <li class="k-apparait" style="animation-delay: 60ms">
          <a routerLink="/rangement" class="etape">
            <span class="numero">2</span>
            <span class="icone rangement"><ion-icon name="grid-outline"></ion-icon></span>
            <span class="texte"><strong>Rangement</strong><small>Scanner l'emplacement, puis le produit posé</small></span>
            <ion-icon class="fleche" name="chevron-forward"></ion-icon>
          </a>
        </li>
      </ol>

      <div class="outils">
        <a routerLink="/consulter" class="outil k-carte">
          <ion-icon name="search-outline"></ion-icon>
          <strong>Consulter</strong>
          <small>Emplacement ou produit</small>
        </a>
        <a routerLink="/attente" class="outil k-carte" [class.signal]="controles.nbAttente() > 0">
          <ion-icon name="cloud-upload-outline"></ion-icon>
          <strong>En attente</strong>
          <small>{{ controles.nbAttente() ? controles.nbAttente() + ' scan(s) à envoyer' : 'Tout est envoyé' }}</small>
          @if (controles.nbAttente()) {
            <b class="badge">{{ controles.nbAttente() }}</b>
          }
        </a>
      </div>

      @if (recents().length) {
        <div class="k-section"><h2>Activité récente</h2></div>
        <ul class="fil k-carte">
          @for (r of recents(); track r.uuid) {
            <li [attr.data-couleur]="r.couleur">
              <span class="point"></span>
              <span class="ligne">
                <b>{{ r.titre }}</b>
                <small><span class="mono">{{ r.produit?.reference }}</span> · lot {{ r.produit?.lot }}</small>
              </span>
              <time>{{ r.date | date: 'HH:mm' }}</time>
            </li>
          }
        </ul>
      }
    </ion-content>
  `,
  styles: `
    .parcours { position: relative; list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 14px; }
    .parcours::before { content: ''; position: absolute; left: 25px; top: 40px; bottom: 40px; border-left: 3px dashed #c8cfe0; }
    .etape { position: relative; display: flex; align-items: center; gap: 12px; min-height: 108px; padding: 14px 14px 14px 10px; color: var(--k-nuit); text-decoration: none; background: var(--k-surface); border: 1px solid var(--k-bord); border-radius: 24px; box-shadow: var(--k-ombre); }
    .etape:active { transform: scale(0.985); }
    .numero { display: grid; place-items: center; width: 32px; height: 32px; flex: none; font-weight: 900; color: #fff; background: var(--k-rouge); border-radius: 50%; box-shadow: 0 0 0 5px var(--k-fond); margin-left: -2px; }
    .icone { display: grid; place-items: center; width: 58px; height: 58px; flex: none; font-size: 30px; color: #fff; border-radius: 18px; }
    .reception { background: linear-gradient(150deg, #1f6fd1, #13296b); }
    .rangement { background: linear-gradient(150deg, #1fa463, #0f6b3a); }
    .texte { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .texte strong { font-size: 22px; font-weight: 900; }
    .texte small { font-size: 14px; line-height: 1.3; color: var(--k-gris); }
    .fleche { flex: none; font-size: 24px; color: #b3b9cc; }
    .outils { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
    .outil { position: relative; display: flex; flex-direction: column; gap: 2px; min-height: 112px; padding: 16px; color: var(--k-nuit); text-decoration: none; }
    .outil ion-icon { font-size: 28px; color: var(--k-marine); margin-bottom: 6px; }
    .outil strong { font-size: 18px; font-weight: 700; }
    .outil small { font-size: 13px; color: var(--k-gris); }
    .outil.signal { border-color: #f1c760; background: #fffaf0; }
    .badge { position: absolute; top: 12px; right: 12px; min-width: 28px; padding: 3px 8px; font-size: 14px; text-align: center; color: #fff; background: var(--k-rouge); border-radius: 999px; }
    .fil { list-style: none; margin: 0; padding: 4px 14px; }
    .fil li { --c: var(--k-vert); display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--k-bord); }
    .fil li:last-child { border-bottom: 0; }
    .fil li[data-couleur='orange'] { --c: var(--k-orange); }
    .fil li[data-couleur='rouge'] { --c: var(--k-erreur); }
    .point { width: 12px; height: 12px; flex: none; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 18%, transparent); }
    .ligne { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .ligne b { font-size: 15px; }
    .ligne small { font-size: 13px; color: var(--k-gris); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    time { font-size: 13px; font-weight: 600; color: var(--k-gris); }
  `,
})
export class ImportPage {
  readonly controles = inject(ControlesService);
  readonly recents = () => this.controles.recents().filter((r) => r.controle !== 'export').slice(0, 6);

  constructor() {
    addIcons({ downloadOutline, gridOutline, searchOutline, cloudUploadOutline, chevronForward });
  }
}
