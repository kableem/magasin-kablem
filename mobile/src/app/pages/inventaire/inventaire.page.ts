import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { IonButton, IonContent, IonFooter, IonIcon, IonToolbar } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { clipboardOutline, closeOutline, checkmarkDone, alertCircle, arrowForward, homeOutline } from 'ionicons/icons';
import { Lecture, ScannerComponent } from '../../composants/scanner.component';
import { EnteteComponent } from '../../composants/entete.component';
import { ControlesService } from '../../services/controles.service';
import { RetourService } from '../../services/retour.service';
import { NavigationService } from '../../services/navigation.service';
import { EmplacementInventaire, InventaireValide, ResultatControle, codeEmplacement, estCodeEmplacement } from '../../services/modeles';
import { erreurLocale } from '../reception/reception.page';
import { EmplPipe } from '../../composants/empl.pipe';

interface TicketLu {
  texte: string;
  reference: string;
  lot: string;
  colis: number | null;
}

// Inventaire initial (chef de magasin, administrateur) : pour chaque emplacement, scan de son QR,
// puis du ticket de chaque produit réellement posé dessus. La validation remplace le contenu
// de l'application par ce qui a été compté ; les écarts s'affichent.
@Component({
  selector: 'app-inventaire',
  standalone: true,
  imports: [EmplPipe, DatePipe, IonContent, IonButton, IonIcon, IonFooter, IonToolbar, ScannerComponent, EnteteComponent],
  template: `
    <app-entete titre="Inventaire" module="Magasin" retour="/menu" [etape]="!!emplacement() || !!bilan()" [confirmer]="nonEnregistre()" (precedent)="recommencer()"></app-entete>
    <ion-content class="ion-padding">
      <app-scanner
        [actif]="!envoi()"
        [attendu]="enComptage() ? 'tout' : 'emplacement'"
        [consigne]="enComptage() ? 'Ticket de chaque produit' : bilan() ? 'Emplacement suivant : son étiquette' : 'Étiquette de l\\'emplacement à compter'"
        [cible]="enComptage() ? emplacement()!.code : null"
        cibleTexte="Comptage de"
        [compteur]="enComptage() ? '' + tickets().length : null"
        [resultat]="resultat()"
        [libelleManuel]="enComptage() ? 'Contenu du ticket' : 'Code de l\\'emplacement'"
        [exempleManuel]="enComptage() ? 'ex. F0391;13000;10;202613167;1' : 'ex. D003'"
        (lecture)="lire($event)"
      ></app-scanner>

      @if (bilan(); as b) {
        <!-- 3. Emplacement validé : l'étiquette du suivant se scanne directement -->
        <section class="bilan k-carte k-apparait" [class.ecart]="b.ecarts.length">
          <span class="icone"><ion-icon [name]="b.ecarts.length ? 'alert-circle' : 'checkmark-done'"></ion-icon></span>
          <h2>{{ b.code | empl }} inventorié</h2>
          <p>{{ b.message }}</p>
          @if (b.ecarts.length) {
            <ul class="ecarts">
              @for (e of b.ecarts; track e.reference + e.lot) {
                <li><b class="mono">{{ e.reference }}</b> lot {{ e.lot }}<span>application {{ e.application }} → compté {{ e.compte }}</span></li>
              }
            </ul>
          }
        </section>
      } @else if (!emplacement()) {
        <!-- 1. Emplacement -->
        <p class="aide">Scannez l'étiquette de l'emplacement à compter. Vous verrez ce que l'application croit y trouver.</p>
      } @else {
        @if (emplacement(); as e) {
          <!-- 2. Compter : le dernier ticket lu en haut de la liste -->
          <section class="k-carte compte">
            <div class="tete"><b>Compté en {{ e.code | empl }}</b><span class="n">{{ tickets().length }}</span></div>
            @if (tickets().length) {
              <ul class="lus">
                @for (t of ticketsRecents(); track t.texte; let premier = $first) {
                  <li [class.dernier]="premier">
                    <span><b class="mono">{{ t.reference }}</b> lot {{ t.lot }}{{ t.colis ? ' · colis ' + t.colis : '' }}</span>
                    <button type="button" class="retirer" (click)="retirer(t)" aria-label="Retirer ce ticket"><ion-icon name="close-outline"></ion-icon></button>
                  </li>
                }
              </ul>
            } @else {
              <p class="vide">Scannez le ticket de chaque produit posé sur cet emplacement, puis « Valider ».</p>
            }
          </section>

          <section class="k-carte empl">
            <small>L'application croit y trouver :</small>
            @if (e.contenu.length) {
              <ul class="avant">
                @for (c of e.contenu; track c.reception_id) {
                  <li><b class="mono">{{ c.reference }}</b> lot {{ c.lot }} × {{ c.quantite }}</li>
                }
              </ul>
            } @else {
              <p class="vide">rien (emplacement vide)</p>
            }
            @if (e.inventorie_le) {
              <p class="deja">Déjà inventorié le {{ e.inventorie_le | date: 'dd/MM/yyyy à HH:mm' }} : un nouveau comptage remplace le précédent.</p>
            }
          </section>
        }
      }
    </ion-content>

    <ion-footer class="k-pied">
      <ion-toolbar>
        @if (bilan()) {
          <div class="actions">
            <ion-button class="k-btn-clair" (click)="navigation.menu()"><ion-icon slot="start" name="home-outline"></ion-icon>Menu</ion-button>
            <p class="pied-info">Scannez l'emplacement suivant</p>
          </div>
        } @else if (emplacement()) {
          <ion-button expand="block" [class.k-btn-principal]="tickets().length" [class.k-btn-clair]="!tickets().length" [disabled]="envoi()" (click)="valider()">
            <ion-icon slot="start" name="checkmark-done"></ion-icon>
            {{ tickets().length ? "Valider l'emplacement (" + tickets().length + ')' : "Valider : l'emplacement est vide" }}
          </ion-button>
        }
      </ion-toolbar>
    </ion-footer>
  `,
  styles: `
    .aide { margin: 0 0 12px; color: var(--k-gris); font-size: 14.5px; }
    .empl, .compte { margin-top: 4px; margin-bottom: 10px; padding: 14px 16px; }
    .lus li.dernier { outline: 2px solid var(--k-vert); background: var(--k-vert-clair); }
    .pied-info { flex: 1; margin: 0; align-self: center; text-align: center; font-weight: 700; color: var(--k-gris); }
    .tete { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .k-etiquette.grand { padding: 4px 16px; font-size: 32px; line-height: 1; border-left-width: 8px; border-radius: 8px; }
    .changer, .retirer { display: grid; place-items: center; width: 38px; height: 38px; font-size: 20px; color: var(--k-gris); background: var(--k-surface-2); border: 0; border-radius: 50%; }
    small { font-size: 12.5px; font-weight: 700; color: var(--k-gris); }
    .avant, .lus { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 6px; }
    .avant li { font-size: 14px; color: var(--k-texte); }
    .lus li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; font-size: 14px; background: var(--k-surface-2); border-radius: 12px; }
    .vide { margin: 6px 0 0; font-size: 14px; color: var(--k-gris); }
    .deja { margin: 8px 0 0; font-size: 13px; color: var(--k-orange); font-weight: 600; }
    .compte .tete b { font-size: 16px; color: var(--k-nuit); }
    .compte .n { font-size: 26px; font-weight: 800; color: var(--k-nuit); }
    .bilan { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 20px 16px; text-align: center; border: 2px solid var(--k-vert); }
    .bilan.ecart { border-color: var(--k-orange); }
    .bilan .icone { display: grid; place-items: center; width: 60px; height: 60px; font-size: 32px; color: #fff; background: var(--k-vert); border-radius: 50%; }
    .bilan.ecart .icone { background: var(--k-orange); }
    .bilan h2 { margin: 6px 0 0; font-size: 22px; color: var(--k-nuit); }
    .bilan p { margin: 0; color: var(--k-texte); }
    .ecarts { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; width: 100%; text-align: left; }
    .ecarts li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; padding: 8px 12px; font-size: 14px; background: var(--k-orange-clair); border-radius: 12px; }
    .actions { display: flex; gap: 10px; }
    .suivant { flex: 1; }
  `,
})
export class InventairePage {
  private controles = inject(ControlesService);
  private retour = inject(RetourService);
  readonly navigation = inject(NavigationService);

  readonly emplacement = signal<EmplacementInventaire | null>(null);
  readonly tickets = signal<TicketLu[]>([]);
  readonly bilan = signal<InventaireValide | null>(null);
  readonly envoi = signal(false);
  readonly resultat = signal<ResultatControle | null>(null);
  readonly enComptage = computed(() => !!this.emplacement() && !this.bilan());
  readonly ticketsRecents = computed(() => [...this.tickets()].reverse());
  // Tickets scannés mais pas encore validés : perdus si l'on quitte l'emplacement
  readonly nonEnregistre = computed(() => {
    const e = this.emplacement();
    const n = this.tickets().length;
    return e && n && !this.bilan()
      ? `${n} ticket(s) scanné(s) en ${e.code} ne sont pas encore enregistrés. Validez l'emplacement pour les garder.`
      : null;
  });

  constructor() {
    addIcons({ clipboardOutline, closeOutline, checkmarkDone, alertCircle, arrowForward, homeOutline });
  }

  private erreur(e: unknown, titre = 'Inventaire impossible'): void {
    this.resultat.set({ ...erreurLocale(e as HttpErrorResponse), titre });
    this.retour.signaler('rouge');
  }

  lire(l: Lecture): void {
    const e = this.emplacement();
    if (!this.enComptage() || !e) {
      this.recommencer();
      void this.lireEmplacement(l);
    } else if (estCodeEmplacement(l.texte)) {
      const code = codeEmplacement(l.texte);
      this.erreur(
        new HttpErrorResponse({
          status: 409,
          error: { message: code === e.code ? `Vous comptez déjà ${e.code} : scannez les tickets des produits, puis « Valider ».` : `Validez d'abord ${e.code} (bouton en bas) avant de compter ${code}.` },
        }),
        code === e.code ? 'Déjà en comptage' : 'Emplacement en cours'
      );
    } else this.lireTicket(l);
  }

  async lireEmplacement(l: Lecture): Promise<void> {
    const code = codeEmplacement(l.texte);
    this.retour.lu();
    if (!estCodeEmplacement(code)) {
      this.erreur(new HttpErrorResponse({ status: 400, error: { message: `« ${l.texte} » n'est pas une étiquette d'emplacement.` } }));
      return;
    }
    this.envoi.set(true);
    try {
      this.emplacement.set(await this.controles.inventaireEmplacement(code));
      this.tickets.set([]);
      this.resultat.set(null);
    } catch (e) {
      this.erreur(e);
    } finally {
      this.envoi.set(false);
    }
  }

  lireTicket(l: Lecture): void {
    this.retour.lu();
    const texte = l.texte.trim();
    if (this.tickets().some((t) => t.texte === texte)) {
      this.erreur(new HttpErrorResponse({ status: 409, error: { message: 'Ce ticket est déjà compté sur cet emplacement.' } }), 'Déjà compté');
      return;
    }
    const m = texte.split(/[;|]/).map((x) => x.trim());
    if (m.length < 3) {
      this.erreur(new HttpErrorResponse({ status: 400, error: { message: "Ticket illisible : scannez le QR du bas du ticket vert." } }));
      return;
    }
    const colis = m.length === 5 && /^\d+$/.test(m[2]) ? Number(m[2]) : null;
    const lu = { texte, reference: (m[0] ?? '').toUpperCase(), lot: m.length === 5 ? m[3] : m[1], colis };
    this.tickets.update((liste) => [...liste, lu]);
    const n = this.tickets().length;
    this.resultat.set({
      ...erreurLocale(new HttpErrorResponse({ status: 200 })), resultat: 'compte', couleur: 'vert',
      titre: `${n} compté${n > 1 ? 's' : ''} en ${this.emplacement()?.code}`,
      message: `${lu.reference} lot ${lu.lot}${colis ? ' · colis ' + colis : ''}`,
    });
    this.retour.signaler('vert');
  }

  retirer(t: TicketLu): void {
    this.tickets.update((liste) => liste.filter((x) => x !== t));
  }

  async valider(): Promise<void> {
    const e = this.emplacement();
    if (!e || this.envoi()) return;
    this.envoi.set(true);
    try {
      const b = await this.controles.validerInventaire(e.code, this.tickets().map((t) => t.texte));
      this.bilan.set(b);
      this.resultat.set(null);
      this.retour.signaler(b.ecarts.length ? 'orange' : 'vert');
    } catch (err) {
      this.erreur(err, 'Emplacement non validé');
    } finally {
      this.envoi.set(false);
    }
  }

  recommencer(): void {
    this.emplacement.set(null);
    this.tickets.set([]);
    this.bilan.set(null);
    this.resultat.set(null);
  }
}
