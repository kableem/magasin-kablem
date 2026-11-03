import { EmplPipe } from '../../composants/empl.pipe';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { AlertController, IonButton, IonContent, IonFooter, IonIcon, IonInput, IonSpinner, IonToolbar } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  checkmark, closeOutline, qrCodeOutline, remove, add, arrowForward, alertCircle, cubeOutline, flagOutline, layersOutline, homeOutline,
} from 'ionicons/icons';
import { Lecture, ScannerComponent } from '../../composants/scanner.component';
import { ResultatComponent } from '../../composants/resultat.component';
import { EnteteComponent } from '../../composants/entete.component';
import { ExportService } from '../../services/export.service';
import { AuthService } from '../../services/auth.service';
import { RetourService } from '../../services/retour.service';
import { NavigationService } from '../../services/navigation.service';
import {
  DESTINATIONS, Destination, LIBELLES_TYPE, LignePreparation, PreparationExport, ResultatControle, referenceEtLot, codeEmplacement,
} from '../../services/modeles';

// Sortie vers la production : l'API impose le FIFO (lots et emplacements) et vérifie chaque prise.
// L'administrateur peut prendre un autre lot ou un autre emplacement de la même référence (hors FIFO).
@Component({
  selector: 'app-export',
  standalone: true,
  imports: [EmplPipe, FormsModule, DatePipe, IonContent, IonButton, IonIcon, IonInput, IonSpinner, IonFooter, IonToolbar, ScannerComponent, ResultatComponent, EnteteComponent],
  template: `
    <app-entete [titre]="prep() ? 'Sortie en cours' : 'Nouvelle sortie'" module="Export" retour="/menu" [etape]="enEtape()" (precedent)="precedent()"></app-entete>
    <ion-content class="ion-padding">
      @if (chargement()) {
        <p class="k-envoi"><ion-spinner name="crescent"></ion-spinner></p>
      } @else if (!prep()) {
        <!-- 1. Demande : le ticket du produit donne la référence, puis quantité et destination -->
        <app-scanner [fixe]="false" [actif]="!envoi()" attendu="ticket" consigne="Ticket du produit à sortir" [resultat]="resultat()" (lecture)="lireReference($event)"></app-scanner>

        <form id="demande" (ngSubmit)="preparer()">
          <label class="k-libelle" for="ref">Référence</label>
          <div class="k-champ grand">
            <ion-icon name="cube-outline"></ion-icon>
            <ion-input id="ref" name="reference" placeholder="scannée, ou tapée : ex. F0411" [(ngModel)]="reference" autocapitalize="characters" class="mono"></ion-input>
          </div>

          <label class="k-libelle">Quantité</label>
          <div class="quantite">
            <button type="button" (click)="quantite = max(1, quantite - 1)" aria-label="Moins"><ion-icon name="remove"></ion-icon></button>
            <ion-input name="quantite" type="number" inputmode="numeric" min="1" [(ngModel)]="quantite" aria-label="Quantité"></ion-input>
            <button type="button" (click)="quantite = quantite + 1" aria-label="Plus"><ion-icon name="add"></ion-icon></button>
          </div>

          <label class="k-libelle">Destination <b class="obligatoire">*</b></label>
          <div class="destinations" role="radiogroup" aria-label="Destination">
            @for (d of destinations; track d) {
              <button type="button" role="radio" [attr.aria-checked]="destination() === d" [class.actif]="destination() === d" (click)="destination.set(d)">
                <ion-icon name="flag-outline"></ion-icon>{{ d }}
              </button>
            }
          </div>

          @if (erreur()) {
            <p class="erreur k-apparait"><ion-icon name="alert-circle"></ion-icon>{{ erreur() }}</p>
          }
        </form>
        <div class="fifo">
          <ion-icon name="layers-outline"></ion-icon>
          @if (estAdmin()) {
            <p><b>FIFO proposé.</b> L'application propose les lots les plus anciens. Administrateur : vous pouvez aussi scanner un autre lot ou un autre emplacement de la même référence ; la sortie sera notée « hors FIFO ».</p>
          } @else {
            <p><b>FIFO imposé.</b> Vous choisissez quoi sortir ; l'application choisit les lots les plus anciens et vous guide d'emplacement en emplacement.</p>
          }
        </div>
      } @else {
        @if (prep(); as p) {
          @if (p.statut !== 'en_cours') {
            <app-scanner [actif]="!envoi()" attendu="ticket" consigne="Ticket de la sortie suivante" (lecture)="sortieSuivante($event)"></app-scanner>
          }
          @if (p.statut === 'en_cours') {
            <!-- 2. Sortie en cours : le scan en haut, une seule caméra (emplacement, puis produit) -->
            <app-scanner
              [actif]="!envoi()"
              [attendu]="emplacement() ? 'ticket' : 'emplacement'"
              [consigne]="emplacement() ? 'Ticket du produit pris · lot ' + (prochain()?.lot ?? '') : 'Étiquette de ' + (prochain()?.emplacement ?? 'l\\'emplacement')"
              [cible]="emplacement() ? null : (prochain()?.emplacement ?? null)"
              [compteur]="p.lignes.length - p.restants + '/' + p.lignes.length"
              [resultat]="resultat()"
              [libelleManuel]="emplacement() ? 'Contenu du QR' : 'Code de l\\'emplacement'"
              [exempleManuel]="emplacement() ? 'ex. F0391;13000;10;202613167;1' : 'ex. D011'"
              (lecture)="emplacement() ? lireProduit($event) : lireEmplacement($event)"
            ></app-scanner>
          }
          <section class="resume k-apparait" [attr.data-statut]="p.statut">
            <svg class="anneau" viewBox="0 0 44 44" aria-hidden="true">
              <circle cx="22" cy="22" r="18" class="fond-anneau"></circle>
              <circle cx="22" cy="22" r="18" class="valeur" [attr.stroke-dasharray]="113.1" [attr.stroke-dashoffset]="113.1 * (1 - avancement())"></circle>
            </svg>
            <span class="compte">{{ p.lignes.length - p.restants }}<small>/{{ p.lignes.length }}</small></span>
            <div class="infos">
              <strong class="mono">{{ p.quantite }} × {{ p.reference }}</strong>
              <small>{{ libelleType(p) }}</small>
              <span class="dest"><ion-icon name="flag-outline"></ion-icon>{{ p.destination }}</span>
            </div>
          </section>


          @if (resultat() && p.statut !== 'en_cours') {
            <app-resultat [r]="resultat()"></app-resultat>
          }

          @if (p.statut === 'en_cours') {
            <div class="k-etapes">
              <div class="k-etape" [class.faite]="!!emplacement()" [class.courante]="!emplacement()">
                <span class="rond">
                  @if (emplacement()) {
                    <ion-icon name="checkmark"></ion-icon>
                  } @else {
                    1
                  }
                </span>
                <span class="txt"><small>{{ emplacement() ? 'Emplacement' : 'Allez en' }}</small><b class="mono">{{ emplacement() ? ((emplacement()!.texte | empl) || 'sans emplacement') : ((prochain()?.emplacement | empl) || 'à scanner') }}</b></span>
                @if (emplacement()) {
                  <button type="button" class="effacer" (click)="changerEmplacement()" aria-label="Changer d'emplacement"><ion-icon name="close-outline"></ion-icon></button>
                }
              </div>
              <div class="k-etape" [class.courante]="!!emplacement()">
                <span class="rond">2</span>
                <span class="txt"><small>Produit</small><b class="mono">lot {{ prochain()?.lot }}</b></span>
              </div>
            </div>

            @if (!emplacement() && aProduitNonRange()) {
              <ion-button expand="block" class="k-btn-clair sans" (click)="sansEmplacement()">Produit non rangé (sans emplacement)</ion-button>
            }
            <button type="button" class="annuler-sortie" (click)="confirmerAnnulation()">Annuler la sortie</button>
          } @else if (p.statut === 'annulee' && resultat()?.resultat !== 'stock_modifie') {
            <p class="erreur"><ion-icon name="alert-circle"></ion-icon>Sortie annulée{{ p.motif_fin ? ' : ' + p.motif_fin : '' }}.</p>
          }

          <div class="k-section"><h2>Parcours FIFO</h2><span class="aide-ordre">du plus ancien au plus récent</span></div>
          @if (estAdmin() && p.statut === 'en_cours') {
            <p class="libre">Administrateur : scannez l'emplacement puis le ticket d'un autre lot de {{ p.reference }} pour le sortir à la place (hors FIFO).</p>
          }
          <ol class="parcours">
            @for (l of p.lignes; track l.id) {
              <li [class.fait]="l.valide" [class.courant]="!l.valide && l === prochain()">
                <span class="arret">
                  @if (l.valide) {
                    <ion-icon name="checkmark"></ion-icon>
                  } @else {
                    {{ l.ordre }}
                  }
                </span>
                <span class="k-etiquette code" [class.vide]="!l.emplacement">{{ (l.emplacement | empl) || 'non rangé' }}</span>
                <span class="detail">
                  <b class="mono">lot {{ l.lot }}</b>
                  <small>reçu le {{ l.date_reception | date: 'dd/MM/yyyy' }}</small>
                  @if (l.hors_fifo) {
                    <small class="hors-fifo">hors FIFO</small>
                  }
                </span>
                <span class="qte">
                  @if (l.preleves > 0 && !l.valide) {
                    <small class="partiel">{{ l.preleves }}/</small>
                  }
                  ×{{ l.quantite }}
                </span>
              </li>
            }
          </ol>
        }
      }
    </ion-content>

    @if (!chargement() && !prep()) {
      <ion-footer class="k-pied">
        <ion-toolbar>
          <ion-button type="submit" form="demande" expand="block" class="k-btn-rouge" [disabled]="envoi() || !reference.trim() || quantite < 1 || !destination()" (click)="preparer()">
            @if (envoi()) {
              <ion-spinner name="crescent"></ion-spinner>
            } @else {
              Préparer la sortie <ion-icon slot="end" name="arrow-forward"></ion-icon>
            }
          </ion-button>
        </ion-toolbar>
      </ion-footer>
    } @else if (prep() && prep()!.statut !== 'en_cours') {
      <ion-footer class="k-pied">
        <ion-toolbar>
          <div class="actions">
            <ion-button class="k-btn-clair" (click)="navigation.menu()"><ion-icon slot="start" name="home-outline"></ion-icon>Menu</ion-button>
            <ion-button expand="block" class="k-btn-rouge suivant" (click)="nouvelle()">Nouvelle sortie</ion-button>
          </div>
        </ion-toolbar>
      </ion-footer>
    }
  `,
  styles: `
    .actions { display: flex; gap: 10px; }
    .suivant { flex: 1; }
    .fifo { display: flex; gap: 12px; padding: 14px 16px; color: var(--k-nuit); background: linear-gradient(135deg, #fff, #fff4f3); border: 1px solid #f6d0cd; border-radius: 18px; }
    .fifo ion-icon { flex: none; font-size: 28px; color: var(--k-rouge); }
    .fifo p { margin: 0; font-size: 14.5px; line-height: 1.4; }
    .grand ion-input { font-size: 22px; font-weight: 800; }
    .fifo { margin-top: 18px; }
    .quantite { display: grid; grid-template-columns: 64px 1fr 64px; gap: 10px; }
    .quantite button { height: 64px; font-size: 28px; color: var(--k-marine); background: var(--k-surface); border: 2px solid var(--k-bord); border-radius: 18px; }
    .quantite button:active { background: var(--k-surface-2); }
    .quantite ion-input { height: 64px; --padding-start: 0; text-align: center; font-size: 30px; font-weight: 900; background: var(--k-surface); border: 2px solid var(--k-bord); border-radius: 18px; }
    .obligatoire { color: var(--k-rouge); }
    .destinations { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
    .destinations button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; height: 68px; font: inherit; font-size: 17px; font-weight: 900; color: var(--k-nuit); background: var(--k-surface); border: 2px solid var(--k-bord); border-radius: 18px; transition: all 0.15s; }
    .destinations button ion-icon { font-size: 18px; color: var(--k-gris); }
    .destinations button.actif { color: #fff; background: var(--k-degrade-rouge); border-color: var(--k-rouge-fonce); box-shadow: 0 10px 20px -12px rgba(224, 34, 34, 0.9); transform: translateY(-2px); }
    .destinations button.actif ion-icon { color: #fff; }
    .erreur { display: flex; align-items: flex-start; gap: 8px; margin: 16px 0 0; padding: 12px 14px; font-weight: 600; line-height: 1.4; color: var(--k-erreur); background: var(--k-erreur-clair); border-radius: 14px; }
    .erreur ion-icon { flex: none; font-size: 20px; margin-top: 1px; }

    .resume { position: relative; display: flex; align-items: center; gap: 14px; padding: 16px; color: #fff; background: var(--k-degrade-rouge); border-radius: 24px; box-shadow: var(--k-ombre-forte); }
    .resume[data-statut='terminee'] { background: linear-gradient(150deg, #1fa463, #0f6b3a); }
    .resume[data-statut='annulee'] { background: linear-gradient(150deg, #7b8199, #4f556c); }
    .anneau { width: 76px; height: 76px; flex: none; transform: rotate(-90deg); }
    .fond-anneau { fill: none; stroke: rgba(255, 255, 255, 0.25); stroke-width: 5; }
    .valeur { fill: none; stroke: #fff; stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset 0.5s cubic-bezier(0.2, 0.8, 0.2, 1); }
    .compte { position: absolute; left: 16px; width: 76px; text-align: center; font-size: 24px; font-weight: 900; }
    .compte small { font-size: 14px; opacity: 0.8; }
    .infos { display: flex; flex-direction: column; min-width: 0; }
    .infos strong { font-size: 24px; line-height: 1.1; }
    .infos small { font-size: 14px; opacity: 0.9; }
    .dest { display: inline-flex; align-items: center; gap: 5px; align-self: flex-start; margin-top: 6px; padding: 2px 10px; font-weight: 900; color: var(--k-rouge); background: #fff; border-radius: 999px; }
    .resume[data-statut='terminee'] .dest { color: var(--k-vert); }
    .aide-ordre { font-size: 12.5px; color: var(--k-gris); }

    .parcours { position: relative; list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .parcours::before { content: ''; position: absolute; left: 21px; top: 26px; bottom: 26px; border-left: 3px dotted #c4cbe0; }
    .parcours li { position: relative; display: grid; grid-template-columns: 44px auto 1fr auto; align-items: center; gap: 10px; min-height: 66px; padding: 8px 12px 8px 0; background: var(--k-surface); border: 2px solid var(--k-bord); border-radius: 18px; }
    .parcours li.courant { border-color: var(--k-rouge); box-shadow: 0 0 0 4px rgba(224, 34, 34, 0.12); }
    .parcours li.fait { background: #f3fbf6; border-color: #cdebd9; }
    .arret { display: grid; place-items: center; width: 34px; height: 34px; margin-left: 4px; font-weight: 900; color: #fff; background: var(--k-nuit); border-radius: 50%; box-shadow: 0 0 0 4px var(--k-surface); }
    li.courant .arret { background: var(--k-rouge); }
    li.fait .arret { background: var(--k-vert); font-size: 20px; }
    .code { font-size: 22px; }
    li.fait .code { opacity: 0.55; }
    .detail { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
    .detail b { font-size: 14px; }
    .detail small { font-size: 12.5px; color: var(--k-gris); }
    .qte { font-size: 20px; font-weight: 900; color: var(--k-nuit); }
    .partiel { font-size: 15px; color: var(--k-rouge); }
    .libre { margin: -4px 0 10px; font-size: 13.5px; line-height: 1.4; color: var(--k-gris); }
    .detail .hors-fifo { align-self: flex-start; margin-top: 3px; padding: 1px 8px; font-weight: 800; color: #8a4b00; background: #fff1d6; border-radius: 999px; }
    app-resultat { margin: 14px 0; }
    .resume + .k-etapes, .resume + app-resultat { margin-top: 14px; }
    .sans { margin-top: 12px; }
    .annuler-sortie { display: block; width: 100%; min-height: 52px; margin-top: 14px; font: inherit; font-weight: 700; color: var(--k-erreur); background: none; border: 0; }
  `,
})
export class ExportPage implements OnInit {
  private service = inject(ExportService);
  private retour = inject(RetourService);
  private alertes = inject(AlertController);
  private auth = inject(AuthService);
  readonly navigation = inject(NavigationService);
  readonly estAdmin = computed(() => this.auth.session()?.utilisateur.role === 'admin');
  readonly destinations = DESTINATIONS;

  readonly chargement = signal(true);
  readonly envoi = signal(false);
  readonly erreur = signal('');
  readonly prep = signal<PreparationExport | null>(null);
  readonly resultat = signal<ResultatControle | null>(null);
  readonly emplacement = signal<{ texte: string | null; manuel: boolean } | null>(null);
  readonly destination = signal<Destination | null>(null);
  reference = '';
  quantite = 1;
  readonly max = Math.max;

  // Prochain prélèvement dans l'ordre FIFO (le magasinier peut en faire un autre d'abord)
  readonly prochain = computed<LignePreparation | undefined>(() => this.prep()?.lignes.find((l) => !l.valide));
  readonly aProduitNonRange = computed(() => !!this.prep()?.lignes.some((l) => !l.valide && l.emplacement === null));
  readonly avancement = computed(() => {
    const p = this.prep();
    return p && p.lignes.length ? (p.lignes.length - p.restants) / p.lignes.length : 0;
  });

  // « Retour » revient à l'étape d'avant : scanner de référence ouvert, emplacement scanné, sortie finie
  readonly enEtape = computed(() => {
    const p = this.prep();
    return !!p && (p.statut !== 'en_cours' || !!this.emplacement());
  });

  constructor() {
    addIcons({ checkmark, closeOutline, qrCodeOutline, remove, add, arrowForward, alertCircle, cubeOutline, flagOutline, layersOutline, homeOutline });
  }

  // Une sortie commencée est reprise (application fermée, téléphone éteint…)
  async ngOnInit(): Promise<void> {
    try {
      this.prep.set(await this.service.enCours());
    } catch (e) {
      this.erreur.set(this.messageErreur(e as HttpErrorResponse));
    } finally {
      this.chargement.set(false);
    }
  }

  libelleType(p: PreparationExport): string {
    return p.type ? LIBELLES_TYPE[p.type] + (p.taille_bobine ? ' · ' + p.taille_bobine : '') : '';
  }

  // Ticket scanné dans le formulaire : on garde la référence (le lot est choisi par le FIFO)
  lireReference(l: Lecture): void {
    this.retour.lu();
    this.reference = referenceEtLot(l.texte).reference;
    this.erreur.set('');
    this.resultat.set({
      uuid: '', controle: 'export', resultat: 'reference_lue', couleur: 'vert', titre: `Référence ${this.reference}`,
      message: 'Choisissez la quantité et la destination, puis « Préparer la sortie ».', produit: null, quantite_ticket: null,
      quantite_attendue: null, ecart: null, emplacements_prevus: [], emplacement_scanne: null, saisie_manuelle: l.manuel, date: new Date().toISOString(),
    });
    this.retour.signaler('vert');
  }

  // Sortie finie : le ticket scanné prépare tout de suite la demande suivante
  sortieSuivante(l: Lecture): void {
    this.nouvelle();
    this.lireReference(l);
  }

  async preparer(): Promise<void> {
    const d = this.destination();
    if (!d || this.envoi() || !this.reference.trim()) return;
    this.envoi.set(true);
    this.erreur.set('');
    try {
      this.prep.set(await this.service.preparer(this.reference.trim().toUpperCase(), Number(this.quantite), d));
      this.resultat.set(null);
      this.emplacement.set(null);
    } catch (e) {
      this.erreur.set(this.messageErreur(e as HttpErrorResponse));
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
    }
  }

  lireEmplacement(l: Lecture): void {
    this.retour.lu();
    this.resultat.set(null);
    this.emplacement.set({ texte: codeEmplacement(l.texte), manuel: l.manuel });
  }

  sansEmplacement(): void {
    this.resultat.set(null);
    this.emplacement.set({ texte: null, manuel: true });
  }

  changerEmplacement(): void {
    this.emplacement.set(null);
  }

  async lireProduit(l: Lecture): Promise<void> {
    const p = this.prep();
    const e = this.emplacement();
    if (!p || !e || this.envoi()) return;
    this.envoi.set(true);
    this.retour.lu();
    try {
      const r = await this.service.scanner(p.id, e.texte, l.texte, e.manuel || l.manuel);
      this.resultat.set(r);
      if (r.preparation) this.prep.set(r.preparation);
      this.retour.signaler(r.couleur);
      // Bon prélèvement : on passe à l'emplacement suivant, sauf s'il est au même endroit (pas besoin de
      // rescanner l'étiquette). Mauvais produit : on reste au même emplacement.
      const suivant = this.prochain();
      const memePlace = r.couleur === 'vert' && !!e.texte && suivant?.emplacement === e.texte;
      if (r.resultat !== 'mauvais_produit' && !memePlace) this.emplacement.set(null);
    } catch (err) {
      this.resultat.set({
        uuid: '', controle: 'export', resultat: 'erreur', couleur: 'rouge', titre: 'Contrôle impossible',
        message: this.messageErreur(err as HttpErrorResponse), produit: null, quantite_ticket: null, quantite_attendue: null,
        ecart: null, emplacements_prevus: [], emplacement_scanne: null, saisie_manuelle: false, date: new Date().toISOString(),
      });
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
    }
  }

  async confirmerAnnulation(): Promise<void> {
    const p = this.prep();
    if (!p) return;
    const alerte = await this.alertes.create({
      header: 'Annuler la sortie ?',
      message: 'Rien ne sortira du stock. Remettez en place les produits déjà pris.',
      buttons: [
        { text: 'Continuer la sortie', role: 'cancel' },
        { text: 'Annuler la sortie', role: 'destructive', handler: () => this.annuler(p.id) },
      ],
    });
    await alerte.present();
  }

  private async annuler(id: number): Promise<void> {
    try {
      this.prep.set(await this.service.annuler(id));
      this.resultat.set(null);
      this.emplacement.set(null);
    } catch (e) {
      this.erreur.set(this.messageErreur(e as HttpErrorResponse));
    }
  }

  precedent(): void {
    const p = this.prep();
    if (p && p.statut !== 'en_cours') this.nouvelle();
    else this.changerEmplacement();
  }

  nouvelle(): void {
    this.prep.set(null);
    this.resultat.set(null);
    this.emplacement.set(null);
    this.erreur.set('');
    this.reference = '';
    this.quantite = 1;
    this.destination.set(null);
  }

  private messageErreur(e: HttpErrorResponse): string {
    if (e.status === 0 || (e.status >= 500 && !e.error?.message)) return 'Pas de réseau : la sortie demande le Wi-Fi. Réessayez.';
    return e.error?.message ?? `Erreur ${e.status}`;
  }
}
