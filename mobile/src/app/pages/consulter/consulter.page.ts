import { Component, OnInit, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { searchOutline, qrCodeOutline, locationOutline, cubeOutline, alertCircle, checkmarkCircle, closeCircle, ellipseOutline, gridOutline, chevronForward } from 'ionicons/icons';
import { Lecture, ScannerComponent } from '../../composants/scanner.component';
import { EnteteComponent } from '../../composants/entete.component';
import { ControlesService } from '../../services/controles.service';
import { CartonConsulte, ContenuEmplacement, LIBELLES_STATUT, LIBELLES_TYPE, LigneProduit, codeEmplacement, estCodeEmplacement, estEtiquetteCarton, nombre, referenceEtLot } from '../../services/modeles';
import { EmplPipe } from '../../composants/empl.pipe';
import { nomEmplacement } from '../../services/plan';

type Mode = 'emplacement' | 'produit';

@Component({
  selector: 'app-consulter',
  standalone: true,
  imports: [EmplPipe, DatePipe, IonContent, IonIcon, IonSpinner, ScannerComponent, EnteteComponent],
  template: `
    <app-entete titre="Consulter" module="Import" retour="/import"></app-entete>
    <ion-content class="ion-padding">
      <!-- Le QR décide : étiquette d’emplacement → son contenu ; ticket → où est le produit ; étiquette de carton → le carton -->
      <app-scanner [actif]="!chargement()" consigne="Étiquette, ticket ou carton : scannez" (lecture)="lu($event)"></app-scanner>

      <!-- Rien de scanné encore : ce que l'on peut scanner ici (pas de recherche au clavier) -->
      @if (!chargement() && !erreur() && !contenu() && !lignes() && !carton()) {
        <ul class="aide-scan k-apparait">
          <li><span class="pastille"><ion-icon name="location-outline"></ion-icon></span><span><b>Étiquette d'un emplacement</b><small>ce qu'il contient : palette, cartons, colis</small></span></li>
          <li><span class="pastille"><ion-icon name="qr-code-outline"></ion-icon></span><span><b>Ticket vert d'un produit</b><small>où il est rangé, et son avancement</small></span></li>
          <li><span class="pastille"><ion-icon name="cube-outline"></ion-icon></span><span><b>Étiquette d'un carton</b><small>ses cosses, sa palette, son emplacement</small></span></li>
        </ul>
      }

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
            <span class="etat" [class.libre]="!c.produits.length">{{ c.palette ? 'Palette n° ' + c.palette.numero + ' · pleine' : c.produits.length ? 'Occupé' : 'Libre' }}</span>
          </header>
          @if (c.palette; as pal) {
            <p class="vide">Palette de cosses : {{ pal.cartons.length }} carton{{ pal.cartons.length > 1 ? 's' : '' }}{{ pal.separees ? ' + ' + pal.separees + ' séparée' + (pal.separees > 1 ? 's' : '') : '' }} · {{ pal.cosses }} cosse{{ pal.cosses > 1 ? 's' : '' }}. Rien ne s'y ajoute ; elle se déplace en entier (« Palette entière »).</p>
            @if (pal.cartons.length) {
              <p class="cartons-palette">
                @for (k of pal.cartons; track k.numero) {
                  <span><b>C{{ k.numero }}</b> {{ k.reference }} · {{ k.en_stock }}</span>
                }
              </p>
            }
          }
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

      @if (carton(); as k) {
        <!-- Étiquette d'un carton de cosses : le carton, ses cosses, sa palette et où il est -->
        <section class="fiche k-carte k-apparait carton">
          <header>
            <span class="pastille-carton"><ion-icon name="cube-outline"></ion-icon></span>
            <span class="titre-carton"><b>Carton n° {{ k.carton.numero }}</b><small>Import {{ k.import.numero_livraison ?? 'n° ' + k.import.id }}</small></span>
            <span class="statut" [attr.data-statut]="k.carton.statut === 'range' ? (k.carton.en_stock ? 'rangee' : 'vide') : 'en_cours'">{{ etatCarton(k) }}</span>
          </header>
          <div class="ref-grande mono">{{ k.carton.reference }}</div>
          <div class="infos">
            <span>lot <b class="mono">{{ k.carton.lot }}</b></span>
            <span><b>{{ k.carton.statut === 'range' ? k.carton.en_stock + '/' + k.carton.cosses : k.carton.cosses }}</b> cosse{{ k.carton.cosses > 1 ? 's' : '' }}{{ k.carton.statut === 'range' ? ' en stock' : '' }}</span>
            @if (k.carton.pieces !== null) {
              <span><b>{{ nombre(k.carton.pieces) }}</b> pièces</span>
            }
          </div>
          @if (k.carton.emplacement && k.carton.en_stock) {
            <button type="button" class="aller" (click)="voirEmplacement(k.carton.emplacement)">
              <ion-icon name="location-outline"></ion-icon>
              <span>Il est en <span class="k-etiquette">{{ k.carton.emplacement | empl }}</span></span>
              <ion-icon name="chevron-forward"></ion-icon>
            </button>
          }
          <h3>Cosses du carton</h3>
          <p class="numeros cosses">
            @for (x of k.carton.liste; track $index) {
              <i [class.sortie]="x.sortie" [title]="x.sortie ? 'sortie (export)' : ''">{{ x.colis ?? '?' }}{{ x.pieces !== null ? ' · ' + nombre(x.pieces) : '' }}</i>
            }
          </p>
          @if (k.carton.liste.some(estSortie)) {
            <small class="aide">Barrées : cosses déjà sorties (export).</small>
          }
          @if (k.palette; as p) {
            <div class="palette">
              <div class="palette-tete">
                <ion-icon name="grid-outline"></ion-icon>
                <span><b>Palette n° {{ p.numero }}</b><small>{{ p.contenu }}{{ p.statut === 'rangee' && p.en_stock < p.cosses ? ' · ' + p.en_stock + ' en stock' : '' }}</small></span>
              </div>
              @if (p.cartons.length > 1 || p.nb_separees) {
                <p class="cartons-palette">
                  @for (c of p.cartons; track c.id) {
                    <span [class.ici]="c.id === k.carton.id"><b>C{{ c.numero }}</b> {{ c.reference }} · {{ c.statut === 'range' ? c.en_stock : c.cosses }}</span>
                  }
                  @if (p.nb_separees) {
                    <span>+ {{ p.nb_separees }} séparée{{ p.nb_separees > 1 ? 's' : '' }}</span>
                  }
                </p>
              }
            </div>
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
    .carton header { flex-wrap: nowrap; }
    .pastille-carton { display: grid; place-items: center; flex: none; width: 42px; height: 42px; font-size: 22px; color: #fff; background: var(--k-orange); border-radius: 12px; }
    .titre-carton { display: flex; flex-direction: column; min-width: 0; }
    .titre-carton b { font-size: 18px; color: var(--k-nuit); }
    .titre-carton small { font-size: 12.5px; color: var(--k-gris); }
    .carton .ref-grande { display: block; margin-top: 12px; }
    .aller { display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 12px; padding: 10px 12px; font: inherit; font-weight: 700; text-align: left; color: var(--k-nuit); background: var(--k-vert-clair); border: 0; border-radius: 14px; }
    .aller > span { flex: 1; display: flex; align-items: center; gap: 8px; }
    .aller .k-etiquette { font-size: 20px; }
    .numeros.cosses { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; }
    .numeros.cosses i { padding: 3px 10px; font-style: normal; font-size: 13px; font-weight: 700; color: var(--k-marine); background: var(--k-surface-2); border-radius: 999px; }
    .numeros.cosses i.sortie { text-decoration: line-through; opacity: 0.55; }
    .aide { display: block; margin-top: 6px; font-size: 12.5px; color: var(--k-gris); }
    .palette { margin-top: 14px; padding: 12px; background: var(--k-surface-2); border-radius: 14px; }
    .palette-tete { display: flex; align-items: center; gap: 10px; }
    .palette-tete ion-icon { font-size: 22px; color: var(--k-nuit); }
    .palette-tete span { display: flex; flex-direction: column; }
    .palette-tete small { font-size: 12.5px; color: var(--k-gris); }
    .palette .cartons-palette { margin: 10px 0 0; }
    .cartons-palette span.ici { color: #fff; background: var(--k-orange); }
    .statut[data-statut='vide'] { color: var(--k-gris); background: var(--k-surface-2); }
    .cartons-palette { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
    .cartons-palette span { padding: 3px 10px; font-size: 13px; color: #7a4204; background: var(--k-orange-clair); border-radius: 999px; }
    .aide-scan { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 10px; }
    .aide-scan li { display: flex; align-items: center; gap: 14px; padding: 14px 16px; background: var(--k-surface); border: 1px solid var(--k-bord); border-radius: 18px; box-shadow: var(--k-ombre); }
    .aide-scan .pastille { display: grid; place-items: center; width: 46px; height: 46px; flex: none; font-size: 24px; color: #fff; background: var(--k-degrade-nuit); border-radius: 15px; }
    .aide-scan li > span:last-child { display: flex; flex-direction: column; min-width: 0; }
    .aide-scan b { font-size: 16px; color: var(--k-nuit); }
    .aide-scan small { font-size: 13.5px; color: var(--k-gris); }
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
  readonly carton = signal<CartonConsulte | null>(null);
  readonly nombre = nombre;
  readonly estSortie = (x: { sortie: boolean }) => x.sortie;
  texte = '';
  // Lien d'une étiquette ouvert par l'appareil photo du téléphone : /e/D011
  readonly code = input<string>();

  constructor() {
    addIcons({ searchOutline, qrCodeOutline, locationOutline, cubeOutline, alertCircle, checkmarkCircle, closeCircle, ellipseOutline, gridOutline, chevronForward });
  }

  ngOnInit(): void {
    const code = this.code();
    if (code) {
      this.mode.set('emplacement');
      this.texte = nomEmplacement(codeEmplacement(code)); // numéro de l'étiquette (0614), pas le code interne
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

  // QR lu : une étiquette d'emplacement montre son contenu, un ticket montre où est le produit,
  // une étiquette de carton montre le carton (ses cosses, sa palette, son emplacement)
  lu(l: Lecture): void {
    if (estEtiquetteCarton(l.texte)) {
      void this.lireCarton(l.texte);
      return;
    }
    this.mode.set(estCodeEmplacement(l.texte) ? 'emplacement' : 'produit');
    if (this.mode() === 'emplacement') {
      this.texte = nomEmplacement(codeEmplacement(l.texte));
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

  async lireCarton(qr: string): Promise<void> {
    this.mode.set('produit');
    this.vider();
    this.chargement.set(true);
    try {
      const k = await this.controles.carton(qr);
      this.texte = k.carton.reference;
      this.carton.set(k);
    } catch (e) {
      const err = e as HttpErrorResponse;
      this.erreur.set(err.status === 0 ? 'Pas de réseau : la consultation demande le Wi-Fi.' : (err.error?.message ?? 'Carton introuvable'));
    } finally {
      this.chargement.set(false);
    }
  }

  // Touche « Il est en D012 » : le contenu de cet emplacement
  voirEmplacement(code: string): void {
    this.mode.set('emplacement');
    this.texte = nomEmplacement(code);
    void this.chercher();
  }

  etatCarton(k: CartonConsulte): string {
    if (k.carton.statut === 'ouvert') return 'En réception';
    if (k.carton.statut === 'termine') return 'À ranger';
    return k.carton.en_stock ? 'Rangé' : 'Vide (tout est sorti)';
  }

  private vider(): void {
    this.contenu.set(null);
    this.lignes.set(null);
    this.carton.set(null);
    this.erreur.set('');
  }
}
