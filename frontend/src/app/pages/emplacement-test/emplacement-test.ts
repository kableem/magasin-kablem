// Page « Emplacements » : plan du magasin (blocs A à H, numéros des étiquettes du rayonnage),
// contenu de chaque emplacement, zone tampon, historique et « Ranger le magasin ».
// (Ancienne page d'essai « Emplacement test », devenue la seule page des emplacements.)
import { Component, ElementRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { EmplPipe } from '../emplacements/empl.pipe';
import {
  LigneStock,
  MouvementEmplacement,
  ORIGINES_MOUVEMENT,
  ReceptionService,
  formatNombre,
  libelleProduit,
} from '../../services/reception';
import { HttpErrorResponse } from '@angular/common/http';
import { enregistrerFichier } from '../../services/telechargement';
import { AuthService, peutGererMagasin } from '../../services/auth';
import { LIBELLES_ROLES } from '../../services/utilisateur';
import { ToastService } from '../../services/toast';
import {
  Emplacement,
  Facade,
  NIVEAUX,
  capacitePalette,
  nombreProduits,
  remplissageCosses,
  COSSES_PAR_PALETTE,
  COSSES_AXIALES_PAR_PALETTE,
  emplacementTampon,
  estTampon,
  typeDuNiveau,
  BLOCS,
  TOUS_LES_EMPLACEMENTS,
  NUMEROS_MAGASIN,
  RANG_PROXIMITE,
} from '../emplacements/plan-magasin';
import { Vue3d } from '../emplacements/vue-3d';
import { RangerMagasin, aujourdhui } from '../emplacements/ranger-magasin';

type EtatEmplacement = 'libre' | 'partiel' | 'plein';

@Component({
  selector: 'app-emplacement-test',
  imports: [FormsModule, DatePipe, Vue3d, RangerMagasin, EmplPipe],
  templateUrl: './emplacement-test.html',
  styleUrl: './emplacement-test.css',
})
export class EmplacementTest implements OnInit {
  private hote = inject<ElementRef<HTMLElement>>(ElementRef);
  private stockService = inject(ReceptionService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);

  readonly libelleProduit = libelleProduit;
  readonly nombre = formatNombre;

  // Contenu de chaque emplacement (affecté dans Gestion de stock) :
  // une palette de cosses / connecteurs, ou jusqu'à 1 / 2 / 6 bobines (grande / moyenne / petite)
  occupation = signal(new Map<string, LigneStock[]>());
  readonly nbOccupes = computed(() => [...this.occupation().keys()].filter((c) => !estTampon(c)).length);
  nbTampon = signal(0); // produits en zone tampon (plus de place libre à leur niveau)

  // Zone tampon : places au sol devant les blocs A et B, nombre réglable par l'administrateur
  capaciteTampon = signal(20);
  tamponMax = signal(99);
  saisieCapacite = signal(20);
  erreurCapacite = signal('');
  readonly estAdmin = computed(() => peutGererMagasin(this.auth.utilisateur()));
  readonly placesTampon = computed(() =>
    Array.from({ length: this.capaciteTampon() }, (_, i) => emplacementTampon(i + 1))
  );
  readonly nbPlacesTamponOccupees = computed(
    () => this.placesTampon().filter((p) => this.occupation().has(p.code)).length
  );
  readonly rang = RANG_PROXIMITE;

  readonly blocs = BLOCS;
  // Numéros du magasin (0012…) des niveaux déjà numérotés ; les autres gardent le code de l'application
  readonly numerosMagasin = NUMEROS_MAGASIN;
  nom(code: string): string {
    return NUMEROS_MAGASIN.get(code) ?? code;
  }
  readonly typeDuNiveau = typeDuNiveau;
  readonly total = TOUS_LES_EMPLACEMENTS.length;
  readonly nbNiveaux = Math.max(...BLOCS.map((b) => b.nbNiveaux)); // 6 avec le bloc E

  filtreBloc = signal<string>(''); // '' = tous les blocs
  vue = signal<'2d' | '3d'>('2d'); // plan à plat ou magasin en 3D
  // Partie de la page affichée (boutons en haut) : plus besoin de descendre pour la zone tampon ou l'historique
  onglet = signal<'plan' | 'tampon' | 'historique' | 'ranger'>('plan');
  recherche = signal('');
  selection = signal<Emplacement | null>(null);

  readonly blocsAffiches = computed(() =>
    this.filtreBloc() ? this.blocs.filter((b) => b.lettre === this.filtreBloc()) : this.blocs
  );

  readonly erreurRecherche = signal('');

  // « Ranger le magasin » : déplacements faits aujourd'hui par les magasiniers (pastille de l'onglet)
  readonly deplacementsDuJour = signal<number | null>(null);

  ngOnInit(): void {
    const jour = aujourdhui();
    this.stockService.getSuiviRanger({ du: jour, au: jour }).subscribe({
      next: (r) => this.deplacementsDuJour.set(r.resume.deplacements),
      error: () => this.deplacementsDuJour.set(null),
    });
    this.stockService.getStock().subscribe((lignes) =>
      {
        const m = new Map<string, LigneStock[]>();
        for (const l of lignes) if (l.emplacement) m.set(l.emplacement, [...(m.get(l.emplacement) ?? []), l]);
        this.nbTampon.set(lignes.filter((l) => estTampon(l.emplacement)).length);
        this.occupation.set(m);
      }
    );
    this.chargerHistorique();
    this.stockService.getParametres().subscribe((p) => {
      this.capaciteTampon.set(p.tampon_capacite);
      this.saisieCapacite.set(p.tampon_capacite);
      this.tamponMax.set(p.tampon_max);
    });
  }

  // Étiquettes QR des places de la zone tampon à imprimer (par défaut : toutes)
  readonly etiquettesDe = signal(1);
  readonly etiquettesA = signal(0);
  readonly impressionEtiquettes = signal(false);

  imprimerEtiquettes(): void {
    const de = Number(this.etiquettesDe()) || 1;
    const a = Number(this.etiquettesA()) || this.capaciteTampon();
    this.impressionEtiquettes.set(true);
    this.stockService.telechargerEtiquettesTampon(de, a).subscribe({
      next: (r) => {
        this.impressionEtiquettes.set(false);
        enregistrerFichier(r, 'etiquettes-tampon.pdf');
      },
      error: (err: HttpErrorResponse) => {
        this.impressionEtiquettes.set(false);
        this.erreurCapacite.set(err.status === 0 ? 'Serveur injoignable' : 'Étiquettes impossibles à générer');
      },
    });
  }

  enregistrerCapacite(): void {
    const n = Number(this.saisieCapacite());
    if (!Number.isInteger(n) || n < 1 || n > this.tamponMax()) {
      this.erreurCapacite.set(`Entrez un nombre entier entre 1 et ${this.tamponMax()}.`);
      return;
    }
    const avant = this.capaciteTampon();
    this.stockService.setCapaciteTampon(n).subscribe({
      next: ({ tampon_capacite }) => {
        this.capaciteTampon.set(tampon_capacite);
        this.erreurCapacite.set('');
        // Agrandie : les nouvelles places ont besoin de leur étiquette QR
        if (tampon_capacite > avant) {
          this.etiquettesDe.set(avant + 1);
          this.etiquettesA.set(tampon_capacite);
          this.toast.afficher(`Zone tampon : ${tampon_capacite} places. Imprimez les étiquettes des nouvelles places (T${String(avant + 1).padStart(2, '0')} à T${String(tampon_capacite).padStart(2, '0')}).`);
        } else {
          this.toast.afficher(`Zone tampon : ${tampon_capacite} places`);
        }
      },
      error: (err: HttpErrorResponse) => this.erreurCapacite.set(err.error?.message || 'Modification impossible'),
    });
  }

  // Première ligne de l'emplacement (sert au type et à la couleur)
  contenu(code: string): LigneStock | undefined {
    return this.occupation().get(code)?.[0];
  }

  contenus(code: string): LigneStock[] {
    return this.occupation().get(code) ?? [];
  }

  // Palette de cosses (cartons et cosses séparées) : seule sur son emplacement, rien ne s'y ajoute (elle se déplace en entier)
  carton(code: string): { numero: number; cosses: number } | null {
    const liste = this.contenus(code).filter((l) => l.palette_cosses_id);
    return liste.length ? { numero: liste[0].palette_numero ?? 0, cosses: nombreProduits(liste) } : null;
  }

  // Cartons sur l'emplacement, pour leur couleur : 'cosse' (palette de cartons de cosses), 'connecteur', ou null
  famillePalette(code: string): 'cosse' | 'connecteur' | null {
    const l = this.contenu(code);
    if (l?.type === 'connecteur') return 'connecteur';
    return this.carton(code) ? 'cosse' : null;
  }

  // "2/6" pour une palette de petites bobines ; « 3 cartons » pour des connecteurs ; « 72 cosses » pour une palette de cartons de cosses ; '' sinon
  remplissage(code: string): string {
    const liste = this.contenus(code);
    const k = this.carton(code);
    if (k && liste[0]?.type === 'connecteur') return `${k.cosses} carton${k.cosses > 1 ? 's' : ''}`; // la couleur violette dit « connecteurs »
    if (k) return `${k.cosses} cosse${k.cosses > 1 ? 's' : ''}`; // la couleur kraft dit « cartons de cosses »
    if (liste[0]?.type === 'connecteur') return `${nombreProduits(liste)} carton${nombreProduits(liste) > 1 ? 's' : ''}`;
    if (liste[0]?.type === 'cosse') {
      // plates et axiales chacune à part : « 7/10 · 2/3 ax. »
      const c = remplissageCosses(liste);
      return [c.plates && `${c.plates}/${COSSES_PAR_PALETTE}`, c.axiales && `${c.axiales}/${COSSES_AXIALES_PAR_PALETTE} ax.`].filter(Boolean).join(' · ');
    }
    const cap = liste.length ? capacitePalette(liste[0]) : 1;
    return cap > 1 ? `${nombreProduits(liste)}/${cap}` : '';
  }

  // ---------- État d'un emplacement : libre, partiel ou plein ----------
  // Bobines et cosses : nombre de produits / capacité de la palette.
  // Connecteurs (provisoire, sans volume ni poids) : un emplacement occupé est plein.
  tauxRemplissage(code: string): number {
    const liste = this.contenus(code);
    if (!liste.length) return 0;
    if (this.carton(code)) return 1; // une palette de cosses occupe tout l'emplacement
    if (liste[0].type === 'connecteur') return 1;
    // cosses : pleine quand il n'y a plus de place ni pour une plate ni pour une axiale
    if (liste[0].type === 'cosse') {
      const c = remplissageCosses(liste);
      return (Math.min(c.plates, COSSES_PAR_PALETTE) + Math.min(c.axiales, COSSES_AXIALES_PAR_PALETTE)) / (COSSES_PAR_PALETTE + COSSES_AXIALES_PAR_PALETTE);
    }
    return nombreProduits(liste) / capacitePalette(liste[0]);
  }

  etat(code: string): EtatEmplacement {
    const taux = this.tauxRemplissage(code);
    return !this.contenus(code).length ? 'libre' : taux >= 1 ? 'plein' : 'partiel';
  }

  readonly libelleEtat: Record<EtatEmplacement, string> = { libre: 'Libre', partiel: 'Partiel', plein: 'Plein' };

  // Nombre d'emplacements par état (rayonnages affichés + zone tampon)
  readonly resumeEtats = computed(() => {
    this.occupation();
    const codes = [
      ...TOUS_LES_EMPLACEMENTS.filter((e) => !this.filtreBloc() || e.bloc === this.filtreBloc()).map((e) => e.code),
      ...this.placesTampon().map((e) => e.code),
    ];
    const r = { libre: 0, partiel: 0, plein: 0 };
    for (const c of codes) r[this.etat(c)]++;
    return r;
  });

  // Ce qu'il reste sur la palette, pour le détail
  placeRestante(code: string): string {
    const liste = this.contenus(code);
    if (!liste.length) return 'Palette vide';
    if (this.carton(code) && liste[0].type === 'connecteur') return 'Palette de connecteurs : elle se complète à la réception';
    if (this.carton(code)) return "Palette de cartons de cosses : rien ne s'y ajoute (elle se déplace en entier)";
    if (this.etat(code) === 'plein') return 'Plus de place';
    const l = liste[0];
    if (l.type === 'connecteur') return 'Une seule référence et un seul lot sur cet emplacement';
    if (l.type === 'cosse') {
      const c = remplissageCosses(liste);
      return `Encore ${Math.max(0, COSSES_PAR_PALETTE - c.plates)} cosse(s) plate(s) et ${Math.max(0, COSSES_AXIALES_PAR_PALETTE - c.axiales)} axiale(s)`;
    }
    const reste = capacitePalette(l) - nombreProduits(liste);
    return `Encore ${reste} bobine(s) de cette taille`;
  }

  // Texte de la capacité dans le détail d'un emplacement
  detailCapacite(code: string): string {
    const k = this.carton(code);
    if (k && this.contenus(code)[0]?.type === 'connecteur') return `Palette de connecteurs n° ${k.numero} · ${k.cosses} carton${k.cosses > 1 ? 's' : ''}`;
    if (k) return `Palette de cartons de cosses n° ${k.numero} · ${k.cosses} cosse${k.cosses > 1 ? 's' : ''} · seule sur l'emplacement`;
    const r = this.remplissage(code);
    const type = this.contenus(code)[0]?.type;
    if (!r) return '1 palette';
    if (type === 'connecteur') return `1 palette · ${r}`;
    if (type === 'cosse') {
      const c = remplissageCosses(this.contenus(code));
      return `1 palette · ${c.plates}/${COSSES_PAR_PALETTE} cosses plates · ${c.axiales}/${COSSES_AXIALES_PAR_PALETTE} axiales`;
    }
    return `1 palette · ${r} bobines`;
  }

  // Dans la case : 5 caractères par référence (le détail complet s'affiche au clic sur l'emplacement)
  references(code: string): string {
    const court = (r: string) => (r.length > 5 ? r.slice(0, 5) + '…' : r);
    return [...new Set(this.contenus(code).map((l) => court(l.reference)))].join(' · ');
  }

  compter(lettre: string): number {
    return TOUS_LES_EMPLACEMENTS.filter((e) => e.bloc === lettre).length;
  }

  choisir(e: Emplacement): void {
    this.selection.set(e);
    // Derniers mouvements de cet emplacement (détail)
    this.mouvementsSelection.set([]);
    this.stockService.getHistoriqueEmplacements({ emplacement: e.code }).subscribe((m) => {
      if (this.selection()?.code === e.code) this.mouvementsSelection.set(m.slice(0, 5));
    });
  }

  // ---------- Historique des changements d'emplacement ----------
  readonly origines = ORIGINES_MOUVEMENT;
  readonly listeOrigines = Object.entries(ORIGINES_MOUVEMENT) as [string, string][];
  historique = signal<MouvementEmplacement[]>([]);
  readonly libellesRoles = LIBELLES_ROLES as Record<string, string>;

  // Historique regroupé par jour (Aujourd'hui, Hier, puis la date)
  historiqueParJour = computed(() => {
    const jours: { cle: string; titre: string; mouvements: MouvementEmplacement[] }[] = [];
    for (const m of this.historique()) {
      const cle = m.date.slice(0, 10);
      let jour = jours[jours.length - 1];
      if (!jour || jour.cle !== cle) {
        jour = { cle, titre: this.titreJour(cle), mouvements: [] };
        jours.push(jour);
      }
      jour.mouvements.push(m);
    }
    return jours;
  });

  private titreJour(cle: string): string {
    const jour = (decalage: number) => {
      const d = new Date();
      d.setDate(d.getDate() - decalage);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    if (cle === jour(0)) return "Aujourd'hui";
    if (cle === jour(1)) return 'Hier';
    const [a, mo, j] = cle.split('-').map(Number);
    const texte = new Date(a, mo - 1, j).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return texte.charAt(0).toUpperCase() + texte.slice(1);
  }

  initiales(nom: string | null): string {
    return (nom ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
  }
  chargementHistorique = signal(false);
  mouvementsSelection = signal<MouvementEmplacement[]>([]);
  filtreHistRef = signal('');
  filtreHistEmpl = signal('');
  filtreHistOrigine = signal('');

  chargerHistorique(): void {
    this.chargementHistorique.set(true);
    this.stockService
      .getHistoriqueEmplacements({
        reference: this.filtreHistRef(),
        emplacement: this.filtreHistEmpl(),
        origine: this.filtreHistOrigine(),
      })
      .subscribe({
        next: (m) => {
          this.historique.set(m);
          this.chargementHistorique.set(false);
        },
        error: () => this.chargementHistorique.set(false),
      });
  }

  // Télécharge tout l'historique (filtres appliqués) en PDF ou en Excel
  telechargementHistorique = signal<'pdf' | 'excel' | null>(null);
  telechargerHistorique(format: 'pdf' | 'excel'): void {
    this.telechargementHistorique.set(format);
    this.stockService
      .telechargerHistoriqueEmplacements(format, {
        reference: this.filtreHistRef(),
        emplacement: this.filtreHistEmpl(),
        origine: this.filtreHistOrigine(),
      })
      .subscribe({
        next: (reponse) => {
          this.telechargementHistorique.set(null);
          enregistrerFichier(reponse, format === 'pdf' ? 'historique-emplacements.pdf' : 'historique-emplacements.xlsx');
        },
        error: (err: HttpErrorResponse) => {
          this.telechargementHistorique.set(null);
          this.toast.afficher(err.status === 0 ? 'Serveur injoignable' : 'Téléchargement impossible', true);
        },
      });
  }

  effacerFiltresHistorique(): void {
    this.filtreHistRef.set('');
    this.filtreHistEmpl.set('');
    this.filtreHistOrigine.set('');
    this.chargerHistorique();
  }

  // Recherche d'un code (ex. C215) : sélectionne la case et la fait défiler à l'écran
  chercher(): void {
    const saisie = this.recherche().trim().toUpperCase();
    if (!saisie) return;
    // Numéro du magasin (12 ou 0012, ou une lettre du niveau 3 du bloc E) → code de l'application (A110)
    const numero = /^\d+$/.test(saisie) ? saisie.padStart(4, '0') : saisie;
    const code = [...NUMEROS_MAGASIN].find(([, n]) => n === numero)?.[0] ?? saisie;
    const trouve =
      TOUS_LES_EMPLACEMENTS.find((e) => e.code === code) ?? this.placesTampon().find((e) => e.code === code);
    if (!trouve) {
      this.erreurRecherche.set(`L'emplacement ${code} n'existe pas.`);
      return;
    }
    this.erreurRecherche.set('');
    this.onglet.set(trouve.bloc === 'T' ? 'tampon' : 'plan');
    if (this.filtreBloc() && this.filtreBloc() !== trouve.bloc) this.filtreBloc.set(this.vue() === '3d' && trouve.bloc !== 'T' ? trouve.bloc : '');
    this.selection.set(trouve);
    setTimeout(() =>
      this.hote.nativeElement
        .querySelector(`[data-code="${trouve.code}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
    );
  }

  // Type rangé à ce niveau du bloc (le bloc E a aussi des cosses au niveau 3)
  typeNiveau(bloc: string, niveau: number): 'bobine' | 'cosse' | 'connecteur' {
    return BLOCS.find((b) => b.lettre === bloc)?.niveauxCosses.includes(niveau) ? 'cosse' : typeDuNiveau(niveau);
  }

  libelleNiveau(niveau: number, bloc: string): string {
    const usage = { bobine: 'bobines', cosse: 'cosses', connecteur: 'connecteurs' }[this.typeNiveau(bloc, niveau)];
    return `${niveau === 0 ? 'Niveau 0 (sol)' : `Niveau ${niveau}`} · ${usage}`;
  }

  // « 00 à 10 » (façade 1), « 11 à 21 » (façade 2) ; bloc E : 00 à 13 et 14 à 27
  plage(f: Facade): string {
    const numeros = f.niveaux[0].emplacements.map((e) => e.numero);
    const deux = (n: number) => String(n).padStart(2, '0');
    return `${deux(Math.min(...numeros))} à ${deux(Math.max(...numeros))}`;
  }

  readonly estTampon = estTampon;

  libelleFacade(e: Emplacement): string {
    const f = BLOCS.find((b) => b.lettre === e.bloc)!.facades.find((x) => x.numero === e.facade)!;
    return `${f.libelle} · ${f.allee}`;
  }
}
