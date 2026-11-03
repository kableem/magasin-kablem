import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { IonContent, IonIcon, IonInput, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { searchOutline, qrCodeOutline, locationOutline, cubeOutline, alertCircle, checkmarkCircle, closeCircle, ellipseOutline } from 'ionicons/icons';
import { Lecture, ScannerComponent } from '../../composants/scanner.component';
import { EnteteComponent } from '../../composants/entete.component';
import { ControlesService } from '../../services/controles.service';
import { ContenuEmplacement, LIBELLES_STATUT, LIBELLES_TYPE, LigneProduit, codeEmplacement, estCodeEmplacement, referenceEtLot } from '../../services/modeles';
import { EmplPipe } from '../../composants/empl.pipe';

type Mode = 'emplacement' | 'produit';

@Component({
  selector: 'app-consulter',
  standalone: true,
  imports: [EmplPipe, FormsModule, DatePipe, IonContent, IonInput, IonIcon, IonSpinner, ScannerComponent, EnteteComponent],
  template: `
    <app-entete titre="Consulter" module="Import" retour="/import"></app-entete>
    <ion-content class="ion-padding">
      <!-- Le QR décide : étiquette d’emplacement → son contenu ; ticket → où est le produit -->
      <app-scanner [actif]="!chargement()" consigne="Étiquette ou ticket : scannez" libelleManuel="Étiquette ou ticket" exempleManuel="ex. D011" (lecture)="lu($event)"></app-scanner>

      <div class="bascule" role="tablist">
        <span class="curseur" [class.droite]="mode() === 'produit'"></span>
        <button type="button" role="tab" [class.actif]="mode() === 'emplacement'" (click)="changerMode('emplacement')"><ion-icon name="location-outline"></ion-icon>Emplacement</button>
        <button type="button" role="tab" [class.actif]="mode() === 'produit'" (click)="changerMode('produit')"><ion-icon name="cube-outline"></ion-icon>Produit</button>
      </div>

      <form class="recherche" (ngSubmit)="chercher()">
        <div class="k-champ">
          <ion-icon name="search-outline"></ion-icon>
          <ion-input
            [placeholder]="mode() === 'emplacement' ? 'Code, ex. D011' : 'Référence, ex. F0411'"
            name="texte"
            [(ngModel)]="texte"
            autocapitalize="characters"
            class="mono"
            enterkeyhint="search"
          ></ion-input>
        </div>
      </form>

      @if (chargement()) {
        <p class="k-envoi"><ion-spinner name="crescent"></ion-spinner> Recherche…</p>
      }
      @if (erreur()) {
        <p class="erreur k-apparait"><ion-icon name="alert-circle"></ion-icon>{{ erreur() }}</p>
      }

      @if (contenu(); as c) {
        <section class="fiche k-carte k-apparait">
          <header>
            <span class="k-etiquette code">{{ c.code | empl }}</span>
            <span class="niveau">{{ c.tampon ? 'Zone tampon' : 'Niveau ' + c.niveau }}</span>
            <span class="etat" [class.libre]="!c.produits.length">{{ c.produits.length ? 'Occupé' : 'Libre' }}</span>
          </header>
          @if (!c.produits.length) {
            <p class="vide">Aucun produit à cet emplacement.</p>
          }
          @for (p of c.produits; track $index) {
            <div class="produit">
              <span class="ref mono">{{ p.reference }}</span>
              <span class="qte">×{{ p.quantite }}</span>
              <span class="ligne2">
                <span [class]="'k-pastille ' + p.type">{{ types[p.type] }}{{ p.taille_bobine ? ' · ' + p.taille_bobine : '' }}</span>
                lot <b class="mono">{{ p.lot }}</b> · {{ p.date_reception | date: 'dd/MM/yyyy' }}
                @if (p.colis?.length) {
                  <span class="numeros">Colis
                    @for (n of p.colis; track n) {
                      <i>{{ n }}</i>
                    }
                  </span>
                }
              </span>
            </div>
          }
          @if (c.controles.length) {
            <h3>Derniers scans ici</h3>
            <ul class="scans">
              @for (k of c.controles; track $index) {
                <li [class.rouge]="k.resultat === 'faux_emplacement' || k.resultat === 'mauvais_produit'">
                  <ion-icon [name]="k.resultat === 'bon_emplacement' || k.resultat === 'prelevement_ok' || k.resultat === 'sortie_terminee' ? 'checkmark-circle' : k.resultat === 'faux_emplacement' || k.resultat === 'mauvais_produit' ? 'close-circle' : 'ellipse-outline'"></ion-icon>
                  <span><b class="mono">{{ k.reference }}</b> {{ libelleScan(k.resultat) }}<small>{{ k.date | date: 'dd/MM HH:mm' }} · {{ k.par }}</small></span>
                </li>
              }
            </ul>
          }
        </section>
      }

      @if (lignes(); as l) {
        @if (!l.length) {
          <p class="vide centre">Aucune ligne d'import pour cette référence.</p>
        }
        @for (p of l; track p.id) {
          <section class="fiche k-carte k-apparait">
            <header>
              <span class="ref-grande mono">{{ p.reference }}</span>
              <span class="statut" [attr.data-statut]="p.statut">{{ statuts[p.statut] }}</span>
            </header>
            <div class="infos">
              <span [class]="'k-pastille ' + p.type">{{ types[p.type] }}{{ p.taille_bobine ? ' · ' + p.taille_bobine : '' }}</span>
              <span>lot <b class="mono">{{ p.lot }}</b></span>
              <span>×<b>{{ p.quantite }}</b></span>
              @if (p.nb_recus > 0) {
                <span class="avancement"><b>{{ p.nb_recus }}</b>/{{ p.quantite }} reçus · <b>{{ p.nb_ranges }}</b> rangés</span>
              }
            </div>
            <p class="import">Import n° {{ p.import_id }}{{ p.numero_livraison ? ' · ' + p.numero_livraison : '' }} · {{ p.statut_import === 'ajoute' ? 'réception validée' : 'en attente' }}</p>
            @if (p.emplacements.length) {
              <div class="empl">
                @for (e of p.emplacements; track $index) {
                  <span class="k-etiquette" [class.vide]="!e.code">{{ (e.code | empl) || 'non rangé' }} <em>×{{ e.quantite }}</em></span>
                }
              </div>
            }
          </section>
        }
      }
    </ion-content>
  `,
  styles: `
    .bascule { position: relative; display: grid; grid-template-columns: 1fr 1fr; padding: 5px; background: #e1e5ef; border-radius: 18px; }
    .curseur { position: absolute; top: 5px; bottom: 5px; left: 5px; width: calc(50% - 5px); background: var(--k-surface); border-radius: 14px; box-shadow: 0 6px 14px -8px rgba(6, 22, 58, 0.5); transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1); }
    .curseur.droite { transform: translateX(100%); }
    .bascule button { position: relative; display: flex; align-items: center; justify-content: center; gap: 6px; height: 48px; font: inherit; font-size: 16px; font-weight: 700; color: var(--k-gris); background: none; border: 0; }
    .bascule button.actif { color: var(--k-nuit); }
    .recherche { margin-top: 12px; }
    .erreur { display: flex; align-items: center; gap: 8px; margin: 14px 0 0; padding: 12px 14px; font-weight: 600; color: var(--k-erreur); background: var(--k-erreur-clair); border-radius: 14px; }
    .fiche { margin-top: 14px; padding: 16px; }
    .fiche header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .code { font-size: 30px; }
    .niveau { font-weight: 700; color: var(--k-gris); }
    .etat { margin-left: auto; padding: 3px 12px; font-size: 13px; font-weight: 700; color: #b81818; background: #fde8e8; border-radius: 999px; }
    .etat.libre { color: var(--k-vert); background: var(--k-vert-clair); }
    .vide { color: var(--k-gris); }
    .centre { text-align: center; margin-top: 24px; }
    .produit { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; padding: 12px 0; border-top: 1px solid var(--k-bord); margin-top: 12px; }
    .ref { font-size: 20px; font-weight: 800; color: var(--k-nuit); }
    .qte { font-size: 20px; font-weight: 900; color: var(--k-nuit); }
    .ligne2 { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13.5px; color: var(--k-gris); }
    h3 { margin: 16px 0 6px; font-size: 12.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--k-gris); }
    .scans { list-style: none; margin: 0; padding: 0; }
    .scans li { display: flex; gap: 10px; padding: 8px 0; font-size: 14px; }
    .scans li ion-icon { flex: none; font-size: 20px; color: var(--k-vert); margin-top: 1px; }
    .scans li.rouge ion-icon, .scans li.rouge b { color: var(--k-erreur); }
    .scans small { display: block; color: var(--k-gris); font-size: 12.5px; }
    .ref-grande { font-size: 26px; font-weight: 900; color: var(--k-nuit); }
    .statut { margin-left: auto; padding: 3px 12px; font-size: 13px; font-weight: 700; border-radius: 999px; color: var(--k-marine); background: var(--k-surface-2); }
    .statut[data-statut='rangee'] { color: var(--k-vert); background: var(--k-vert-clair); }
    .statut[data-statut='recue'] { color: #0c71c3; background: #e5f1fb; }
    .statut[data-statut='en_ecart'] { color: var(--k-orange); background: var(--k-orange-clair); }
    .statut[data-statut='en_cours'] { color: #8a5a00; background: #fff6e0; }
    .avancement { font-size: 13.5px; color: var(--k-gris); }
    .infos { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 10px; font-size: 15px; }
    .import { margin: 8px 0 0; font-size: 13.5px; color: var(--k-gris); }
    .empl { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .empl .k-etiquette { font-size: 20px; }
    .empl em { font-style: normal; font-size: 14px; opacity: 0.7; margin-left: 4px; }
  `,
})
export class ConsulterPage implements OnInit {
  private controles = inject(ControlesService);
  readonly types = LIBELLES_TYPE;
  readonly statuts = LIBELLES_STATUT;
  readonly mode = signal<Mode>('emplacement');
  readonly chargement = signal(false);
  readonly erreur = signal('');
  readonly contenu = signal<ContenuEmplacement | null>(null);
  readonly lignes = signal<LigneProduit[] | null>(null);
  texte = '';
  // Lien d'une étiquette ouvert par l'appareil photo du téléphone : /e/D011
  readonly code = input<string>();

  constructor() {
    addIcons({ searchOutline, qrCodeOutline, locationOutline, cubeOutline, alertCircle, checkmarkCircle, closeCircle, ellipseOutline });
  }

  ngOnInit(): void {
    const code = this.code();
    if (code) {
      this.mode.set('emplacement');
      this.texte = codeEmplacement(code);
      this.chercher();
    }
  }

  libelleScan(resultat: string): string {
    return (
      {
        bon_emplacement: 'bien rangé', faux_emplacement: 'faux emplacement', prelevement_ok: 'prélevé', sortie_terminee: 'prélevé (sortie terminée)',
        mauvais_produit: 'mauvais produit', deja_traite: 'déjà traité', inconnu: 'inconnu',
      }[resultat] ?? resultat.replace(/_/g, ' ')
    );
  }

  changerMode(m: Mode): void {
    this.mode.set(m);
    this.texte = '';
    this.vider();
  }

  // QR lu : une étiquette d'emplacement montre son contenu, un ticket montre où est le produit
  lu(l: Lecture): void {
    this.mode.set(estCodeEmplacement(l.texte) ? 'emplacement' : 'produit');
    if (this.mode() === 'emplacement') {
      this.texte = codeEmplacement(l.texte);
      this.chercher();
    } else {
      const { reference, lot } = referenceEtLot(l.texte);
      this.texte = reference;
      this.chercher(lot);
    }
  }

  async chercher(lot = ''): Promise<void> {
    const t = this.texte.trim().toUpperCase();
    if (!t) return;
    this.vider();
    this.chargement.set(true);
    try {
      if (this.mode() === 'emplacement') this.contenu.set(await this.controles.emplacement(t));
      else this.lignes.set(await this.controles.produit(t, lot));
    } catch (e) {
      const err = e as HttpErrorResponse;
      this.erreur.set(err.status === 0 ? 'Pas de réseau : la consultation demande le Wi-Fi.' : (err.error?.message ?? 'Recherche impossible'));
    } finally {
      this.chargement.set(false);
    }
  }

  private vider(): void {
    this.contenu.set(null);
    this.lignes.set(null);
    this.erreur.set('');
  }
}
