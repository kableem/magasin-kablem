import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
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
  BilanSuppression,
  ReferenceAttendue,
  StatutReference,
  CartonImport,
  PaletteCossesImport,
} from '../../services/reception';
import { ToastService } from '../../services/toast';
import { ImportManuel } from './import-manuel';
import { ImportResume } from './import-resume';
import { EmplPipe } from '../emplacements/empl.pipe';
import { AuthService, peutGererMagasin } from '../../services/auth';
import { EMPLACEMENTS_PAR_PROXIMITE, RANG_PROXIMITE, codeDuNumero, estTampon, nomEmplacement, placesTampon, typeEmplacement } from '../emplacements/plan-magasin';

@Component({
  selector: 'app-import',
  imports: [FormsModule, DatePipe, ImportManuel, ImportResume, EmplPipe],
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
  // Import par référence (fichier de l'Italie : référence + total de pièces) : administrateur et chef
  readonly saisieResume = signal(false);
  // Suppression d'un import (administrateur) : ce qui sera effacé, motif, confirmation tapée
  readonly aSupprimer = signal<ImportArrivage | null>(null);
  readonly bilanSuppression = signal<BilanSuppression | null>(null);
  readonly erreurSuppression = signal('');
  readonly suppressionEnCours = signal(false);
  motifSuppression = '';
  confirmationSuppression = '';
  // Suppression complète : efface aussi l'historique des emplacements et les scans mobiles de l'import
  readonly suppressionComplete = signal(false);

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
  readonly libellesAnomalie = {
    manquant: 'Manquant', en_trop: 'Colis en trop', hors_import: 'Hors import', pieces_manquantes: 'Pièces manquantes', pieces_en_trop: 'Pièces en trop',
  } as const;
  // Import résumé : bilan de chaque référence (pièces reçues / annoncées)
  readonly statutsReference: Record<StatutReference, string> = {
    non_recue: 'Pas encore reçue', conforme: 'Conforme', tolere: 'Petit écart accepté', manquant: 'Manquant', en_trop: 'En trop',
  };

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
        (!this.filtreProduitActif() || i.produits.some((p) => this.correspond(p)) || (i.pieces?.references ?? []).some((r) => this.correspondReference(r)))
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
      if (document.visibilityState === 'visible' && !this.aConfirmer() && !this.aReclamer() && !this.aSupprimer()) this.charger(true);
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

  // ---------- Suppression d'un import (administrateur) ----------
  ouvrirSuppression(i: ImportArrivage, complet = false): void {
    this.suppressionComplete.set(complet);
    this.aSupprimer.set(i);
    this.bilanSuppression.set(null);
    this.erreurSuppression.set('');
    this.motifSuppression = '';
    this.confirmationSuppression = '';
    this.service.bilanSuppression(i.id).subscribe({
      next: (b) => this.bilanSuppression.set(b),
      error: (err: HttpErrorResponse) => this.erreurSuppression.set(this.message(err)),
    });
  }

// ---------- Cartons de cosses : étiquettes (115 × 75 mm) ----------
  // La date système du 1er clic (à la milliseconde) entre dans le QR : chaque étiquette est unique.
  readonly impression = signal<number | null>(null); // import dont les étiquettes s'impriment

  cartonsAImprimer(i: ImportArrivage): number {
    return i.cartons.filter((c) => c.statut !== 'ouvert' && !c.imprime).length;
  }

  // Étiquettes d'une seule palette : celles pas encore imprimées, sinon toutes (réimpression)
  imprimerPalette(i: ImportArrivage, paletteId: number): void {
    this.ouvrirPdf(i, this.service.etiquettesCartons(i.id, paletteId));
  }

  aImprimerPalette(i: ImportArrivage, paletteId: number): number {
    return this.cartonsDe(i, paletteId).filter((c) => c.statut !== 'ouvert' && !c.imprime).length;
  }

  imprimablesPalette(i: ImportArrivage, paletteId: number): boolean {
    return this.cartonsDe(i, paletteId).some((c) => c.statut !== 'ouvert');
  }


  // Palettes de cosses : les cartons de chaque palette, et ceux sans palette (cas ancien)
  cartonsDe(i: ImportArrivage, paletteId: number | null): CartonImport[] {
    return i.cartons.filter((c) => (c.palette_id ?? null) === paletteId && (c.cosses > 0 || c.statut === 'ouvert'));
  }

  groupesCartons(i: ImportArrivage): { palette: PaletteCossesImport | null; cartons: CartonImport[] }[] {
    const groupes = i.palettes_cosses.map((p) => ({ palette: p as PaletteCossesImport | null, cartons: this.cartonsDe(i, p.id) }));
    const sans = this.cartonsDe(i, null);
    return sans.length ? [...groupes, { palette: null, cartons: sans }] : groupes;
  }

  etatPalette(p: PaletteCossesImport): { texte: string; ton: string } {
    if (p.statut === 'ouverte') return { texte: 'Ouverte (réception en cours)', ton: 'en_trop' };
    if (p.statut === 'terminee') return p.etiquettes_a_imprimer
      ? { texte: `${p.etiquettes_a_imprimer} étiquette(s) à imprimer`, ton: 'en_trop' }
      : { texte: 'Prête : à ranger', ton: 'tolere' };
    return p.en_stock ? { texte: `Rangée en ${p.emplacement}`, ton: 'conforme' } : { texte: 'Vide (tout est sorti)', ton: 'conforme' };
  }

  imprimerCarton(i: ImportArrivage, id: number): void {
    this.ouvrirPdf(i, this.service.etiquetteCarton(id));
  }

  // Pointage (toute la liste des références) en PDF, ouvert dans un nouvel onglet : imprimer ou enregistrer
  pointagePdf(i: ImportArrivage): void {
    this.ouvrirPdf(i, this.service.pointagePdf(i.id));
  }


  // Le PDF s'ouvre dans un nouvel onglet, prêt pour l'imprimante d'étiquettes (format 115 × 75 mm, échelle 100 %)
  private ouvrirPdf(i: ImportArrivage, demande: Observable<Blob>): void {
    const onglet = window.open('', '_blank'); // ouvert tout de suite : le navigateur ne le bloque pas
    this.impression.set(i.id);
    demande.subscribe({
      next: (pdf) => {
        this.impression.set(null);
        const url = URL.createObjectURL(pdf);
        if (onglet) onglet.location.href = url;
        else window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 120000);
        this.charger(true);
      },
      error: async (err: HttpErrorResponse) => {
        this.impression.set(null);
        onglet?.close();
        // la réponse d'erreur arrive en Blob : on lit son message
        let message = this.message(err);
        if (err.error instanceof Blob) message = JSON.parse(await err.error.text()).message ?? message;
        this.toast.afficher(message, true);
      },
    });
  }

  // Reçus hors import : leur référence a été ajoutée au catalogue, ils entrent au stock
  entrerHorsImport(i: ImportArrivage): void {
    this.occupe.set(i.id);
    this.service.entrerHorsImport(i.id).subscribe({
      next: (r) => {
        this.occupe.set(null);
        const faits = r.integres.map((x) => `${x.reference} ×${x.quantite}`).join(', ');
        this.toast.afficher(
          (faits ? `Au stock : ${faits}. Rangez-les sur le mobile.` : 'Aucun produit ajouté.') +
            (r.en_attente.length ? ` Toujours absente(s) du catalogue : ${r.en_attente.join(', ')}.` : ''),
          !faits
        );
        this.charger();
      },
      error: (err: HttpErrorResponse) => {
        this.occupe.set(null);
        this.toast.afficher(this.message(err), true);
      },
    });
  }

  // « 0342, 0343, … » (numéros des étiquettes)
  nomsEmplacements(codes: string[]): string {
    return codes.map((c) => nomEmplacement(c)).join(', ');
  }

  confirmationValide(): boolean {
    const b = this.bilanSuppression();
    return !!b && this.confirmationSuppression.trim().toUpperCase() === b.confirmation.toUpperCase();
  }

  supprimer(): void {
    const i = this.aSupprimer();
    const b = this.bilanSuppression();
    if (!i || !b) return;
    if (this.motifSuppression.trim().length < 3) return this.erreurSuppression.set('Indiquez le motif de la suppression.');
    if (!this.confirmationValide()) return this.erreurSuppression.set(`Pour confirmer, tapez exactement « ${b.confirmation} ».`);
    this.suppressionEnCours.set(true);
    this.service.supprimerImport(i.id, this.motifSuppression.trim(), this.confirmationSuppression.trim(), this.suppressionComplete()).subscribe({
      next: (r) => {
        this.suppressionEnCours.set(false);
        this.aSupprimer.set(null);
        const nom = r.numero_livraison ?? 'n° ' + r.id;
        this.toast.afficher(
          `Import ${nom} supprimé${this.suppressionComplete() ? ' avec toutes ses données' : ''}` +
            (r.produits_retires ? ` · ${formatNombre(r.produits_retires)} produit(s) retiré(s) du stock` : '') +
            (r.ajoutes_automatiquement.length ? ` · ${r.ajoutes_automatiquement.length} import(s) suivant(s) ajouté(s) au stock` : '')
        );
        this.charger();
        this.chargerSynchronisation();
      },
      error: (err: HttpErrorResponse) => {
        this.suppressionEnCours.set(false);
        this.erreurSuppression.set(this.message(err));
      },
    });
  }

  apresImportResume(r: { id: number; numero: string; references: number; pieces: number }): void {
    this.saisieResume.set(false);
    this.filtreStatut.set('');
    this.effacerFiltres();
    this.toast.afficher(`Import ${r.numero} créé · ${r.references} référence(s), ${formatNombre(r.pieces)} pièces annoncées, en attente de réception mobile`);
    this.charger();
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
    if (i.pieces) return i.pieces.attendues; // import résumé : pièces annoncées
    return i.produits.reduce((somme, p) => somme + (p.quantite ?? 0), 0);
  }

  // "3 bobines · 2 cosses"
  resume(i: ImportArrivage): { type: TypeProduit; texte: string }[] {
    // import résumé : les références annoncées (les lignes par lot naissent au scan)
    const liste: { type: TypeProduit | null }[] = i.pieces ? i.pieces.references : i.produits;
    return this.types
      .map((t) => ({ type: t.valeur, n: liste.filter((p) => p.type === t.valeur).length, libelle: t.libelle }))
      .filter((x) => x.n > 0)
      .map((x) => ({ type: x.type, texte: `${x.n} ${x.libelle.toLowerCase()}${x.n > 1 ? 's' : ''}` }));
  }

  // Le produit correspond à tous les filtres produit saisis
  // ---------- Recherche dans UN import (référence ou lot) : seules les lignes trouvées restent affichées ----------
  // Indépendante de la recherche globale du haut (qui choisit les imports affichés).
  readonly rechercheImport = signal<Record<number, string>>({});

  texteRecherche(i: ImportArrivage): string {
    return (this.rechercheImport()[i.id] ?? '').trim().toUpperCase();
  }

  chercherDansImport(i: ImportArrivage, texte: string): void {
    this.rechercheImport.update((r) => ({ ...r, [i.id]: texte }));
  }

  private trouveDans(i: ImportArrivage, ...valeurs: (string | null | undefined)[]): boolean {
    const q = this.texteRecherche(i);
    return !q || valeurs.some((v) => String(v ?? '').toUpperCase().includes(q));
  }

  refsVues(i: ImportArrivage, refs: ReferenceAttendue[]): ReferenceAttendue[] {
    return refs.filter((r) => this.trouveDans(i, r.reference, ...r.lots.map((l) => l.lot)));
  }

  produitsVus(i: ImportArrivage): ProduitImport[] {
    return i.produits.filter((p) => this.trouveDans(i, p.reference, p.lot));
  }

  groupesVus(i: ImportArrivage): { palette: PaletteCossesImport | null; cartons: CartonImport[] }[] {
    if (!this.texteRecherche(i)) return this.groupesCartons(i);
    return this.groupesCartons(i)
      .map((g) => ({ ...g, cartons: g.cartons.filter((c) => this.trouveDans(i, c.reference, c.lot)) }))
      .filter((g) => g.cartons.length || this.separeesVues(i, g.palette?.separees ?? []).length);
  }

  separeesVues<T extends { reference: string; lot: string }>(i: ImportArrivage, liste: T[]): T[] {
    return liste.filter((s) => this.trouveDans(i, s.reference, s.lot));
  }

  urgencesVues(i: ImportArrivage): ImportArrivage['urgences'] {
    return i.urgences.filter((u) => this.trouveDans(i, u.reference, u.lot));
  }

  // Résumé de la recherche : réception et rangement de ce qui est trouvé dans cet import
  resumeRecherche(i: ImportArrivage): {
    references: string[]; lots: string[]; recus: number; ranges: number; cartons: number; palettes: number[];
    pieces: { annoncees: number; recues: number } | null;
    // où se trouve ce qui est cherché : chaque palette (ses cartons, son emplacement) et les colis séparés
    ou: { palettes: { numero: number | null; cartons: number[]; emplacement: string | null; texte: string; ton: string }[]; separes: { colis: number; emplacement: string; range: boolean }[] };
  } | null {
    if (!this.texteRecherche(i)) return null;
    const produits = this.produitsVus(i);
    const refs = i.pieces ? this.refsVues(i, i.pieces.references) : [];
    const cartons = this.groupesVus(i).flatMap((g) => g.cartons.map((c) => ({ ...c, palette: g.palette?.numero ?? null })));
    const references = [...new Set([...produits.map((p) => p.reference), ...refs.map((r) => r.reference)])];
    const lots = [...new Set([...produits.map((p) => p.lot), ...refs.flatMap((r) => r.lots.map((l) => l.lot))])];
    return {
      references,
      lots,
      recus: produits.reduce((t, p) => t + (p.recus ?? 0), 0),
      ranges: produits.reduce((t, p) => t + (p.ranges ?? 0), 0),
      cartons: cartons.length,
      palettes: [...new Set(cartons.map((c) => c.palette).filter((n): n is number => n !== null))],
      pieces: i.pieces ? { annoncees: refs.reduce((t, r) => t + r.attendues, 0), recues: refs.reduce((t, r) => t + r.recues, 0) } : null,
      ou: {
        palettes: this.groupesVus(i).filter((g) => g.cartons.length).map((g) => {
          const p = g.palette;
          const rangee = p?.statut === 'rangee' && p.en_stock;
          return {
            numero: p?.numero ?? null,
            cartons: g.cartons.map((c) => c.numero),
            emplacement: rangee ? p!.emplacement : null,
            texte: !p ? 'cartons sans palette' : rangee ? 'Rangée en' : this.etatPalette(p).texte,
            ton: p ? this.etatPalette(p).ton : 'tolere',
          };
        }),
        // colis rangés ou à ranger seuls (cosses séparées) : leur emplacement imposé
        separes: produits.flatMap((p) => (p.affectations ?? []).filter((a) => !a.palette).map((a) => ({ colis: a.colis, emplacement: a.emplacement, range: !!a.range }))),
      },
    };
  }

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

  // Import résumé : la référence annoncée correspond aux filtres référence et type (pas de lot avant le scan)
  correspondReference(r: ReferenceAttendue): boolean {
    const ref = this.filtreReference().trim().toLowerCase();
    const type = this.filtreType();
    return !this.filtreLot().trim() && (!ref || r.reference.toLowerCase().includes(ref)) && (!type || r.type === type);
  }

  // « 40 500 / 45 000 »
  libelleEcart(r: ReferenceAttendue): string {
    if (!r.ecart) return '';
    return `${r.ecart > 0 ? '+' : '−'}${formatNombre(Math.abs(r.ecart))}`;
  }

  effacerFiltres(): void {
    this.filtreReference.set('');
    this.filtreLot.set('');
    this.filtreType.set('');
    this.dateDu.set('');
    this.dateAu.set('');
  }

  // ---------- Import en attente ----------

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
    // le numéro de l'étiquette (« 0342 ») est accepté comme le code
    const emplacement = codeDuNumero(valeur) ?? valeur.trim().toUpperCase();
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

  // ---------- Les deux étapes : 1 Réception (contrôle, écarts), 2 Rangement (après validation) ----------
  etatReception(i: ImportArrivage): 'attente' | 'en_cours' | 'ecarts' | 'fait' {
    if (i.statut === 'ajoute' || i.etape === 'receptionne') return 'fait';
    if (i.etape === 'a_valider') return 'ecarts';
    return i.reception === 'en_cours' ? 'en_cours' : 'attente';
  }

  texteReception(i: ImportArrivage): string {
    const a = i.avancement;
    const recus = a ? (i.pieces ? `${formatNombre(a.recus)}/${formatNombre(a.attendus)} pièces` : `${a.recus}/${a.attendus} reçus`) : '';
    if (i.statut === 'ajoute') return i.ajout_force ? 'Validée sans contrôle mobile (secours)' : `Validée${i.reception_par ? ' · reçue par ' + i.reception_par : ''}`;
    switch (i.etape) {
      case 'a_valider': return `Terminée avec ${a?.anomalies?.length ?? i.reception_ecarts} écart(s) : réglez-les puis validez`;
      case 'receptionne': return 'Terminée sans écart : validée à son tour (ordre d’arrivée)';
      case 'reception_en_cours': return `En cours sur le mobile · ${recus}`;
      default: return 'Pas commencée : le magasinier scanne chaque produit sur le mobile';
    }
  }

  // Tout ce qui est reçu se range pendant la réception (en parallèle), sans attendre la validation
  etatRangement(i: ImportArrivage): 'bloque' | 'en_cours' | 'fait' {
    if (i.statut !== 'ajoute') return i.avancement?.ranges ? 'en_cours' : 'bloque';
    return i.etape === 'range' || i.ajout_force ? 'fait' : 'en_cours';
  }

  texteRangement(i: ImportArrivage): string {
    if (i.statut !== 'ajoute') {
      const r = i.avancement?.ranges ?? 0;
      return r ? `En même temps que la réception · ${r} rangé(s)` : 'Possible dès qu’un produit est reçu (mobile, Rangement)';
    }
    if (i.ajout_force) return 'Entré au stock directement (secours)';
    const a = i.avancement;
    const colis = a?.colis_recus ?? a?.recus ?? 0;
    return i.etape === 'range' ? `Terminé · ${colis} produit(s) rangé(s)` : `Sur le mobile (Rangement) · ${a?.ranges ?? 0}/${colis} rangé(s)`;
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
