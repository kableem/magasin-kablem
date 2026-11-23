import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { AlertController, IonButton, IonContent, IonFooter, IonIcon, IonInput, IonSpinner, IonToolbar } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { alertCircle, checkmark, flagOutline, flash, homeOutline, keyOutline, lockClosedOutline, personOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { Lecture, ScannerComponent } from '../../composants/scanner.component';
import { ResultatComponent } from '../../composants/resultat.component';
import { EnteteComponent } from '../../composants/entete.component';
import { EmplPipe, NumerosPipe } from '../../composants/empl.pipe';
import { AuthService } from '../../services/auth.service';
import { ExportService } from '../../services/export.service';
import { RetourService } from '../../services/retour.service';
import { NavigationService } from '../../services/navigation.service';
import { UrgenceService, SortieUrgente, Autorisation } from '../../services/urgence.service';
import { Couleur, DESTINATIONS, Destination, LIBELLES_TYPE, ResultatControle, codeEmplacement } from '../../services/modeles';
import { erreurLocale } from '../reception/reception.page';

// Sortie urgente : la production attend une pièce pendant la réception de son import.
//   1. ticket du colis + destination : contrôlé comme à la réception ; même référence déjà en stock → accord du chef (FIFO)
//   2. l'application indique l'emplacement vide le plus proche de la porte : le colis y est posé (scan de l'étiquette)
//   3. emplacement puis ticket : le colis sort vers la production
// Tout est vérifié par le serveur : la sortie urgente demande le Wi-Fi.
@Component({
  selector: 'app-urgence',
  standalone: true,
  imports: [FormsModule, IonContent, IonButton, IonIcon, IonInput, IonSpinner, IonFooter, IonToolbar, ScannerComponent, ResultatComponent, EnteteComponent, EmplPipe, NumerosPipe],
  template: `
    <app-entete titre="Sortie urgente" module="Export" retour="/menu" [etape]="enEtape()" (precedent)="precedent()"></app-entete>
    <ion-content class="ion-padding">
      @if (chargement()) {
        <p class="k-envoi"><ion-spinner name="crescent"></ion-spinner></p>
      } @else if (!urgence()) {
        <!-- 1. Ticket du colis et destination -->
        <section class="intro k-apparait">
          <ion-icon name="flash"></ion-icon>
          <p><b>La production attend ?</b> Choisissez la destination et scannez le ticket du colis : il est contrôlé, posé près de la porte, puis sorti.</p>
        </section>

        <label class="k-libelle">Destination <b class="obligatoire">*</b></label>
        <div class="destinations" role="radiogroup" aria-label="Destination">
          @for (d of destinations; track d) {
            <button type="button" role="radio" [attr.aria-checked]="destination() === d" [class.actif]="destination() === d" (click)="choisirDestination(d)">
              <ion-icon name="flag-outline"></ion-icon>{{ d }}
            </button>
          }
        </div>

        <app-scanner [fixe]="false" [actif]="!envoi()" attendu="ticket" consigne="Ticket du colis à sortir" [resultat]="resultat()" (lecture)="lireTicket($event)"></app-scanner>

        @if (fifo(); as message) {
          <section class="fifo k-apparait">
            <h2><ion-icon name="shield-checkmark-outline"></ion-icon>Accord du chef nécessaire</h2>
            <p>{{ message | numeros }}</p>
            @if (gestionnaire()) {
              <ion-button expand="block" class="k-btn-rouge" [disabled]="envoi()" (click)="autoriser()">J'autorise la sortie (hors FIFO)</ion-button>
            } @else {
              <form (ngSubmit)="autoriser()">
                <div class="k-champ">
                  <ion-icon name="person-outline"></ion-icon>
                  <ion-input name="matricule" placeholder="Matricule du chef" [(ngModel)]="matriculeChef" inputmode="numeric" autocomplete="off"></ion-input>
                </div>
                <div class="k-champ">
                  <ion-icon name="lock-closed-outline"></ion-icon>
                  <ion-input name="mdp" type="password" placeholder="Son mot de passe" [(ngModel)]="motDePasseChef" autocomplete="off"></ion-input>
                </div>
                <ion-button type="submit" expand="block" class="k-btn-rouge" [disabled]="envoi() || !matriculeChef.trim() || !motDePasseChef">
                  <ion-icon slot="start" name="key-outline"></ion-icon>Autoriser la sortie
                </ion-button>
              </form>
            }
            <button type="button" class="lien" (click)="nouvelle()">Ne pas sortir ce colis</button>
          </section>
        }
      } @else {
        @if (urgence(); as u) {
          <!-- Le colis et sa destination -->
          <section class="resume k-apparait" [attr.data-statut]="u.statut">
            <span class="bulle"><ion-icon [name]="u.statut === 'sortie' ? 'checkmark' : 'flash'"></ion-icon></span>
            <div class="infos">
              <strong class="mono">{{ u.reference }}</strong>
              <small>colis n° {{ u.colis }} · lot {{ u.lot }} · {{ libelleType(u) }}</small>
              <span class="dest"><ion-icon name="flag-outline"></ion-icon>{{ u.destination }}</span>
            </div>
          </section>
          @if (u.autorise_par) {
            <p class="hors-fifo">Hors FIFO · autorisée par {{ u.autorise_par }} ({{ u.stock_existant }} déjà en stock)</p>
          }

          @if (u.statut === 'a_poser') {
            <!-- 2. Poser le colis à l'emplacement proposé -->
            <app-scanner
              [actif]="!envoi()"
              attendu="emplacement"
              [cible]="u.emplacement_propose"
              [consigne]="'Étiquette de ' + (u.emplacement_propose | empl)"
              [resultat]="resultat()"
              (lecture)="poser($event)"
            ></app-scanner>
            <div class="place k-apparait">
              <small>Posez le colis en</small>
              <b class="mono">{{ u.emplacement_propose | empl }}</b>
              <span>l'emplacement vide le plus proche de la porte</span>
            </div>
          } @else if (u.statut === 'posee') {
            <!-- 3. Sortir : l'emplacement puis le ticket, comme une sortie normale -->
            <app-scanner
              [actif]="!envoi()"
              [attendu]="emplacementLu() ? 'ticket' : 'emplacement'"
              [cible]="emplacementLu() ? null : u.emplacement"
              [consigne]="emplacementLu() ? 'Ticket du colis n° ' + u.colis : 'Étiquette de ' + (u.emplacement | empl)"
              [resultat]="resultat()"
              (lecture)="emplacementLu() ? sortir($event) : lireEmplacement($event)"
            ></app-scanner>
          }

          @if (u.statut === 'a_poser' || u.statut === 'posee') {
            <div class="k-etapes">
              <div class="k-etape" [class.faite]="u.statut === 'posee'" [class.courante]="u.statut === 'a_poser'">
                <span class="rond">
                  @if (u.statut === 'posee') {
                    <ion-icon name="checkmark"></ion-icon>
                  } @else {
                    1
                  }
                </span>
                <span class="txt"><small>{{ u.statut === 'posee' ? 'Posé en' : 'Poser en' }}</small><b class="mono">{{ (u.emplacement ?? u.emplacement_propose) | empl }}</b></span>
              </div>
              <div class="k-etape" [class.courante]="u.statut === 'posee'">
                <span class="rond">2</span>
                <span class="txt"><small>Sortir vers</small><b class="mono">{{ u.destination }}</b></span>
              </div>
            </div>
            <button type="button" class="annuler" (click)="confirmerAnnulation()">Annuler la sortie urgente</button>
          } @else {
            @if (resultat()) {
              <app-resultat [r]="resultat()"></app-resultat>
            }
          }
        }
      }
    </ion-content>

    @if (urgence() && urgence()!.statut !== 'a_poser' && urgence()!.statut !== 'posee') {
      <ion-footer class="k-pied">
        <ion-toolbar>
          <div class="actions">
            <ion-button class="k-btn-clair" (click)="navigation.menu()"><ion-icon slot="start" name="home-outline"></ion-icon>Menu</ion-button>
            <ion-button expand="block" class="k-btn-rouge suivant" (click)="nouvelle()">Autre sortie urgente</ion-button>
          </div>
        </ion-toolbar>
      </ion-footer>
    }
  `,
  styles: `
    .intro { display: flex; gap: 12px; padding: 14px 16px; color: #fff; background: var(--k-degrade-rouge); border-radius: 20px; box-shadow: var(--k-ombre-forte); }
    .intro ion-icon { flex: none; font-size: 30px; }
    .intro p { margin: 0; font-size: 15px; line-height: 1.4; }
    .obligatoire { color: var(--k-rouge); }
    .destinations { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 16px; }
    .destinations button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; height: 64px; font: inherit; font-size: 17px; font-weight: 900; color: var(--k-nuit); background: var(--k-surface); border: 2px solid var(--k-bord); border-radius: 18px; transition: all 0.15s; }
    .destinations button ion-icon { font-size: 18px; color: var(--k-gris); }
    .destinations button.actif { color: #fff; background: var(--k-degrade-rouge); border-color: var(--k-rouge-fonce); transform: translateY(-2px); }
    .destinations button.actif ion-icon { color: #fff; }

    .fifo { margin-top: 16px; padding: 16px; background: var(--k-orange-clair); border: 2px solid #f3c98a; border-radius: 20px; }
    .fifo h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 18px; color: #7a4a00; }
    .fifo p { margin: 0 0 12px; font-size: 14.5px; line-height: 1.4; color: var(--k-nuit); }
    .fifo .k-champ { margin-bottom: 10px; }
    .lien { display: block; width: 100%; min-height: 46px; margin-top: 6px; font: inherit; font-weight: 700; color: var(--k-gris); background: none; border: 0; }

    .resume { display: flex; align-items: center; gap: 14px; padding: 16px; color: #fff; background: var(--k-degrade-rouge); border-radius: 24px; box-shadow: var(--k-ombre-forte); }
    .resume[data-statut='sortie'] { background: linear-gradient(150deg, #1fa463, #0f6b3a); }
    .resume[data-statut='annulee'] { background: linear-gradient(150deg, #7b8199, #4f556c); }
    .bulle { display: grid; place-items: center; width: 60px; height: 60px; flex: none; font-size: 32px; color: var(--k-rouge); background: #fff; border-radius: 20px; }
    .resume[data-statut='sortie'] .bulle { color: var(--k-vert); }
    .infos { display: flex; flex-direction: column; min-width: 0; }
    .infos strong { font-size: 26px; line-height: 1.1; }
    .infos small { font-size: 14px; opacity: 0.92; }
    .dest { display: inline-flex; align-items: center; gap: 5px; align-self: flex-start; margin-top: 6px; padding: 2px 10px; font-weight: 900; color: var(--k-rouge); background: #fff; border-radius: 999px; }
    .hors-fifo { margin: 10px 4px 0; padding: 6px 12px; font-size: 13.5px; font-weight: 700; color: #8a4b00; background: #fff1d6; border-radius: 12px; }
    app-scanner { display: block; margin-top: 14px; }

    .place { display: flex; flex-direction: column; align-items: center; margin: 4px 0 14px; padding: 14px; text-align: center; background: var(--k-surface); border: 3px dashed var(--k-rouge); border-radius: 22px; }
    .place small { font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--k-gris); }
    .place b { font-size: 44px; font-weight: 900; line-height: 1.1; color: var(--k-nuit); }
    .place span { font-size: 13.5px; color: var(--k-gris); }
    .annuler { display: block; width: 100%; min-height: 52px; margin-top: 4px; font: inherit; font-weight: 700; color: var(--k-erreur); background: none; border: 0; }
    app-resultat { display: block; margin-top: 14px; }
    .actions { display: flex; gap: 10px; }
    .suivant { flex: 1; }
  `,
})
export class UrgencePage implements OnInit {
  private service = inject(UrgenceService);
  private exports = inject(ExportService);
  private retour = inject(RetourService);
  private alertes = inject(AlertController);
  private auth = inject(AuthService);
  readonly navigation = inject(NavigationService);
  readonly destinations = DESTINATIONS;
  readonly gestionnaire = computed(() => ['admin', 'chef_magasin'].includes(this.auth.session()?.utilisateur.role ?? ''));

  readonly chargement = signal(true);
  readonly envoi = signal(false);
  readonly urgence = signal<SortieUrgente | null>(null);
  readonly resultat = signal<ResultatControle | null>(null);
  readonly destination = signal<Destination | null>(null);
  readonly ticket = signal<Lecture | null>(null); // ticket scanné à la 1re étape
  readonly fifo = signal<string | null>(null); // même référence en stock : message, en attendant l'accord du chef
  readonly emplacementLu = signal<Lecture | null>(null); // 3e étape : étiquette scannée avant le ticket
  matriculeChef = '';
  motDePasseChef = '';

  readonly enEtape = computed(() => !!this.urgence() && (this.urgence()!.statut === 'sortie' || this.urgence()!.statut === 'annulee' || !!this.emplacementLu()));

  constructor() {
    addIcons({ alertCircle, checkmark, flagOutline, flash, homeOutline, keyOutline, lockClosedOutline, personOutline, shieldCheckmarkOutline });
  }

  // Une sortie urgente commencée est reprise (application fermée, téléphone éteint…)
  async ngOnInit(): Promise<void> {
    try {
      const r = await this.service.enCours();
      this.urgence.set(r.urgence);
      // message : une autre sortie est en cours, ou la sortie urgente a été annulée (import entré au stock avant la pose)
      if (r.message) this.resultat.set(this.local('orange', r.urgence ? 'Sortie en attente' : 'Sortie urgente annulée', r.message));
    } catch (e) {
      this.resultat.set(this.erreur(e as HttpErrorResponse));
    } finally {
      this.chargement.set(false);
    }
  }

  libelleType(u: SortieUrgente): string {
    return LIBELLES_TYPE[u.type] + (u.taille_bobine ? ' ' + u.taille_bobine : '');
  }

  lireTicket(l: Lecture): void {
    this.retour.lu();
    this.ticket.set(l);
    this.fifo.set(null);
    if (!this.destination()) {
      this.resultat.set(this.local('orange', 'Ticket lu', 'Choisissez maintenant la destination (P1, P2, P3, CET ou MCW) : la sortie urgente continue toute seule.'));
      this.retour.signaler('orange');
      return;
    }
    void this.demander();
  }

  choisirDestination(d: Destination): void {
    this.destination.set(d);
    if (this.ticket() && !this.fifo()) void this.demander();
  }

  autoriser(): void {
    if (this.gestionnaire()) void this.demander('moi');
    else void this.demander({ matricule: this.matriculeChef.trim(), mot_de_passe: this.motDePasseChef });
  }

  private async demander(autorisation?: Autorisation): Promise<void> {
    const t = this.ticket();
    const d = this.destination();
    if (!t || !d || this.envoi()) return;
    this.envoi.set(true);
    try {
      const r = await this.service.demander(t.texte, d, t.manuel, autorisation);
      this.urgence.set(r.urgence);
      this.fifo.set(null);
      this.motDePasseChef = '';
      this.resultat.set(this.local('vert', 'Colis contrôlé', r.message));
      this.retour.signaler('vert');
    } catch (err) {
      const e = err as HttpErrorResponse;
      if (e.error?.code === 'autorisation_requise') {
        this.fifo.set(e.error.message);
        this.resultat.set(this.local('orange', 'Déjà en stock : FIFO', 'Accord du chef nécessaire (ci-dessous).'));
        this.retour.signaler('orange');
      } else {
        if (e.error?.code !== 'autorisation_refusee') this.fifo.set(null);
        this.resultat.set(this.erreur(e));
        this.retour.signaler('rouge');
      }
    } finally {
      this.envoi.set(false);
    }
  }

  async poser(l: Lecture): Promise<void> {
    const u = this.urgence();
    if (!u || this.envoi()) return;
    this.envoi.set(true);
    this.retour.lu();
    try {
      const r = await this.service.poser(u.id, codeEmplacement(l.texte), l.manuel);
      this.resultat.set(r);
      if (r.urgence) this.urgence.set(r.urgence);
      this.retour.signaler(r.couleur);
    } catch (err) {
      this.resultat.set(this.erreur(err as HttpErrorResponse));
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
    }
  }

  lireEmplacement(l: Lecture): void {
    this.retour.lu();
    this.resultat.set(null);
    this.emplacementLu.set(l);
  }

  async sortir(l: Lecture): Promise<void> {
    const u = this.urgence();
    const e = this.emplacementLu();
    if (!u?.preparation_id || !e || this.envoi()) return;
    this.envoi.set(true);
    this.retour.lu();
    try {
      const r = await this.exports.scanner(u.preparation_id, codeEmplacement(e.texte), l.texte, e.manuel || l.manuel);
      this.resultat.set(r);
      this.retour.signaler(r.couleur);
      if (r.resultat === 'sortie_terminee') this.urgence.set({ ...u, statut: 'sortie', export_id: r.export_id ?? null });
      else if (r.resultat === 'preparation_close' || r.resultat === 'stock_modifie') await this.recharger();
      else if (r.resultat !== 'mauvais_produit') this.emplacementLu.set(null); // mauvais emplacement : on le rescanne
    } catch (err) {
      this.resultat.set(this.erreur(err as HttpErrorResponse));
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
    }
  }

  // La sortie préparée a changé (expirée, annulée depuis « Export ») : le serveur la refait si le colis est à sa place
  private async recharger(): Promise<void> {
    this.emplacementLu.set(null);
    try {
      const r = await this.service.enCours();
      if (r.urgence) this.urgence.set(r.urgence);
      if (r.message) this.resultat.set(this.local('orange', 'Sortie en attente', r.message));
    } catch {
      // l'erreur du scan reste affichée
    }
  }

  async confirmerAnnulation(): Promise<void> {
    const u = this.urgence();
    if (!u) return;
    const alerte = await this.alertes.create({
      header: 'Annuler la sortie urgente ?',
      message: u.statut === 'posee'
        ? 'Le colis ne sort pas : il reste au stock à son emplacement.'
        : 'Le colis ne sort pas : il reste reçu et sera rangé avec son import.',
      buttons: [
        { text: 'Continuer', role: 'cancel' },
        { text: 'Annuler la sortie', role: 'destructive', handler: () => void this.annuler(u.id) },
      ],
    });
    await alerte.present();
  }

  private async annuler(id: number): Promise<void> {
    try {
      const r = await this.service.annuler(id);
      this.urgence.set(r.urgence);
      this.emplacementLu.set(null);
      this.resultat.set(this.local('orange', 'Sortie urgente annulée', r.message));
    } catch (e) {
      this.resultat.set(this.erreur(e as HttpErrorResponse));
    }
  }

  precedent(): void {
    const u = this.urgence();
    if (u && (u.statut === 'sortie' || u.statut === 'annulee')) this.nouvelle();
    else this.emplacementLu.set(null);
  }

  nouvelle(): void {
    this.urgence.set(null);
    this.resultat.set(null);
    this.ticket.set(null);
    this.fifo.set(null);
    this.emplacementLu.set(null);
    this.matriculeChef = '';
    this.motDePasseChef = '';
  }

  private local(couleur: Couleur, titre: string, message: string): ResultatControle {
    return { ...erreurLocale(new HttpErrorResponse({ status: 200 })), controle: 'export', resultat: 'urgence', couleur, titre, message };
  }

  private erreur(e: HttpErrorResponse): ResultatControle {
    if (e.status === 0 || (e.status >= 500 && !e.error?.message)) {
      return this.local('rouge', 'Pas de réseau', 'La sortie urgente demande le Wi-Fi : tout est vérifié par le serveur. Reconnectez-vous puis rescannez. Rien n’est enregistré.');
    }
    return { ...erreurLocale(e), controle: 'export', titre: 'Sortie refusée' };
  }
}
