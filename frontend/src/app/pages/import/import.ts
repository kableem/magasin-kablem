import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ImportArrivage,
  ETAPES_IMPORT,
  MOTIFS_DEPLACEMENT,
  MotifChangement,
  MOTIFS_RECLAMATION,
  MotifReclamation,
  libelleMotif,
  PlacementPropose,
  ProduitImport,
  ReceptionService,
  StatutImport,
  TYPES_PRODUIT,
  TypeProduit,
  formatNombre,
  libelleProduit,
  AffectationColis,
} from '../../services/reception';
import { ToastService } from '../../services/toast';
import { ImportManuel } from './import-manuel';
import { AuthService, peutGererMagasin } from '../../services/auth';
import { EMPLACEMENTS_PAR_PROXIMITE, RANG_PROXIMITE, estTampon, placesTampon, typeEmplacement } from '../emplacements/plan-magasin';

@Component({
  selector: 'app-import',
  imports: [FormsModule, DatePipe, ImportManuel],
  templateUrl: './import.html',
  styleUrl: './import.css',
})
export class Import implements OnInit, OnDestroy {
  private service = inject(ReceptionService);
  private toast = inject(ToastService);
  private auth = inject(AuthService);

  // Seul l'administrateur peut modifier le plan de rangement proposé par le système
  readonly estAdmin = computed(() => peutGererMagasin(this.auth.utilisateur()));
  // Saisie d'un import à la main : administrateur seulement (essais)
  readonly estAdministrateur = computed(() => this.auth.utilisateur()?.role === 'admin');
  readonly saisieManuelle = signal(false);

  readonly types = TYPES_PRODUIT;
  readonly libelle = libelleProduit;
  readonly nombre = formatNombre;

  imports = signal<ImportArrivage[]>([]);
  chargement = signal(true);
  erreurListe = signal('');

  filtreStatut = signal<StatutImport | ''>('');
  // Filtres de recherche, combinables
  filtreReference = signal('');
  filtreLot = signal('');
  filtreType = signal<TypeProduit | ''>('');
  dateDu = signal(''); // AAAA-MM-JJ, date de l'import
  dateAu = signal('');
  ouverts = signal(new Set<number>()); // imports dépliés

  // Synchronisation avec la base de l'Italie (les imports ne sont plus saisis à la main)
  synchronisation = signal(false);
  disponibles = signal(0); // imports italiens pas encore récupérés
  derniereSynchro = signal<string | null>(null);
  ignores = signal<{ numero: string; raison: string }[]>([]);
  occupe = signal<number | null>(null); // import en cours d'enregistrement

  aConfirmer = signal<ImportArrivage | null>(null); // plan de rangement avant « Ajouter au stock »
  plan = signal<PlacementPropose[]>([]);
  chargementPlan = signal(false);
  erreurPlan = signal('');
  readonly estTampon = estTampon;
  readonly rang = RANG_PROXIMITE;
  capaciteTampon = signal(20);
  readonly nbTampon = computed(() =>
    this.plan().filter((p) => estTampon(p.emplacement)).reduce((s, p) => s + p.quantite, 0)
  );
  readonly nbSansPlace = computed(() => this.plan().filter((p) => !p.emplacement).reduce((s, p) => s + p.quantite, 0));
  // Plan modifié (administrateur, chef de magasin) : motif obligatoire, enregistré dans l'historique
  readonly motifsDeplacement = MOTIFS_DEPLACEMENT;
  motifPlan: MotifChangement = { motif: '', commentaire: '' };
  readonly planModifie = computed(() => this.plan().some((p) => p.regle === 0));
  // Ajout sans réception mobile (secours) : motif obligatoire, enregistré
  sansMobile = signal(false);
  motifForce = '';
  readonly etapes = ETAPES_IMPORT;
  readonly libellesAnomalie = { manquant: 'Manquant', en_trop: 'Colis en trop', hors_import: 'Hors import' } as const;

  // Réclamation d'un produit (manquant, non conforme…) : la quantité réclamée n'entre pas dans le stock
  readonly motifs = MOTIFS_RECLAMATION;
  readonly libelleMotif = libelleMotif;
  aReclamer = signal<{ import: ImportArrivage; produit: ProduitImport } | null>(null);
  // Emplacement imposé d'un colis : changement par le chef (motif obligatoire)
  aChangerColis = signal<{ produit: ProduitImport; affectation: AffectationColis } | null>(null);
  nouvelEmplacement = '';
  motifColis: MotifChangement = { motif: '', commentaire: '' };
  erreurColis = signal('');
  enregistrementColis = signal(false);
  reclamation = { motif: '' as MotifReclamation | '', quantite: 1 as number | null, commentaire: '' };
  erreurReclamation = signal('');
  enregistrementReclamation = signal(false);

  // Au moins un filtre sur les produits (référence, lot ou type) est actif
  readonly filtreProduitActif = computed(
    () => !!(this.filtreReference().trim() || this.filtreLot().trim() || this.filtreType())
  );

  readonly nbFiltresActifs = computed(
    () =>
      [this.filtreReference().trim(), this.filtreLot().trim(), this.filtreType(), this.dateDu(), this.dateAu()].filter(
        Boolean
      ).length
  );

  // Un import est affiché si sa date est dans la période et s'il contient
  // au moins un produit qui correspond à tous les filtres produit
  readonly filtres = computed(() => {
    const statut = this.filtreStatut();
    const du = this.dateDu();
    const au = this.dateAu();
    return this.imports().filter((i) => {
      const jour = i.date_creation.slice(0, 10);
      return (
        (!statut || i.statut === statut) &&
        (!du || jour >= du) &&
        (!au || jour <= au) &&
        (!this.filtreProduitActif() || i.produits.some((p) => this.correspond(p)))
      );
    });
  });

  readonly compteurs = computed(() => ({
    tous: this.imports().length,
    en_attente: this.imports().filter((i) => i.statut === 'en_attente').length,
    ajoute: this.imports().filter((i) => i.statut === 'ajoute').length,
  }));

  // La page suit le travail du mobile presque en direct (scans de réception)
  private minuterie: ReturnType<typeof setInterval> | undefined;

  ngOnDestroy(): void {
    clearInterval(this.minuterie);
  }

  ngOnInit(): void {
    this.charger();
    this.minuterie = setInterval(() => {
      if (document.visibilityState === 'visible' && !this.aConfirmer() && !this.aReclamer()) this.charger(true);
    }, 10000);
    this.chargerSynchronisation();
    this.service.getParametres().subscribe((p) => this.capaciteTampon.set(p.tampon_capacite));
  }

  // ---------- Synchronisation avec la base de l'Italie ----------
  chargerSynchronisation(): void {
    this.service.getSynchronisation().subscribe({
      next: (e) => {
        this.disponibles.set(e.disponibles);
        this.derniereSynchro.set(e.derniere_synchronisation);
      },
      error: () => {},
    });
  }

  synchroniser(): void {
    this.synchronisation.set(true);
    this.service.synchroniser().subscribe({
      next: ({ ajoutes, ignores }) => {
        this.synchronisation.set(false);
        this.ignores.set(ignores);
        if (ajoutes.length) {
          this.filtreStatut.set('');
          this.effacerFiltres();
          const produits = ajoutes.reduce((t, a) => t + a.produits, 0);
          this.toast.afficher(`${ajoutes.length} nouvel(s) import(s) récupéré(s) · ${produits} produit(s)`);
        } else {
          this.toast.afficher(ignores.length ? 'Aucun import récupéré : voir les imports à corriger' : 'Aucun nouvel import', !!ignores.length);
        }
        this.charger();
        this.chargerSynchronisation();
      },
      error: (err: HttpErrorResponse) => {
        this.synchronisation.set(false);
        this.toast.afficher(this.message(err), true);
      },
    });
  }

  apresSaisieManuelle(r: { id: number; numero: string; produits: number }): void {
    this.saisieManuelle.set(false);
    this.filtreStatut.set('');
    this.effacerFiltres();
    this.toast.afficher(`Import ${r.numero} créé · ${r.produits} produit(s), en attente de réception mobile`);
    this.charger();
  }

  // ---------- Affichage ----------
  estOuvert(i: ImportArrivage): boolean {
    return this.ouverts().has(i.id);
  }

  basculer(i: ImportArrivage): void {
    const s = new Set(this.ouverts());
    s.has(i.id) ? s.delete(i.id) : s.add(i.id);
    this.ouverts.set(s);
  }

  total(i: ImportArrivage): number {
    return i.produits.reduce((somme, p) => somme + (p.quantite ?? 0), 0);
  }

  // "3 bobines · 2 cosses"
  resume(i: ImportArrivage): { type: TypeProduit; texte: string }[] {
    return this.types
      .map((t) => ({ type: t.valeur, n: i.produits.filter((p) => p.type === t.valeur).length, libelle: t.libelle }))
      .filter((x) => x.n > 0)
      .map((x) => ({ type: x.type, texte: `${x.n} ${x.libelle.toLowerCase()}${x.n > 1 ? 's' : ''}` }));
  }

  // Le produit correspond à tous les filtres produit saisis
  correspond(p: ProduitImport): boolean {
    const ref = this.filtreReference().trim().toLowerCase();
    const lot = this.filtreLot().trim().toLowerCase();
    const type = this.filtreType();
    return (
      (!ref || p.reference.toLowerCase().includes(ref)) &&
      (!lot || p.lot.toLowerCase().includes(lot)) &&
      (!type || p.type === type)
    );
  }

  effacerFiltres(): void {
    this.filtreReference.set('');
    this.filtreLot.set('');
    this.filtreType.set('');
    this.dateDu.set('');
    this.dateAu.set('');
  }

  // ---------- Import en attente ----------
  // "40 × 30 × 15 cm · 2 kg"
  mesures(p: ProduitImport): string {
    return `${p.longueur} × ${p.largeur} × ${p.hauteur} cm · ${formatNombre(Number(p.poids))} kg`;
  }

  // Ouvre le plan de rangement proposé par le serveur pour cet import
  // sansMobile : secours (administrateur, chef) quand la réception mobile n'a pas été faite
  ouvrirPlan(i: ImportArrivage, sansMobile = false): void {
    this.service.getParametres().subscribe((p) => this.capaciteTampon.set(p.tampon_capacite));
    this.aConfirmer.set(i);
    this.sansMobile.set(sansMobile);
    this.motifForce = '';
    this.motifPlan = { motif: '', commentaire: '' };
    this.plan.set([]);
    this.erreurPlan.set('');
    this.chargementPlan.set(true);
    this.service.getPlanRangement(i.id).subscribe({
      next: (plan) => {
        this.plan.set(plan);
        this.chargementPlan.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.chargementPlan.set(false);
        this.erreurPlan.set(this.message(err));
      },
    });
  }

  // Emplacements proposés dans la saisie : ceux du niveau du produit, du plus proche au plus loin
  choixEmplacements(p: PlacementPropose): string[] {
    return [
      ...EMPLACEMENTS_PAR_PROXIMITE.filter((e) => typeEmplacement(e) === p.produit.type).map((e) => e.code),
      ...placesTampon(this.capaciteTampon()),
    ];
  }

  // Une ligne du plan = une quantité d'un produit à un emplacement ; l'administrateur peut la déplacer
  modifierPlacement(index: number, valeur: string): void {
    if (!this.estAdmin()) return;
    const emplacement = valeur.trim().toUpperCase();
    this.plan.set(
      this.plan().map((x, i) => (i === index ? { ...x, emplacement, regle: 0, motif: 'Choisi manuellement' } : x))
    );
    this.erreurPlan.set('');
  }

  confirmerAjoutStock(): void {
    const i = this.aConfirmer();
    if (!i) return;
    if (this.estAdmin() && this.planModifie()) {
      if (!this.motifPlan.motif) {
        this.erreurPlan.set('Plan modifié : choisissez le motif du changement.');
        return;
      }
      if (this.motifPlan.motif === 'autre' && !this.motifPlan.commentaire.trim()) {
        this.erreurPlan.set('Motif « Autre » : précisez la raison dans le commentaire.');
        return;
      }
    }
    if (this.sansMobile() && this.motifForce.trim().length < 3) {
      this.erreurPlan.set("Ajout sans réception mobile : indiquez le motif (ex. téléphone en panne).");
      return;
    }
    this.occupe.set(i.id);
    // Magasinier : le plan du système s'applique tel quel (aucun placement envoyé)
    const placements = this.estAdmin()
      ? this.plan().map(({ id, emplacement, quantite }) => ({ id, emplacement: emplacement ?? '', quantite }))
      : undefined;
    this.service.ajouterAuStock(
      i.id, placements, this.planModifie() ? this.motifPlan : undefined, this.sansMobile() ? this.motifForce.trim() : undefined
    ).subscribe({
      next: ({ produits, enTampon, secours, a_ranger, ajoutes_automatiquement }) => {
        this.occupe.set(null);
        this.aConfirmer.set(null);
        const suivants = ajoutes_automatiquement?.length
          ? ` · ${ajoutes_automatiquement.length} import(s) suivant(s) déjà réceptionné(s) ajouté(s) automatiquement`
          : '';
        this.toast.afficher(
          (secours
            ? `Import ajouté au stock sans mobile : ${produits} produit(s)${enTampon ? ', dont ' + enTampon + ' en zone tampon' : ''}`
            : `Plan de rangement validé : ${a_ranger} produit(s) à ranger avec le mobile, ils entrent au stock au rangement`) + suivants,
          enTampon > 0
        );
        this.charger();
      },
      error: (err: HttpErrorResponse) => {
        // Le plan reste ouvert pour corriger l'emplacement refusé
        this.occupe.set(null);
        this.erreurPlan.set(this.message(err));
      },
    });
  }

  // ---------- Réclamations ----------
  // Quantité qui entrera dans le stock (annoncée − réclamée)
  quantiteRetenue(p: ProduitImport): number {
    return (p.quantite ?? 0) - (p.reclamation?.quantite ?? 0);
  }

  totalReclame(i: ImportArrivage): number {
    return i.produits.reduce((s, p) => s + (p.reclamation?.quantite ?? 0), 0);
  }

  ouvrirChangementColis(p: ProduitImport, a: AffectationColis): void {
    if (!this.estAdmin() || a.range) return;
    this.aChangerColis.set({ produit: p, affectation: a });
    this.nouvelEmplacement = '';
    this.motifColis = { motif: '', commentaire: '' };
    this.erreurColis.set('');
  }

  enregistrerChangementColis(): void {
    const cible = this.aChangerColis();
    if (!cible) return;
    const code = this.nouvelEmplacement.trim().toUpperCase();
    if (!code) return this.erreurColis.set('Indiquez le nouvel emplacement (ex. C018).');
    if (!this.motifColis.motif) return this.erreurColis.set('Choisissez le motif du changement.');
    if (this.motifColis.motif === 'autre' && !this.motifColis.commentaire.trim()) return this.erreurColis.set('Motif « Autre » : précisez la raison.');
    this.enregistrementColis.set(true);
    this.service.changerAffectation(cible.affectation.id, code, this.motifColis).subscribe({
      next: (r) => {
        this.enregistrementColis.set(false);
        this.aChangerColis.set(null);
        this.toast.afficher(`Colis n° ${r.colis} : ${r.depuis} → ${r.emplacement}. Le mobile impose maintenant ${r.emplacement}.`);
        this.charger(true);
      },
      error: (err: HttpErrorResponse) => {
        this.enregistrementColis.set(false);
        this.erreurColis.set(this.message(err));
      },
    });
  }

  ouvrirReclamation(i: ImportArrivage, p: ProduitImport): void {
    this.aReclamer.set({ import: i, produit: p });
    this.reclamation = {
      motif: p.reclamation?.motif ?? '',
      quantite: p.reclamation?.quantite ?? p.quantite,
      commentaire: p.reclamation?.commentaire ?? '',
    };
    this.erreurReclamation.set('');
  }

  enregistrerReclamation(): void {
    const cible = this.aReclamer();
    if (!cible) return;
    const { motif, quantite, commentaire } = this.reclamation;
    const max = cible.produit.quantite ?? 0;
    if (!motif) return this.erreurReclamation.set('Choisissez le motif de la réclamation.');
    if (!Number.isInteger(quantite) || quantite! < 1 || quantite! > max) {
      return this.erreurReclamation.set(`La quantité réclamée doit être entre 1 et ${max}.`);
    }
    this.enregistrementReclamation.set(true);
    this.service
      .reclamer(cible.import.id, cible.produit.id!, { motif, quantite: quantite!, commentaire: commentaire.trim() || null })
      .subscribe({
        next: () => {
          this.enregistrementReclamation.set(false);
          this.aReclamer.set(null);
          this.toast.afficher(`${cible.produit.reference} : ${quantite} réclamé(s) — non ajouté(s) au stock`);
          this.charger();
        },
        error: (err: HttpErrorResponse) => {
          this.enregistrementReclamation.set(false);
          this.erreurReclamation.set(this.message(err));
        },
      });
  }

  annulerReclamation(): void {
    const cible = this.aReclamer();
    if (!cible) return;
    this.service.annulerReclamation(cible.import.id, cible.produit.id!).subscribe({
      next: () => {
        this.aReclamer.set(null);
        this.toast.afficher(`Réclamation annulée : ${cible.produit.reference} entrera en entier dans le stock`);
        this.charger();
      },
      error: (err: HttpErrorResponse) => this.erreurReclamation.set(this.message(err)),
    });
  }

  // ---------- Utilitaires ----------
  // discret = rafraîchissement automatique (mobile) : pas d'erreur affichée, dépliage conservé
  private charger(discret = false): void {
    this.service.getImports().subscribe({
      next: (data) => {
        const connus = new Set(this.imports().map((i) => i.id));
        this.imports.set(data);
        this.chargement.set(false);
        this.erreurListe.set('');
        // Les imports en attente sont dépliés par défaut (les nouveaux seulement lors d'un rafraîchissement)
        const ouverts = new Set(this.ouverts());
        for (const i of data) if (i.statut === 'en_attente' && (!discret || !connus.has(i.id))) ouverts.add(i.id);
        this.ouverts.set(ouverts);
      },
      error: () => {
        this.chargement.set(false);
        if (!discret) this.erreurListe.set('Impossible de charger les imports (API lancée ?)');
      },
    });
  }

  // Pourcentage de la barre de réception
  pourcentReception(i: ImportArrivage): number {
    const a = i.avancement;
    return a && a.attendus ? Math.min(100, Math.round((100 * a.recus) / a.attendus)) : 0;
  }

  private message(err: HttpErrorResponse): string {
    return err.status === 0 ? "Serveur injoignable. Vérifiez que l'API est lancée." : err.error?.message || 'Erreur';
  }

}
