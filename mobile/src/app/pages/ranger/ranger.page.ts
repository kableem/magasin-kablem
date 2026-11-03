import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { IonButton, IonContent, IonFooter, IonIcon, IonSpinner, IonToolbar, ViewWillEnter } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowForward, barcodeOutline, checkmarkCircle, closeOutline, layersOutline, locationOutline, flagOutline, refreshOutline,
  shieldCheckmarkOutline, sparklesOutline,
} from 'ionicons/icons';
import { Lecture, ScannerComponent } from '../../composants/scanner.component';
import { EnteteComponent } from '../../composants/entete.component';
import { ControlesService } from '../../services/controles.service';
import { RetourService } from '../../services/retour.service';
import { NavigationService } from '../../services/navigation.service';
import {
  EmplacementARanger, LIBELLES_TYPE, MesDeplacements, ProduitARanger, ResultatControle, codeEmplacement, estCodeEmplacement,
} from '../../services/modeles';
import { erreurLocale } from '../reception/reception.page';
import { EmplPipe } from '../../composants/empl.pipe';

type Etape = 'debut' | 'depart' | 'produit' | 'arrivee';

// « Ranger le magasin » : le magasinier range librement, sans suggestion du système.
// Il scanne le produit (ticket), l'emplacement où il le prend, puis l'emplacement d'arrivée de son choix ;
// il peut aussi commencer par l'étiquette d'un emplacement (puis un produit de cet emplacement, ou toute
// la palette). L'API contrôle chaque déplacement (le produit est bien là, l'arrivée respecte les règles du
// magasin) et l'enregistre avec son matricule ; les refus sont notés aussi.
@Component({
  selector: 'app-ranger',
  standalone: true,
  imports: [EmplPipe, DatePipe, IonContent, IonButton, IonIcon, IonSpinner, IonFooter, IonToolbar, ScannerComponent, EnteteComponent],
  template: `
    <app-entete titre="Ranger le magasin" module="Magasin" retour="/menu" [etape]="etape() !== 'debut'" [confirmer]="enMain()" (precedent)="precedent()"></app-entete>
    <ion-content class="ion-padding">
      <app-scanner
        [actif]="!envoi() && !lecture()"
        [attendu]="mode().attendu"
        [consigne]="mode().consigne"
        [cible]="mode().cible"
        [cibleTexte]="mode().cibleTexte"
        [compteur]="mode().compteur"
        [resultat]="resultat()"
        [libelleManuel]="mode().attendu === 'emplacement' ? 'Code de l\\'emplacement' : 'Ticket ou emplacement'"
        [exempleManuel]="mode().attendu === 'emplacement' ? 'ex. D012' : 'ex. F0391;13000;10;202613167;1'"
        (lecture)="lire($event)"
      ></app-scanner>

      <!-- Le trajet : produit → départ → arrivée, rempli au fil des scans -->
      <section class="trajet k-carte" [attr.data-etape]="etape()">
        <div class="pas" [class.fait]="produit() || toutePalette()" [class.actif]="etape() === 'debut' || etape() === 'produit'">
          <small>Produit</small>
          @if (toutePalette() && depart(); as d) {
            <span class="icone"><ion-icon name="layers-outline"></ion-icon></span>
            <b>Toute la palette</b>
            <em>{{ d.remplissage.libelle }}</em>
          } @else if (produit(); as p) {
            <b class="mono">{{ p.info.reference }}</b>
            <em>{{ p.info.colis ? 'colis ' + p.info.colis : 'lot ' + p.info.lot }} · {{ type(p.info) }}</em>
          } @else {
            <span class="icone vide"><ion-icon name="barcode-outline"></ion-icon></span>
            <em>Ticket</em>
          }
        </div>
        <ion-icon class="fleche" name="arrow-forward"></ion-icon>
        <div class="pas" [class.fait]="depart()" [class.actif]="etape() === 'depart'">
          <small>Départ</small>
          @if (depart(); as d) {
            <span class="k-etiquette">{{ d.code | empl }}</span>
            <em>{{ d.remplissage.libelle }}</em>
          } @else {
            <span class="icone vide"><ion-icon name="location-outline"></ion-icon></span>
            <em>Étiquette</em>
          }
        </div>
        <ion-icon class="fleche" name="arrow-forward"></ion-icon>
        <div class="pas" [class.actif]="etape() === 'arrivee'">
          <small>Arrivée</small>
          <span class="icone vide"><ion-icon name="flag-outline"></ion-icon></span>
          <em>Au choix</em>
        </div>
      </section>

      <!-- Ce qu'il faut savoir à l'étape en cours -->
      @if (etape() === 'depart' && produit(); as p) {
        <section class="info k-carte k-apparait">
          <p>
            <b class="mono">{{ p.info.reference }}</b> lot {{ p.info.lot }}{{ p.info.colis ? ' · colis ' + p.info.colis : '' }}
            @if (p.info.ici) {
              est en <span class="k-etiquette">{{ p.info.ici }}</span> : scannez cette étiquette.
            } @else {
              est en stock en :
            }
          </p>
          @if (!p.info.ici) {
            <div class="places">
              @for (e of p.info.emplacements; track e.code) {
                <span class="k-etiquette">{{ e.code | empl }} <i>×{{ e.quantite }}</i></span>
              }
            </div>
          }
        </section>
      } @else if (etape() === 'produit' && depart(); as d) {
        <section class="info k-carte k-apparait">
          <p>En <span class="k-etiquette">{{ d.code | empl }}</span> : scannez le ticket du produit que vous prenez, ou déplacez toute la palette.</p>
          <ul class="contenu">
            @for (x of d.produits; track x.reference + x.lot) {
              <li><b class="mono">{{ x.reference }}</b><span>lot {{ x.lot }}</span><i>×{{ x.quantite }}</i></li>
            }
          </ul>
        </section>
      } @else if (etape() === 'arrivee') {
        <section class="info arrivee k-carte k-apparait">
          <ion-icon name="shield-checkmark-outline"></ion-icon>
          <p>
            Posez {{ toutePalette() ? 'la palette' : 'le produit' }} où vous voulez, puis scannez l'étiquette.
            L'application vérifie le niveau, la taille et la place restante{{ toutePalette() ? ' (une palette entière : emplacement vide)' : '' }}.
          </p>
        </section>
      } @else if (etape() === 'debut' && !resultat()) {
        <section class="info k-carte">
          <ion-icon name="sparkles-outline"></ion-icon>
          <p>Libérez des emplacements à votre façon : <b>ticket du produit</b>, <b>emplacement où vous le prenez</b>, puis <b>emplacement d'arrivée</b>. Chaque déplacement est contrôlé et enregistré avec votre matricule.</p>
        </section>
      }

      <!-- Ma journée : ce que j'ai rangé aujourd'hui -->
      <section class="journee">
        <h3>Aujourd'hui</h3>
        @if (journal(); as j) {
          <div class="chiffres">
            <div class="k-carte"><b>{{ j.deplacements }}</b><small>déplacement{{ j.deplacements > 1 ? 's' : '' }}</small></div>
            <div class="k-carte vert"><b>{{ j.liberes }}</b><small>emplacement{{ j.liberes > 1 ? 's' : '' }} libéré{{ j.liberes > 1 ? 's' : '' }}</small></div>
            <div class="k-carte" [class.rouge]="j.refus > 0"><b>{{ j.refus }}</b><small>refusé{{ j.refus > 1 ? 's' : '' }}</small></div>
          </div>
          @if (j.mouvements.length) {
            <ul class="mouvements">
              @for (m of j.mouvements; track m.id) {
                <li class="k-apparait">
                  <span class="heure">{{ m.date | date: 'HH:mm' }}</span>
                  <span class="quoi">
                    <b class="mono">{{ m.reference }}</b>
                    <small>{{ m.commentaire ?? (m.colis ? 'colis ' + m.colis : 'lot ' + m.lot) }}{{ m.quantite > 1 ? ' · ×' + m.quantite : '' }}</small>
                  </span>
                  <span class="chemin">
                    <span class="k-etiquette petite" [class.libre]="m.depuis_liberee">{{ m.depuis }}</span>
                    <ion-icon name="arrow-forward"></ion-icon>
                    <span class="k-etiquette petite">{{ m.vers }}</span>
                  </span>
                  @if (m.depuis_liberee) {
                    <span class="libere"><ion-icon name="checkmark-circle"></ion-icon>{{ m.depuis }} libéré</span>
                  }
                </li>
              }
            </ul>
          } @else {
            <p class="vide">Aucun déplacement aujourd'hui.</p>
          }
        } @else if (chargement()) {
          <p class="k-envoi"><ion-spinner name="crescent"></ion-spinner></p>
        }
      </section>
    </ion-content>

    @if (etape() !== 'debut') {
      <ion-footer class="k-pied">
        <ion-toolbar>
          <div class="actions">
            <ion-button class="k-btn-clair" [disabled]="envoi()" (click)="recommencer()"><ion-icon slot="start" name="close-outline"></ion-icon>Annuler</ion-button>
            @if (etape() === 'produit' && depart()?.remplissage?.n) {
              <ion-button expand="block" class="k-btn-principal large" [disabled]="envoi()" (click)="choisirToutePalette()">
                <ion-icon slot="start" name="layers-outline"></ion-icon>Toute la palette
              </ion-button>
            }
          </div>
        </ion-toolbar>
      </ion-footer>
    }
  `,
  styles: `
    .trajet { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: stretch; gap: 4px; margin: 2px 0 12px; padding: 10px; }
    .pas { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; min-width: 0; min-height: 92px; padding: 8px 4px; text-align: center; border: 1.5px dashed var(--k-bord); border-radius: 14px; transition: border-color 0.2s, background 0.2s; }
    .pas small { font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--k-gris); }
    .pas b { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; color: var(--k-nuit); }
    .pas em { max-width: 100%; font-style: normal; font-size: 11.5px; line-height: 1.2; color: var(--k-gris); }
    .pas .icone { display: grid; place-items: center; width: 34px; height: 34px; font-size: 20px; color: var(--k-marine); background: var(--k-surface-2); border-radius: 11px; }
    .pas .icone.vide { color: var(--k-gris); }
    .pas.actif { border-style: solid; border-color: var(--k-marine); background: #eef2fb; box-shadow: 0 0 0 3px rgba(14, 42, 108, 0.08); }
    .pas.fait { border-style: solid; border-color: #bfe6cf; background: var(--k-vert-clair); }
    .pas .k-etiquette { font-size: 17px; }
    .fleche { align-self: center; font-size: 18px; color: var(--k-gris); }

    .info { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; padding: 12px 14px; }
    .info p { margin: 0; font-size: 14.5px; line-height: 1.45; color: var(--k-texte); }
    .info > ion-icon { flex: none; font-size: 26px; color: var(--k-marine); }
    .info.arrivee, section.info:has(> ion-icon) { flex-direction: row; align-items: flex-start; gap: 12px; }
    .places { display: flex; flex-wrap: wrap; gap: 6px; }
    .places i { font-style: normal; font-size: 0.75em; opacity: 0.7; }
    .contenu { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
    .contenu li { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; font-size: 13.5px; background: var(--k-surface-2); border-radius: 10px; }
    .contenu span { color: var(--k-gris); }
    .contenu i { margin-left: auto; font-style: normal; font-weight: 800; color: var(--k-nuit); }

    .journee h3 { margin: 6px 2px 8px; font-size: 13px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--k-gris); }
    .chiffres { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 10px; }
    .chiffres div { display: flex; flex-direction: column; padding: 10px 12px; }
    .chiffres b { font-size: 26px; font-weight: 900; line-height: 1.1; color: var(--k-nuit); }
    .chiffres small { font-size: 12px; line-height: 1.2; color: var(--k-gris); }
    .chiffres .vert b { color: var(--k-vert); }
    .chiffres .rouge b { color: var(--k-erreur); }
    .mouvements { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .mouvements li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 4px 10px; padding: 9px 12px; background: var(--k-surface); border: 1px solid var(--k-bord); border-radius: 14px; }
    .heure { font-size: 12.5px; font-weight: 800; color: var(--k-gris); }
    .quoi { display: flex; flex-direction: column; min-width: 0; }
    .quoi b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; color: var(--k-nuit); }
    .quoi small { font-size: 12px; color: var(--k-gris); }
    .chemin { display: inline-flex; align-items: center; gap: 4px; }
    .chemin ion-icon { color: var(--k-gris); }
    .k-etiquette.petite { padding: 1px 7px; font-size: 13px; border-left-width: 4px; }
    .k-etiquette.libre { opacity: 0.55; text-decoration: line-through; }
    .libere { grid-column: 2 / 4; display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; font-weight: 700; color: var(--k-vert); }
    .vide { margin: 0; padding: 14px; text-align: center; color: var(--k-gris); background: var(--k-surface); border: 1px dashed var(--k-bord); border-radius: 14px; }

    .actions { display: flex; gap: 10px; }
    .actions ion-button { margin: 0; min-height: 52px; }
    .actions .large { flex: 1; }
  `,
})
export class RangerPage implements ViewWillEnter {
  private controles = inject(ControlesService);
  private retour = inject(RetourService);
  readonly navigation = inject(NavigationService);

  readonly produit = signal<{ qr: string; manuel: boolean; info: ProduitARanger } | null>(null);
  readonly depart = signal<EmplacementARanger | null>(null);
  // Le magasinier a commencé par l'étiquette : le départ reste choisi pour les produits suivants
  readonly departEnPremier = signal(false);
  readonly toutePalette = signal(false);
  readonly resultat = signal<ResultatControle | null>(null);
  readonly journal = signal<MesDeplacements | null>(null);
  readonly chargement = signal(false);
  readonly envoi = signal(false); // déplacement envoyé à l'API
  readonly lecture = signal(false); // produit ou emplacement en cours de lecture

  readonly etape = computed<Etape>(() => {
    const d = this.depart();
    if (d && (this.produit() || this.toutePalette())) return 'arrivee';
    if (this.produit()) return 'depart';
    return d ? 'produit' : 'debut';
  });

  // Produit en main, pas encore posé : rien n'est enregistré
  readonly enMain = computed(() =>
    this.etape() === 'arrivee' ? "Le déplacement commencé n'est pas enregistré : remettez le produit à son emplacement de départ." : null
  );

  readonly mode = computed(() => {
    const p = this.produit()?.info;
    const d = this.depart();
    switch (this.etape()) {
      case 'depart': {
        const cible = p?.ici ?? (p?.emplacements.length === 1 ? p.emplacements[0].code : null);
        return { attendu: 'emplacement' as const, consigne: `Étiquette de l'emplacement de ${p?.reference ?? 'ce produit'}`, cible, cibleTexte: 'Prenez-le en', compteur: null };
      }
      case 'produit':
        return { attendu: 'tout' as const, consigne: `Ticket du produit pris en ${d?.code}`, cible: null, cibleTexte: '', compteur: d?.code ?? null };
      case 'arrivee':
        return { attendu: 'emplacement' as const, consigne: "Étiquette de l'emplacement d'arrivée", cible: null, cibleTexte: '', compteur: d ? `${d.code} →` : null };
      default:
        return { attendu: 'tout' as const, consigne: 'Ticket du produit ou étiquette de son emplacement', cible: null, cibleTexte: '', compteur: null };
    }
  });

  constructor() {
    addIcons({
      arrowForward, barcodeOutline, checkmarkCircle, closeOutline, layersOutline, locationOutline, flagOutline, refreshOutline,
      shieldCheckmarkOutline, sparklesOutline,
    });
  }

  ionViewWillEnter(): void {
    void this.chargerJournal();
  }

  type(p: { type: keyof typeof LIBELLES_TYPE; taille_bobine: string | null; type_cosse?: string | null }): string {
    if (p.type === 'cosse' && p.type_cosse) return `Cosse ${p.type_cosse === 'axiale' ? 'axiale' : 'plate'}`;
    return LIBELLES_TYPE[p.type] + (p.taille_bobine ? ' ' + p.taille_bobine : '');
  }

  async chargerJournal(): Promise<void> {
    this.chargement.set(true);
    try {
      this.journal.set(await this.controles.mesDeplacements());
    } catch {
      // hors ligne : on garde les derniers chiffres
    } finally {
      this.chargement.set(false);
    }
  }

  // Un seul point d'entrée pour la caméra : l'étape en cours décide de ce que veut dire le QR
  lire(l: Lecture): void {
    if (this.envoi() || this.lecture()) return;
    const emplacement = estCodeEmplacement(l.texte);
    switch (this.etape()) {
      case 'arrivee':
        // un autre ticket : on change de produit (même départ si on a commencé par l'étiquette)
        if (emplacement) void this.poser(l);
        else void this.choisirProduit(l);
        break;
      case 'depart':
        if (emplacement) void this.choisirDepart(l, false);
        else void this.choisirProduit(l);
        break;
      default:
        if (emplacement) void this.choisirDepart(l, true);
        else void this.choisirProduit(l);
    }
  }

  // « Retour » et retour du téléphone : une étape en arrière
  precedent(): void {
    this.resultat.set(null);
    if (this.etape() === 'arrivee') {
      if (this.toutePalette()) this.toutePalette.set(false);
      else if (this.departEnPremier()) this.produit.set(null);
      else this.depart.set(null);
    } else if (this.etape() === 'depart') this.produit.set(null);
    else this.recommencer();
  }

  recommencer(): void {
    this.produit.set(null);
    this.depart.set(null);
    this.departEnPremier.set(false);
    this.toutePalette.set(false);
  }

  choisirToutePalette(): void {
    this.produit.set(null);
    this.toutePalette.set(true);
    this.resultat.set(null);
  }

  private refus(message: string, titre = 'Déplacement impossible'): void {
    this.resultat.set({ ...erreurLocale(new HttpErrorResponse({ status: 409, error: { message } })), controle: 'ranger', titre });
    this.retour.signaler('rouge');
  }

  // Ticket scanné : où est ce produit ?
  async choisirProduit(l: Lecture): Promise<void> {
    this.lecture.set(true);
    this.retour.lu();
    try {
      const info = await this.controles.produitARanger(l.texte);
      const d = this.depart();
      if (d && this.departEnPremier()) {
        // départ déjà choisi : le produit doit y être
        const ici = info.ici ? info.ici === d.code : info.emplacements.some((e) => e.code === d.code);
        if (!ici) {
          const ou = info.ici ?? info.emplacements.map((e) => e.code).join(', ');
          return this.refus(`${info.reference}${info.colis ? ' (colis ' + info.colis + ')' : ''} n'est pas en ${d.code} : il est en ${ou}.`, 'Pas à cet emplacement');
        }
      } else {
        this.depart.set(null);
        this.departEnPremier.set(false);
      }
      this.toutePalette.set(false);
      this.produit.set({ qr: l.texte, manuel: l.manuel, info });
      this.resultat.set(null);
    } catch (e) {
      this.resultat.set({ ...erreurLocale(e as HttpErrorResponse), controle: 'ranger', titre: 'Produit introuvable' });
      this.retour.signaler('rouge');
    } finally {
      this.lecture.set(false);
    }
  }

  // Étiquette scannée comme départ (au début, ou après le ticket du produit)
  async choisirDepart(l: Lecture, enPremier: boolean): Promise<void> {
    this.lecture.set(true);
    this.retour.lu();
    try {
      const d = await this.controles.emplacementARanger(codeEmplacement(l.texte));
      const p = this.produit()?.info;
      if (p && !enPremier) {
        const ici = p.ici ? p.ici === d.code : p.emplacements.some((e) => e.code === d.code);
        if (!ici) return this.refus(`${p.reference} n'est pas en ${d.code} : prenez-le en ${p.ici ?? p.emplacements.map((e) => e.code).join(', ')}.`, 'Pas à cet emplacement');
      } else {
        if (!d.remplissage.n) return this.refus(`${d.code} est vide : rien à prendre à cet emplacement.`, 'Emplacement vide');
        this.produit.set(null);
        this.toutePalette.set(false);
      }
      this.depart.set(d);
      this.departEnPremier.set(enPremier);
      this.resultat.set(null);
    } catch (e) {
      this.resultat.set({ ...erreurLocale(e as HttpErrorResponse), controle: 'ranger', titre: 'Emplacement inconnu' });
      this.retour.signaler('rouge');
    } finally {
      this.lecture.set(false);
    }
  }

  // Étiquette d'arrivée : l'API contrôle et enregistre le déplacement
  async poser(l: Lecture): Promise<void> {
    const d = this.depart();
    const p = this.produit();
    if (!d) return;
    this.envoi.set(true);
    this.retour.lu();
    const vers = codeEmplacement(l.texte);
    try {
      const r = this.toutePalette()
        ? await this.controles.deplacerPalette(d.code, vers, l.manuel)
        : await this.controles.deplacer(p!.qr, d.code, vers, p!.manuel || l.manuel);
      this.resultat.set(r);
      this.retour.signaler(r.couleur);
      if (r.couleur === 'vert') {
        // commencé par l'étiquette et il reste des produits : le départ reste, au ticket suivant
        if (this.departEnPremier() && r.deplacement && !r.deplacement.depuis_libre) {
          this.produit.set(null);
          this.depart.set(await this.controles.emplacementARanger(d.code));
        } else this.recommencer();
        await this.chargerJournal();
      } else if (r.resultat === 'deplacement_refuse') {
        // le refus est enregistré : on garde le produit en main, une autre arrivée peut être scannée
        await this.chargerJournal();
      }
    } catch (e) {
      this.resultat.set({ ...erreurLocale(e as HttpErrorResponse), controle: 'ranger', titre: 'Déplacement non enregistré' });
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
    }
  }
}
