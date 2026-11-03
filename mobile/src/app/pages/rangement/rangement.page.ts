import { Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { locationOutline, pricetagOutline, closeOutline, checkmark, cloudOfflineOutline, gridOutline, navigate, warningOutline } from 'ionicons/icons';
import { Lecture, ScannerComponent } from '../../composants/scanner.component';
import { EnteteComponent } from '../../composants/entete.component';
import { ControlesService } from '../../services/controles.service';
import { RetourService } from '../../services/retour.service';
import { ResultatControle, codeEmplacement, estCodeEmplacement, referenceEtLot, ressembleTicket } from '../../services/modeles';
import { erreurLocale } from '../reception/reception.page';
import { EmplPipe } from '../../composants/empl.pipe';

// Sans réseau : le rangement n'est pas possible (rien n'est gardé sur le téléphone)
const HORS_LIGNE = {
  titre: 'Pas de réseau : rangement impossible',
  message: "L'emplacement de chaque colis est vérifié par le serveur. Reconnectez-vous au Wi-Fi puis rescannez le ticket. Rien n'est enregistré.",
};

// Produit scanné en 1re étape : sa lecture et l'emplacement proposé par l'API
interface ProduitARanger {
  lecture: Lecture;
  reference: string;
  lot: string;
  colis: number | null;
  proposition: ResultatControle;
}

// Contrôle 2 (comme l'export) : 1) ticket du produit → l'application indique l'emplacement,
// 2) étiquette de l'emplacement → l'API vérifie que c'est le bon.
// Une seule caméra, toujours en haut : après un résultat, le ticket du produit suivant se scanne
// tout de suite (pas de bouton à toucher) ; après un mauvais emplacement, on rescanne le bon.
@Component({
  selector: 'app-rangement',
  standalone: true,
  imports: [EmplPipe, IonContent, IonIcon, ScannerComponent, EnteteComponent],
  template: `
    <app-entete titre="Rangement" module="Import" retour="/import" [etape]="!!produit()" (precedent)="suivant()"></app-entete>
    <ion-content class="ion-padding">
      <app-scanner
        [actif]="!envoi()"
        [attendu]="mode().attendu"
        [consigne]="mode().consigne"
        [cible]="mode().cible"
        [resultat]="resultat()"
        [compteur]="ranges() ? ranges() + ' rangé' + (ranges() > 1 ? 's' : '') : null"
        [libelleManuel]="mode().cible ? 'Code de l\\'emplacement ou ticket' : 'Contenu du QR'"
        [exempleManuel]="mode().cible ? 'ex. ' + mode().cible : 'ex. F0391;13000;10;202613167;1'"
        (lecture)="lire($event)"
      ></app-scanner>

      <div class="k-etapes">
        <div class="k-etape" [class.faite]="!!produit()" [class.courante]="!produit()">
          <span class="rond">
            @if (produit()) {
              <ion-icon name="checkmark"></ion-icon>
            } @else {
              1
            }
          </span>
          <span class="txt">
            <small>Produit</small>
            <b [class.mono]="!!produit()">{{ produit()?.reference ?? 'ticket vert' }}</b>
          </span>
          @if (produit() && !resultat() && !envoi()) {
            <button type="button" class="effacer" (click)="suivant()" aria-label="Changer de produit"><ion-icon name="close-outline"></ion-icon></button>
          }
        </div>
        <div class="k-etape" [class.courante]="!!cible() && resultat()?.couleur !== 'vert'" [class.faite]="resultat()?.couleur === 'vert'">
          <span class="rond">
            @if (resultat()?.couleur === 'vert') {
              <ion-icon name="checkmark"></ion-icon>
            } @else {
              2
            }
          </span>
          <span class="txt">
            <small>{{ resultat()?.emplacement_scanne ? 'Emplacement' : 'Allez en' }}</small>
            <b class="mono">{{ (resultat()?.emplacement_scanne ?? cible()?.code | empl) || '…' }}</b>
          </span>
        </div>
      </div>
      <p class="aide">
        {{ resultat()?.couleur === 'vert' ? 'Rangé. Scannez directement le ticket du produit suivant.' : cible() ? 'Posez le produit, puis scannez l\\'étiquette de l\\'emplacement. Un autre ticket change de produit.' : 'Scannez le ticket : l\\'application indique où ranger le produit.' }}
      </p>
    </ion-content>
  `,
  styles: `
    .k-etapes { margin: 4px 0 8px; }
    .aide { margin: 0 4px; font-size: 14px; line-height: 1.4; color: var(--k-gris); }
  `,
})
export class RangementPage {
  private controles = inject(ControlesService);
  private retour = inject(RetourService);
  readonly produit = signal<ProduitARanger | null>(null);
  readonly resultat = signal<ResultatControle | null>(null);
  readonly envoi = signal(false);
  readonly ranges = signal(0); // produits rangés depuis l'ouverture de l'écran

  // Emplacement proposé par l'API pour le produit scanné
  readonly cible = computed(() => this.produit()?.proposition?.suggestion ?? null);

  // Étape 2 tant que le produit n'est pas bien rangé : étiquette de l'emplacement (ou un autre ticket)
  readonly mode = computed(() => {
    const c = this.cible();
    if (!this.produit() || !c || this.resultat()?.couleur === 'vert') {
      return { attendu: 'ticket' as const, consigne: this.produit() ? 'Produit suivant : son ticket vert' : 'Ticket du produit à ranger', cible: null };
    }
    return {
      attendu: 'tout' as const,
      consigne: this.resultat() ? `Rescannez l'étiquette de ${c.code}` : `Étiquette de ${c.code}`,
      cible: c.code,
    };
  });

  constructor() {
    addIcons({ locationOutline, pricetagOutline, closeOutline, checkmark, cloudOfflineOutline, gridOutline, navigate, warningOutline });
  }

  // La caméra lit tout : une étiquette d'emplacement contrôle le produit en cours, un ticket passe au produit suivant
  lire(l: Lecture): void {
    if (this.mode().attendu === 'tout' && estCodeEmplacement(l.texte)) {
      void this.lireEmplacement(l);
      return;
    }
    if (!ressembleTicket(l.texte) && !l.manuel) {
      this.resultat.set({ ...erreurLocale(new HttpErrorResponse({ status: 400, error: { message: "Ce QR n'est ni un ticket produit ni une étiquette d'emplacement." } })), controle: 'rangement', titre: 'QR non reconnu' });
      this.retour.signaler('rouge');
      return;
    }
    this.suivant();
    void this.lireProduit(l);
  }

  async lireProduit(l: Lecture): Promise<void> {
    if (this.envoi()) return;
    this.envoi.set(true);
    this.retour.lu();
    const { reference, lot } = referenceEtLot(l.texte);
    const morceaux = l.texte.split(/[;|]/);
    const colis = morceaux.length === 5 && /^\d+$/.test(morceaux[2].trim()) ? Number(morceaux[2]) : null;
    try {
      const proposition = await this.controles.suggestionRangement(l.texte);
      this.produit.set({ lecture: l, reference: proposition.produit?.reference ?? reference, lot: proposition.produit?.lot ?? lot, colis, proposition });
      if (!proposition.suggestion) {
        // Produit inconnu, non reçu, déjà rangé, import pas au stock… : on s'arrête là
        this.resultat.set(proposition);
        this.retour.signaler(proposition.couleur);
      }
    } catch (err) {
      const e = err as HttpErrorResponse;
      // Sans réseau, pas de rangement : l'emplacement imposé du colis doit être donné par le serveur
      this.resultat.set({ ...erreurLocale(e), controle: 'rangement', ...(e.status === 0 ? HORS_LIGNE : {}) });
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
    }
  }

  async lireEmplacement(l: Lecture): Promise<void> {
    const p = this.produit();
    if (!p || this.envoi()) return;
    this.envoi.set(true);
    this.retour.lu();
    try {
      const r = await this.controles.rangement(codeEmplacement(l.texte), p.lecture.texte, p.lecture.manuel || l.manuel);
      this.resultat.set(r);
      this.retour.signaler(r.couleur);
      if (r.couleur === 'vert') this.ranges.update((n) => n + 1);
    } catch (err) {
      const e = err as HttpErrorResponse;
      this.resultat.set({ ...erreurLocale(e), controle: 'rangement', ...(e.status === 0 ? HORS_LIGNE : {}) });
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
    }
  }

  suivant(): void {
    this.resultat.set(null);
    this.produit.set(null);
  }
}
