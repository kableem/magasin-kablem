import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Article, ArticleService } from '../../services/article';
import { ReceptionService } from '../../services/reception';

interface LigneSaisie {
  reference: string;
  lot: string;
  quantite: number | null;
  longueur: number | null;
  largeur: number | null;
  hauteur: number | null;
  poids: number | null;
}

const ligneVide = (): LigneSaisie => ({ reference: '', lot: '', quantite: null, longueur: null, largeur: null, hauteur: null, poids: null });
const normaliser = (r: string) => r.trim().replace(/\s+/g, ' ').toUpperCase();

// Saisie d'un import à la main (administrateur, pour les essais). Le type de chaque produit est
// trouvé dans le catalogue Articles d'après la référence, comme à la synchronisation avec l'Italie.
@Component({
  selector: 'app-import-manuel',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="fond" (click)="fermer.emit()">
      <form class="modale modale-manuel" (click)="$event.stopPropagation()" (ngSubmit)="enregistrer()" novalidate>
        <div class="modale-entete">
          <h2>Saisir un import (essai)</h2>
          <button type="button" class="icone-btn" (click)="fermer.emit()" aria-label="Fermer">
            <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
          </button>
        </div>
        <p class="aide">
          L'import arrive « en attente », comme s'il venait de l'Italie : réception mobile, plan de rangement puis rangement.
          Le type vient du catalogue <b>Articles</b> d'après la référence (bobine = petite bobine).
        </p>

        @if (erreur()) {
          <p class="erreur">{{ erreur() }}</p>
        }

        <label class="champ numero">
          N° de livraison
          <input name="numero" class="mono" maxlength="50" [(ngModel)]="numero" autocomplete="off" />
        </label>

        <datalist id="refs-catalogue">
          @for (a of catalogue(); track a.id) {
            <option [value]="a.reference">{{ a.categorie }}</option>
          }
        </datalist>

        <div class="lignes">
          <div class="entete-lignes">
            <span>Référence</span><span>Type</span><span>Lot</span><span>Quantité</span><span></span>
          </div>
          @for (l of lignes(); track $index; let k = $index) {
            @let a = article(l.reference);
            <div class="ligne" [class.inconnue]="l.reference.trim() && !a">
              <input [name]="'ref' + k" class="mono" list="refs-catalogue" placeholder="ex. CFLR9YAT30035800002T" autocomplete="off" [(ngModel)]="l.reference" />
              <span class="type" [attr.data-famille]="a?.famille ?? (l.reference.trim() ? 'inconnue' : '')">
                @if (a) {
                  {{ a.famille === 'bobine' ? 'Bobine · petite' : a.famille === 'cosse' ? 'Cosse' : 'Connecteur · ' + a.categorie }}
                } @else if (l.reference.trim()) {
                  Absente du catalogue
                } @else {
                  —
                }
              </span>
              <input [name]="'lot' + k" class="mono" placeholder="ex. 202614133" autocomplete="off" [(ngModel)]="l.lot" />
              <input [name]="'qte' + k" type="number" min="1" step="1" [placeholder]="a?.famille === 'connecteur' ? 'cartons' : 'ex. 6'" [(ngModel)]="l.quantite" />
              <button type="button" class="icone-btn" (click)="retirer(k)" [disabled]="lignes().length === 1" aria-label="Retirer la ligne">
                <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>
              </button>
              @if (a?.famille === 'connecteur') {
                <div class="carton">
                  <span>Un carton :</span>
                  <label>L <input [name]="'lo' + k" type="number" min="1" [(ngModel)]="l.longueur" /> cm</label>
                  <label>l <input [name]="'la' + k" type="number" min="1" [(ngModel)]="l.largeur" /> cm</label>
                  <label>h <input [name]="'ha' + k" type="number" min="1" [(ngModel)]="l.hauteur" /> cm</label>
                  <label>Poids <input [name]="'po' + k" type="number" min="0.1" step="0.1" [(ngModel)]="l.poids" /> kg</label>
                </div>
              }
            </div>
          }
        </div>
        <button type="button" class="btn btn-secondaire ajouter" (click)="ajouter()">+ Ajouter un produit</button>

        <div class="modale-pied">
          <button type="button" class="btn btn-secondaire" (click)="fermer.emit()">Annuler</button>
          <button type="submit" class="btn btn-principal" [disabled]="envoi()">{{ envoi() ? 'Création…' : "Créer l'import" }}</button>
        </div>
      </form>
    </div>
  `,
  styles: `
    .modale-manuel { width: min(920px, 96vw); max-height: 92vh; overflow-y: auto; }
    .aide { margin: 0 0 14px; font-size: 14px; color: var(--gris); }
    .erreur { margin: 0 0 12px; padding: 10px 14px; color: #b81818; background: #fde8e8; border-radius: 10px; }
    .champ { display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; font-weight: 600; color: var(--gris); }
    .numero { max-width: 320px; margin-bottom: 16px; }
    .numero input { height: 40px; }
    .mono { font-family: Consolas, monospace; font-weight: 700; }
    .lignes { display: grid; gap: 8px; }
    .entete-lignes, .ligne { display: grid; grid-template-columns: minmax(200px, 2.2fr) 1.3fr 1.2fr 100px 40px; gap: 8px; align-items: center; }
    .entete-lignes span { font-size: 12px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--gris); }
    .ligne { padding: 8px; background: #f8f9fc; border: 1px solid var(--bord); border-radius: 12px; }
    .ligne.inconnue { border-color: #f1b3b3; background: #fff6f6; }
    .ligne input { height: 38px; min-width: 0; }
    .type { padding: 4px 10px; font-size: 12.5px; font-weight: 700; color: var(--gris); background: #eef1f6; border-radius: 999px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .type[data-famille='bobine'] { color: #164f96; background: #e8f1fc; }
    .type[data-famille='cosse'] { color: #9a5205; background: #fff2e0; }
    .type[data-famille='connecteur'] { color: #552a8c; background: #f2ebfc; }
    .type[data-famille='inconnue'] { color: #b81818; background: #fde8e8; }
    .carton { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding-top: 4px; font-size: 13px; color: var(--gris); }
    .carton label { display: flex; align-items: center; gap: 4px; }
    .carton input { width: 76px; height: 34px; }
    .ajouter { margin-top: 10px; }
    @media (max-width: 760px) {
      .entete-lignes { display: none; }
      .ligne { grid-template-columns: 1fr 1fr; }
    }
  `,
})
export class ImportManuel implements OnInit {
  private articles = inject(ArticleService);
  private reception = inject(ReceptionService);
  readonly fermer = output<void>();
  readonly cree = output<{ id: number; numero: string; produits: number }>();

  readonly catalogue = signal<Article[]>([]);
  private readonly parReference = computed(() => new Map(this.catalogue().map((a) => [normaliser(a.reference), a])));
  readonly lignes = signal<LigneSaisie[]>([ligneVide()]);
  readonly erreur = signal('');
  readonly envoi = signal(false);
  numero = numeroEssai();

  ngOnInit(): void {
    this.articles.getArticles().subscribe({
      next: (l) => this.catalogue.set(l),
      error: () => this.erreur.set('Catalogue Articles indisponible : le type ne peut pas être affiché.'),
    });
  }

  article(reference: string): Article | undefined {
    return this.parReference().get(normaliser(reference));
  }

  ajouter(): void {
    this.lignes.update((l) => [...l, ligneVide()]);
  }

  retirer(k: number): void {
    this.lignes.update((l) => l.filter((_, i) => i !== k));
  }

  enregistrer(): void {
    this.erreur.set('');
    const lignes = this.lignes().filter((l) => l.reference.trim() || l.lot.trim() || l.quantite);
    if (!this.numero.trim()) return this.erreur.set('Indiquez le n° de livraison.');
    if (!lignes.length) return this.erreur.set('Ajoutez au moins un produit.');
    const inconnue = lignes.find((l) => !this.article(l.reference));
    if (inconnue) {
      return this.erreur.set(
        inconnue.reference.trim()
          ? `${normaliser(inconnue.reference)} est absente du catalogue Articles : ajoutez-la d'abord dans Administration → Articles.`
          : 'Une ligne n’a pas de référence.'
      );
    }
    this.envoi.set(true);
    this.reception.creerImportManuel(this.numero, lignes).subscribe({
      next: (r) => {
        this.envoi.set(false);
        this.cree.emit(r);
      },
      error: (e: HttpErrorResponse) => {
        this.envoi.set(false);
        this.erreur.set(e.status === 0 ? 'Serveur injoignable' : (e.error?.message ?? 'Création impossible'));
      },
    });
  }
}

// N° proposé pour un essai : TEST-AAAAMMJJ-HHMM
function numeroEssai(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `TEST-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
