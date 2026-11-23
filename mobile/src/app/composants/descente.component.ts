import { Component, computed, inject, input, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowDown, checkmark, closeOutline, cubeOutline } from 'ionicons/icons';
import { Lecture, ScannerComponent } from './scanner.component';
import { EmplPipe } from './empl.pipe';
import { DescenteService } from '../services/descente.service';
import { RetourService } from '../services/retour.service';
import { Descente, ResultatControle, codeEmplacement } from '../services/modeles';

// Carton de cosses ouvert à l'export : en haut il n'y a que des cartons neufs. Les cosses qui restent dans le
// carton deviennent des cosses séparées et descendent TOUT DE SUITE, chacune à l'emplacement imposé :
// on scanne l'étiquette de l'emplacement, puis le ticket vert de chaque cosse. La sortie suivante attend.
@Component({
  selector: 'app-descente',
  standalone: true,
  imports: [EmplPipe, IonIcon, IonSpinner, ScannerComponent],
  template: `
    @if (d(); as d) {
      <app-scanner
        [actif]="!envoi() && d.restantes > 0"
        [attendu]="emplacement() ? 'ticket' : 'emplacement'"
        [consigne]="emplacement() ? 'Ticket vert d\\'une cosse du carton n° ' + d.carton : 'Étiquette de ' + ((prochaine()?.emplacement | empl) || 'l\\'emplacement')"
        [cible]="emplacement() ? null : (prochaine()?.emplacement ?? null)"
        cibleTexte="Descendez en"
        [compteur]="d.cosses.length - d.restantes + '/' + d.cosses.length"
        [resultat]="resultat()"
        (lecture)="emplacement() ? lireTicket($event) : lireEmplacement($event)"
      ></app-scanner>

      <section class="carte k-apparait">
        <span class="icone"><ion-icon name="arrow-down"></ion-icon></span>
        <div>
          <small>Carton n° {{ d.carton }} ouvert{{ d.palette ? ' · palette n° ' + d.palette : '' }}</small>
          <strong class="mono">{{ d.reference }}</strong>
          <span class="lot">lot {{ d.lot }}</span>
        </div>
      </section>
      <p class="pourquoi">
        En haut, on ne garde que des cartons neufs. Descendez maintenant
        {{ d.restantes > 1 ? 'les ' + d.restantes + ' cosses restantes' : 'la cosse restante' }}
        de <b>{{ d.depuis | empl }}</b> vers {{ d.emplacements.length > 1 ? 'les emplacements imposés' : 'l\\'emplacement imposé' }} :
        elles deviennent des cosses séparées.
      </p>

      <div class="k-etapes">
        <div class="k-etape" [class.faite]="!!emplacement()" [class.courante]="!emplacement()">
          <span class="rond">
            @if (emplacement()) {
              <ion-icon name="checkmark"></ion-icon>
            } @else {
              1
            }
          </span>
          <span class="txt"><small>{{ emplacement() ? 'Emplacement' : 'Allez en' }}</small><b class="mono">{{ (emplacement() ?? prochaine()?.emplacement ?? '') | empl }}</b></span>
          @if (emplacement()) {
            <button type="button" class="effacer" (click)="emplacement.set(null)" aria-label="Changer d'emplacement"><ion-icon name="close-outline"></ion-icon></button>
          }
        </div>
        <div class="k-etape" [class.courante]="!!emplacement()">
          <span class="rond">2</span>
          <span class="txt"><small>Ticket de chaque cosse</small><b class="mono">{{ d.restantes }} à poser</b></span>
        </div>
      </div>

      @if (envoi()) {
        <p class="k-envoi"><ion-spinner name="crescent"></ion-spinner></p>
      }

      <ol class="cosses">
        @for (c of d.cosses; track c.ticket) {
          <li [class.posee]="c.posee" [class.courante]="!c.posee && c === prochaine()">
            <span class="rond">
              @if (c.posee) {
                <ion-icon name="checkmark"></ion-icon>
              } @else {
                <ion-icon name="cube-outline"></ion-icon>
              }
            </span>
            <span class="colis"><b>Colis n° {{ c.colis }}</b><small>{{ c.posee ? 'posée' : 'à descendre' }}</small></span>
            <span class="k-etiquette code" [class.vide]="!c.emplacement">{{ (c.emplacement | empl) || 'à définir' }}</span>
          </li>
        }
      </ol>
    }
  `,
  styles: `
    :host { display: block; }
    .carte { display: flex; align-items: center; gap: 14px; margin-top: 14px; padding: 16px; color: #fff; background: linear-gradient(150deg, #f08a24, #b35600); border-radius: 24px; box-shadow: var(--k-ombre-forte); }
    .carte .icone { display: grid; place-items: center; flex: none; width: 56px; height: 56px; font-size: 32px; background: rgba(255, 255, 255, 0.2); border-radius: 50%; }
    .carte div { display: flex; flex-direction: column; min-width: 0; }
    .carte small { font-size: 14px; font-weight: 700; opacity: 0.9; }
    .carte strong { font-size: 26px; line-height: 1.1; }
    .carte .lot { font-size: 14.5px; font-weight: 700; }
    .pourquoi { margin: 12px 2px; font-size: 15px; line-height: 1.45; color: var(--k-nuit); }
    .k-etapes { margin-bottom: 14px; }
    .cosses { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .cosses li { display: grid; grid-template-columns: 40px 1fr auto; align-items: center; gap: 10px; min-height: 62px; padding: 8px 12px; background: var(--k-surface); border: 2px solid var(--k-bord); border-radius: 18px; }
    .cosses li.courante { border-color: #f08a24; box-shadow: 0 0 0 4px rgba(240, 138, 36, 0.15); }
    .cosses li.posee { background: #f3fbf6; border-color: #cdebd9; }
    .cosses .rond { display: grid; place-items: center; width: 34px; height: 34px; font-size: 18px; color: #fff; background: var(--k-nuit); border-radius: 50%; }
    li.courante .rond { background: #f08a24; }
    li.posee .rond { background: var(--k-vert); }
    .colis { display: flex; flex-direction: column; line-height: 1.2; }
    .colis b { font-size: 16px; }
    .colis small { font-size: 12.5px; color: var(--k-gris); }
    .code { font-size: 20px; }
    li.posee .code { opacity: 0.55; }
  `,
})
export class DescenteComponent {
  private service = inject(DescenteService);
  private retour = inject(RetourService);

  readonly descente = input.required<Descente>();
  // la descente est finie (toutes les cosses posées) : le dernier résultat, pour l'afficher
  readonly terminee = output<ResultatControle>();

  private derniere = signal<Descente | null>(null);
  readonly d = computed(() => (this.derniere()?.id === this.descente().id ? this.derniere() : this.descente()));
  readonly emplacement = signal<string | null>(null);
  readonly resultat = signal<ResultatControle | null>(null);
  readonly envoi = signal(false);
  readonly prochaine = computed(() => this.d()?.cosses.find((c) => !c.posee));

  constructor() {
    addIcons({ arrowDown, checkmark, closeOutline, cubeOutline });
  }

  lireEmplacement(l: Lecture): void {
    this.retour.lu();
    this.resultat.set(null);
    this.emplacement.set(codeEmplacement(l.texte));
  }

  async lireTicket(l: Lecture): Promise<void> {
    const d = this.d();
    const code = this.emplacement();
    if (!d || !code || this.envoi()) return;
    this.envoi.set(true);
    this.retour.lu();
    try {
      const r = await this.service.scanner(d.id, code, l.texte);
      this.resultat.set(r);
      if (r.descente) this.derniere.set(r.descente);
      this.retour.signaler(r.couleur);
      // faux emplacement : on rescanne l'étiquette ; sinon on reste là tant que la cosse suivante y va aussi
      if (r.resultat === 'faux_emplacement' || r.resultat === 'emplacement_inconnu' || this.prochaine()?.emplacement !== code) this.emplacement.set(null);
      if (r.descente && !r.descente.restantes) this.terminee.emit(r);
    } catch (e) {
      const err = e as HttpErrorResponse;
      this.resultat.set({
        uuid: '', controle: 'rangement', resultat: 'erreur', couleur: 'rouge', titre: 'Contrôle impossible',
        message: err.status === 0 ? 'Pas de réseau : la descente demande le Wi-Fi. Réessayez.' : (err.error?.message ?? `Erreur ${err.status}`),
        produit: null, quantite_ticket: null, quantite_attendue: null, ecart: null, emplacements_prevus: [], emplacement_scanne: null,
        saisie_manuelle: false, date: new Date().toISOString(),
      });
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
    }
  }
}
