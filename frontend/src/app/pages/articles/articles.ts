import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ToastService } from '../../services/toast';
import {
  Article, ArticleService, ChangementTaille, FAMILLES_ARTICLE, FamilleArticle, TAILLES_PALETTE, TYPES_COSSE, TypeCosse, taillePalette,
} from '../../services/article';

const PAR_PAGE = 120;

// Catalogue des articles (administrateur) : un onglet par famille (bobines, cosses, connecteurs) ;
// la recherche se fait dans la famille choisie ; les connecteurs sont classés par famille de connecteur.
@Component({
  selector: 'app-articles',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './articles.html',
  styleUrl: './articles.css',
})
export class Articles implements OnInit {
  private service = inject(ArticleService);
  private toast = inject(ToastService);
  readonly familles = FAMILLES_ARTICLE;
  readonly tailles = TAILLES_PALETTE;
  readonly taillePalette = taillePalette;
  readonly typesCosse = TYPES_COSSE;

  readonly articles = signal<Article[]>([]);
  readonly chargement = signal(true);
  readonly erreur = signal('');

  readonly famille = signal<FamilleArticle>('bobine');
  readonly categorie = signal(''); // famille de connecteur choisie ('' = toutes)
  readonly taille = signal<number | null>(null); // bobines : nombre par palette choisi (null = toutes)
  readonly typeCosse = signal<TypeCosse | null>(null); // cosses : axiale ou plat (null = toutes)
  readonly recherche = signal('');
  readonly affiches = signal(PAR_PAGE);

  // Formulaire (ajout / modification)
  readonly formOuvert = signal(false);
  readonly editionId = signal<number | null>(null);
  form = { reference: '', famille: 'bobine' as FamilleArticle, categorie: '', bobines_par_palette: 6, type_cosse: null as TypeCosse | null };
  readonly erreurForm = signal('');
  readonly enregistrement = signal(false);
  readonly aSupprimer = signal<Article | null>(null);

  // Changement rapide de taille d'une bobine, et historique des changements
  readonly tailleEnCours = signal<number | null>(null); // article dont la taille s'enregistre
  readonly historiqueOuvert = signal(false);
  readonly historiqueReference = signal(''); // '' = toutes les références
  readonly historique = signal<ChangementTaille[]>([]);
  readonly historiqueChargement = signal(false);
  // Historique ouvert depuis l'onglet Bobines ou Cosses : les changements de cette famille seulement
  readonly historiqueFamille = signal<FamilleArticle | null>(null);
  readonly historiqueAffiche = computed(() => {
    const f = this.historiqueFamille();
    return f ? this.historique().filter((h) => h.famille === f) : this.historique();
  });

  readonly compteFamille = computed(() => {
    const c: Record<FamilleArticle, number> = { bobine: 0, cosse: 0, connecteur: 0 };
    for (const a of this.articles()) c[a.famille]++;
    return c;
  });

  // Familles de connecteurs avec leur nombre de références (selon la recherche en cours)
  readonly categoriesConnecteur = computed(() => {
    const q = this.q();
    const m = new Map<string, { total: number; trouves: number }>();
    for (const a of this.articles()) {
      if (a.famille !== 'connecteur') continue;
      const c = m.get(a.categorie) ?? { total: 0, trouves: 0 };
      c.total++;
      if (!q || a.reference.includes(q)) c.trouves++;
      m.set(a.categorie, c);
    }
    return [...m].map(([nom, c]) => ({ nom, ...c })).sort((a, b) => b.total - a.total || a.nom.localeCompare(b.nom));
  });

  // Bobines par taille (petites 6, moyennes 2, grandes 1 par palette), selon la recherche en cours
  readonly comptesTaille = computed(() => {
    const q = this.q();
    return this.tailles.map((t) => {
      const l = this.articles().filter((a) => a.famille === 'bobine' && taillePalette(a.bobines_par_palette).par === t.par);
      return { ...t, total: l.length, trouves: q ? l.filter((a) => a.reference.includes(q)).length : l.length };
    });
  });

  // Cosses par type (axiales, plates), selon la recherche en cours
  readonly comptesTypeCosse = computed(() => {
    const q = this.q();
    return this.typesCosse.map((t) => {
      const l = this.articles().filter((a) => a.famille === 'cosse' && a.type_cosse === t.valeur);
      return { ...t, total: l.length, trouves: q ? l.filter((a) => a.reference.includes(q)).length : l.length };
    });
  });

  readonly q = computed(() => this.recherche().trim().toUpperCase());

  // Références de l'onglet (et de la famille de connecteur choisie), filtrées par la recherche
  readonly filtres = computed(() => {
    const f = this.famille();
    const c = this.categorie();
    const t = f === 'bobine' ? this.taille() : null;
    const tc = f === 'cosse' ? this.typeCosse() : null;
    const q = this.q();
    return this.articles().filter(
      (a) => a.famille === f && (!c || a.categorie === c) && (!t || taillePalette(a.bobines_par_palette).par === t)
        && (!tc || a.type_cosse === tc) && (!q || a.reference.includes(q))
    );
  });
  readonly visibles = computed(() => this.filtres().slice(0, this.affiches()));
  readonly libelleOnglet = computed(() => this.familles.find((f) => f.valeur === this.famille())!);

  ngOnInit(): void {
    this.service.getArticles().subscribe({
      next: (l) => {
        this.articles.set(l);
        this.chargement.set(false);
      },
      error: (e: HttpErrorResponse) => {
        this.chargement.set(false);
        this.erreur.set(e.status === 0 ? "Serveur injoignable. Vérifiez que l'API est lancée." : (e.error?.message ?? 'Chargement impossible'));
      },
    });
  }

  choisirFamille(f: FamilleArticle): void {
    if (f === this.famille()) return;
    this.famille.set(f);
    this.categorie.set('');
    this.taille.set(null);
    this.typeCosse.set(null);
    this.recherche.set('');
    this.affiches.set(PAR_PAGE);
  }

  choisirCategorie(c: string): void {
    this.categorie.set(c);
    this.affiches.set(PAR_PAGE);
  }

  choisirTypeCosse(t: TypeCosse | null): void {
    this.typeCosse.set(t);
    this.affiches.set(PAR_PAGE);
  }

  libelleTypeCosse(t: TypeCosse | null | undefined): string {
    return this.typesCosse.find((x) => x.valeur === t)?.libelle ?? 'Type ?';
  }

  choisirTaille(t: number | null): void {
    this.taille.set(t);
    this.affiches.set(PAR_PAGE);
  }

  chercher(q: string): void {
    this.recherche.set(q);
    this.affiches.set(PAR_PAGE);
  }

  plus(): void {
    this.affiches.update((n) => n + PAR_PAGE);
  }

  // Référence découpée autour du texte cherché, pour le surligner
  morceaux(ref: string): { avant: string; trouve: string; apres: string } {
    const q = this.q();
    const i = q ? ref.indexOf(q) : -1;
    return i < 0 ? { avant: ref, trouve: '', apres: '' } : { avant: ref.slice(0, i), trouve: ref.slice(i, i + q.length), apres: ref.slice(i + q.length) };
  }

  // ---------- Ajout / modification ----------
  ouvrirAjout(): void {
    const f = this.famille();
    this.form = {
      reference: '', famille: f, categorie: f === 'connecteur' ? this.categorie() : '', bobines_par_palette: this.taille() ?? 6,
      type_cosse: this.typeCosse() ?? 'plat',
    };
    this.editionId.set(null);
    this.erreurForm.set('');
    this.formOuvert.set(true);
  }

  ouvrirModification(a: Article): void {
    this.form = {
      reference: a.reference,
      famille: a.famille,
      categorie: a.famille === 'connecteur' ? a.categorie : '',
      bobines_par_palette: taillePalette(a.bobines_par_palette).par,
      type_cosse: a.type_cosse ?? 'plat',
    };
    this.editionId.set(a.id);
    this.erreurForm.set('');
    this.formOuvert.set(true);
  }

  enregistrer(): void {
    if (!this.form.reference.trim()) return this.erreurForm.set('La référence est obligatoire.');
    if (this.form.famille === 'connecteur' && !this.form.categorie.trim()) return this.erreurForm.set('Indiquez la famille de connecteur.');
    this.enregistrement.set(true);
    const id = this.editionId();
    const corps = {
      ...this.form,
      bobines_par_palette: this.form.famille === 'bobine' ? this.form.bobines_par_palette : null,
      type_cosse: this.form.famille === 'cosse' ? this.form.type_cosse : null,
    };
    (id ? this.service.modifier(id, corps) : this.service.ajouter(corps)).subscribe({
      next: (a) => {
        this.enregistrement.set(false);
        this.formOuvert.set(false);
        this.articles.update((l) => (id ? l.map((x) => (x.id === id ? a : x)) : [...l, a]).sort(ordre));
        const detail = a.famille === 'bobine'
          ? `${taillePalette(a.bobines_par_palette).libelle.toLowerCase()} bobine, ${a.bobines_par_palette} par palette`
          : a.famille === 'cosse' ? `cosse ${this.libelleTypeCosse(a.type_cosse).toLowerCase()}` : a.categorie;
        this.toast.afficher(id ? `${a.reference} modifié (${detail})` : `${a.reference} ajouté (${detail})`);
      },
      error: (e: HttpErrorResponse) => {
        this.enregistrement.set(false);
        this.erreurForm.set(e.error?.message ?? 'Enregistrement impossible');
      },
    });
  }

  // ---------- Type d'une cosse ----------
  changerTypeCosse(a: Article, type: TypeCosse): void {
    if (type === a.type_cosse || this.tailleEnCours()) return;
    this.tailleEnCours.set(a.id);
    this.service.changerTypeCosse(a.id, type).subscribe({
      next: (r) => {
        this.tailleEnCours.set(null);
        this.articles.update((l) => l.map((x) => (x.id === a.id ? { ...x, type_cosse: r.type_cosse } : x)));
        this.toast.afficher(`${a.reference} : ${this.libelleTypeCosse(r.avant).toLowerCase()} → ${this.libelleTypeCosse(r.type_cosse).toLowerCase()} pour les prochains imports`);
        if (this.historiqueOuvert()) this.chargerHistorique();
      },
      error: (e: HttpErrorResponse) => {
        this.tailleEnCours.set(null);
        this.toast.afficher(e.error?.message ?? 'Changement de type impossible', true);
      },
    });
  }

  // ---------- Taille d'une bobine ----------
  changerTaille(a: Article, par: number): void {
    if (par === taillePalette(a.bobines_par_palette).par || this.tailleEnCours()) return;
    this.tailleEnCours.set(a.id);
    this.service.changerTaille(a.id, par).subscribe({
      next: (r) => {
        this.tailleEnCours.set(null);
        this.articles.update((l) => l.map((x) => (x.id === a.id ? { ...x, bobines_par_palette: r.bobines_par_palette } : x)));
        const avant = taillePalette(r.avant).libelle.toLowerCase();
        const apres = taillePalette(r.bobines_par_palette).libelle.toLowerCase();
        this.toast.afficher(`${a.reference} : ${avant} → ${apres} (${r.bobines_par_palette} par palette) pour les prochains imports`);
        if (this.historiqueOuvert()) this.chargerHistorique();
      },
      error: (e: HttpErrorResponse) => {
        this.tailleEnCours.set(null);
        this.toast.afficher(e.error?.message ?? 'Changement de taille impossible', true);
      },
    });
  }

  ouvrirHistorique(reference = ''): void {
    this.historiqueReference.set(reference);
    this.historiqueFamille.set(reference ? null : this.famille());
    this.historiqueOuvert.set(true);
    this.chargerHistorique();
  }

  chargerHistorique(): void {
    this.historiqueChargement.set(true);
    this.service.getChangementsTaille(this.historiqueReference() || undefined).subscribe({
      next: (l) => {
        this.historique.set(l);
        this.historiqueChargement.set(false);
      },
      error: (e: HttpErrorResponse) => {
        this.historiqueChargement.set(false);
        this.toast.afficher(e.error?.message ?? 'Historique indisponible', true);
      },
    });
  }

  confirmerSuppression(): void {
    const a = this.aSupprimer();
    if (!a) return;
    this.service.supprimer(a.id).subscribe({
      next: () => {
        this.aSupprimer.set(null);
        this.articles.update((l) => l.filter((x) => x.id !== a.id));
        this.toast.afficher(`${a.reference} supprimé`);
      },
      error: (e: HttpErrorResponse) => {
        this.aSupprimer.set(null);
        this.toast.afficher(e.error?.message ?? 'Suppression impossible', true);
      },
    });
  }
}

const RANG: Record<FamilleArticle, number> = { bobine: 0, cosse: 1, connecteur: 2 };
const ordre = (a: Article, b: Article) =>
  RANG[a.famille] - RANG[b.famille] || a.categorie.localeCompare(b.categorie) || a.reference.localeCompare(b.reference);
