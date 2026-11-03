import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import {
  ApercuExport,
  LotDisponible,
  MOTIFS_DEPLACEMENT,
  MotifChangement,
  LimitesConnecteurs,
  DESTINATIONS_EXPORT,
  VerificationStock,
  DestinationExport,
  LigneStock,
  ReceptionService,
  TYPES_PRODUIT,
  TypeProduit,
  formatNombre,
  libelleProduit,
} from '../../services/reception';
import { ToastService } from '../../services/toast';
import { AuthService, peutGererMagasin } from '../../services/auth';
import {
  EMPLACEMENTS_PAR_PROXIMITE,
  LIBELLE_NIVEAUX_TYPE,
  RANG_PROXIMITE,
  codeDuNumero,
  typeEmplacement,
  NUMEROS_MAGASIN,
  TOUS_LES_EMPLACEMENTS,
  estTampon,
  placesTampon,
  capacitePalette,
  placeConnecteur,
  placeDisponible,
} from '../emplacements/plan-magasin';

@Component({
  selector: 'app-stock',
  imports: [FormsModule, DatePipe, RouterLink],
  templateUrl: './stock.html',
  styleUrl: './stock.css',
})
export class Stock implements OnInit {
  private service = inject(ReceptionService);
  private toast = inject(ToastService);
  private auth = inject(AuthService);

  // L'administrateur et le chef de magasin choisissent ou changent un emplacement ; le magasinier le consulte
  readonly estAdmin = computed(() => peutGererMagasin(this.auth.utilisateur()));
  // L'administrateur (seul) peut faire une sortie depuis le web sans donner de motif
  readonly estAdministrateur = computed(() => this.auth.utilisateur()?.role === 'admin');

  readonly types = TYPES_PRODUIT;
  readonly libelle = libelleProduit;
  readonly nombre = formatNombre;
  readonly libelleNiveaux = LIBELLE_NIVEAUX_TYPE;

  // Une ligne par entrée en stock, déjà triée par le serveur (référence puis FIFO)
  lignes = signal<LigneStock[]>([]);
  chargement = signal(true);
  erreur = signal('');
  recherche = signal('');
  filtreType = signal<TypeProduit | ''>('');

  // Fenêtre d'affectation d'un emplacement à une palette
  aAffecter = signal<LigneStock | null>(null);
  codeSaisi = signal('');
  erreurAffectation = signal('');
  enregistrement = signal(false);
  // Motif obligatoire du changement (enregistré dans l'historique)
  readonly motifsDeplacement = MOTIFS_DEPLACEMENT;
  motifChangement: MotifChangement = { motif: '', commentaire: '' };

  rangement = signal(false); // rangement automatique en cours

  // Sortie vers la production : le magasinier saisit seulement la quantité,
  // le serveur choisit les lots (FIFO obligatoire) et les emplacements
  aExporter = signal<{ reference: string; type: TypeProduit; taille_bobine: LigneStock['taille_bobine']; disponible: number } | null>(null);
  quantiteExport = signal<number | null>(null);
  readonly destinations = DESTINATIONS_EXPORT;
  destinationExport = signal<DestinationExport | ''>(''); // obligatoire
  apercu = signal<ApercuExport | null>(null);
  erreurExport = signal('');
  motifSecours = ''; // sortie web sans contrôle mobile : motif obligatoire
  exportEnCours = signal(false);
  // Administrateur : sortie sans FIFO, il choisit la quantité sur chaque lot
  sansFifo = signal(false);
  lotsLibres = signal<LotDisponible[]>([]);
  quantitesLibres = signal<number[]>([]);
  readonly totalLibre = computed(() => this.quantitesLibres().reduce((s, q) => s + (q > 0 ? q : 0), 0));
  private demandeApercu = 0; // ignore les réponses d'aperçu dépassées

  // Contenu de chaque emplacement
  readonly occupants = computed(() => {
    const m = new Map<string, LigneStock[]>();
    for (const l of this.lignes())
      if (l.emplacement) m.set(l.emplacement, [...(m.get(l.emplacement) ?? []), l]);
    return m;
  });

  // Emplacements où la ligne peut aller : niveau prévu pour son type
  // (bobines : 0, cosses : 1-2, connecteurs : 3-4) et place sur la palette
  // (1 grande bobine, 2 moyennes ou 6 petites de même taille ; 1 palette de cosses / connecteurs)
  readonly emplacementsLibres = computed(() => {
    const ligne = this.aAffecter();
    if (!ligne) return [];
    const occupants = this.occupants();
    // Connecteurs : volume, poids et hauteur du niveau (sans compter la ligne elle-même)
    const accepte = (code: string, niveau: number) => {
      const occ = (occupants.get(code) ?? []).filter((o) => o.id !== ligne.id);
      return ligne.type === 'connecteur'
        ? placeConnecteur(ligne, occ, niveau, this.limites())
        : placeDisponible(ligne, occupants.get(code) ?? []);
    };
    // Du plus proche au plus loin de la porte, puis la zone tampon
    return [
      ...EMPLACEMENTS_PAR_PROXIMITE.filter((e) => typeEmplacement(e) === ligne.type && accepte(e.code, e.niveau)).map(
        (e) => e.code
      ),
      ...placesTampon(this.capaciteTampon()).filter((c) => accepte(c, 3)),
    ];
  });

  readonly capacite = capacitePalette;
  readonly estTampon = estTampon;
  // Comme la page Emplacements : le numéro du magasin (0012) quand l'étiquette en a un, sinon le code
  nom(code: string | null | undefined): string {
    return code ? NUMEROS_MAGASIN.get(code) ?? code : '';
  }
  capaciteTampon = signal(20);
  limites = signal<LimitesConnecteurs>({ longueur: 120, largeur: 80, hauteur_n3: 100, hauteur_n4: 150, taux: 85, poids_max: 15 });
  readonly rang = RANG_PROXIMITE;

  // Niveau 4 : il faut l'élévateur pour y prendre un produit
  estNiveau4(code: string | null): boolean {
    return !!code && /^[A-H]4\d{2}$/.test(code);
  }

  // Lignes à ranger : sans emplacement, ou en zone tampon (à ranger dès qu'une place se libère)
  readonly nbSansEmplacement = computed(
    () => this.lignes().filter((l) => !l.emplacement || estTampon(l.emplacement)).length
  );
  readonly nbTampon = computed(() => this.lignes().filter((l) => estTampon(l.emplacement)).length);

  readonly filtrees = computed(() => {
    const q = this.recherche().trim().toLowerCase();
    const type = this.filtreType();
    return this.lignes().filter(
      (l) => (!type || l.type === type) && (!q || l.reference.toLowerCase().includes(q))
    );
  });

  readonly total = computed(() => this.filtrees().reduce((somme, l) => somme + l.quantite, 0));

  // Références trouvées par la recherche, avec leur quantité totale : chacune a son bouton « Exporter »
  readonly referencesTrouvees = computed(() => {
    if (!this.recherche().trim()) return [];
    const m = new Map<string, { reference: string; type: TypeProduit; taille_bobine: LigneStock['taille_bobine']; disponible: number }>();
    for (const l of this.filtrees()) {
      const r = m.get(l.reference) ?? { reference: l.reference, type: l.type, taille_bobine: l.taille_bobine, disponible: 0 };
      r.disponible += l.quantite;
      m.set(l.reference, r);
    }
    return [...m.values()];
  });

  // Une carte par type : quantité en stock et nombre de références différentes
  readonly parType = computed(() =>
    this.types.map((t) => {
      const liste = this.lignes().filter((l) => l.type === t.valeur);
      return {
        ...t,
        quantite: liste.reduce((somme, l) => somme + l.quantite, 0),
        references: new Set(liste.map((l) => l.reference)).size,
      };
    })
  );

  // ---------- Synchronisation : stock du magasin comparé à la base ----------
  verification = signal<VerificationStock | null>(null);
  verificationEnCours = signal(false);
  panneauVerification = signal(false);
  detailsOuverts = signal<string | null>(null);
  readonly titresStatut = { ok: 'Stock conforme', alerte: 'Stock conforme, points à surveiller', erreur: 'Écarts détectés' };
  readonly textesStatut = {
    ok: 'Le stock du magasin correspond exactement à la base de données.',
    alerte: 'Le stock correspond à la base. Quelques actions sont en attente.',
    erreur: 'Le stock du magasin ne correspond pas à la base sur certains points. Voir le détail ci-dessous.',
  };

  // ouvrir = true : affiche le résultat (bouton) ; false : contrôle discret à l'ouverture de la page
  synchroniser(ouvrir = true): void {
    this.verificationEnCours.set(true);
    if (ouvrir) this.charger();
    this.service.verifierStock().subscribe({
      next: (v) => {
        this.verification.set(v);
        this.verificationEnCours.set(false);
        if (ouvrir) {
          this.detailsOuverts.set(v.controles.find((c) => c.statut === 'erreur')?.cle ?? null);
          this.panneauVerification.set(true);
        }
      },
      error: (err: HttpErrorResponse) => {
        this.verificationEnCours.set(false);
        if (ouvrir) this.toast.afficher(err.status === 0 ? 'Serveur injoignable' : 'Synchronisation impossible', true);
      },
    });
  }

  basculerDetails(cle: string): void {
    this.detailsOuverts.set(this.detailsOuverts() === cle ? null : cle);
  }

  ngOnInit(): void {
    this.charger();
    this.synchroniser(false);
    this.service.getParametres().subscribe((p) => {
      this.capaciteTampon.set(p.tampon_capacite);
      if (p.connecteurs) this.limites.set(p.connecteurs);
    });
  }

  private charger(): void {
    this.service.getStock().subscribe({
      next: (data) => {
        this.lignes.set(data);
        this.chargement.set(false);
      },
      error: () => {
        this.chargement.set(false);
        this.erreur.set('Impossible de charger le stock (API lancée ?)');
      },
    });
  }

  ouvrirAffectation(l: LigneStock): void {
    if (!this.estAdmin()) return;
    this.aAffecter.set(l);
    this.codeSaisi.set(this.nom(l.emplacement));
    this.erreurAffectation.set('');
    this.motifChangement = { motif: '', commentaire: '' };
  }

  affecter(code: string | null): void {
    const ligne = this.aAffecter();
    if (!ligne) return;
    // Code de l'application (A110) ou numéro du magasin (0012)
    const valeur = codeDuNumero(code) ?? (code?.trim().toUpperCase() || null);
    const emplacement = valeur ? TOUS_LES_EMPLACEMENTS.find((e) => e.code === valeur) : null;
    if (valeur && !estTampon(valeur) && !emplacement) {
      this.erreurAffectation.set(`L'emplacement ${valeur} n'existe pas (code A000 à H410, ou numéro du magasin comme 0012).`);
      return;
    }
    if (emplacement && typeEmplacement(emplacement) !== ligne.type) {
      this.erreurAffectation.set(
        `Une palette « ${this.libelle(ligne)} » se range au ${this.libelleNiveaux[ligne.type]} (${valeur} est au niveau ${emplacement.niveau}).`
      );
      return;
    }
    if (!this.motifChangement.motif) {
      this.erreurAffectation.set("Choisissez le motif du changement d'emplacement.");
      return;
    }
    if (this.motifChangement.motif === 'autre' && !this.motifChangement.commentaire.trim()) {
      this.erreurAffectation.set('Motif « Autre » : précisez la raison dans le commentaire.');
      return;
    }
    this.enregistrement.set(true);
    this.service.affecterEmplacement(ligne.id, valeur, ligne.ids, this.motifChangement).subscribe({
      next: () => {
        this.enregistrement.set(false);
        this.aAffecter.set(null);
        this.toast.afficher(valeur ? `${ligne.reference} rangé en ${valeur}` : `Emplacement retiré pour ${ligne.reference}`);
        this.charger();
      },
      error: (err: HttpErrorResponse) => {
        this.enregistrement.set(false);
        this.erreurAffectation.set(err.error?.message || "Erreur lors de l'affectation.");
      },
    });
  }

  rangerAutomatiquement(): void {
    this.rangement.set(true);
    this.service.rangerAutomatiquement().subscribe({
      next: ({ ranges, enTampon, sansPlace }) => {
        this.rangement.set(false);
        this.toast.afficher(
          sansPlace
            ? `${ranges} rangé(s) · ${enTampon} en zone tampon · ${sansPlace} sans place (zone tampon pleine)`
            : enTampon
              ? `${ranges} rangé(s) · ${enTampon} en zone tampon (plus de place libre)`
              : `${ranges} rangé(s) automatiquement`,
          enTampon + sansPlace > 0
        );
        this.charger();
      },
      error: (err: HttpErrorResponse) => {
        this.rangement.set(false);
        this.toast.afficher(err.error?.message || 'Rangement impossible', true);
      },
    });
  }

  // ---------- Export vers la production ----------
  ouvrirExport(r: { reference: string; type: TypeProduit; taille_bobine: LigneStock['taille_bobine']; disponible: number }, sansFifo = false): void {
    this.aExporter.set(r);
    this.basculerSansFifo(sansFifo);
    this.quantiteExport.set(null);
    this.destinationExport.set('');
    this.apercu.set(null);
    this.erreurExport.set('');
    this.motifSecours = '';
  }

  // Passe de la sortie FIFO à la sortie choisie (administrateur) : charge tous les lots de la référence
  basculerSansFifo(actif: boolean): void {
    const r = this.aExporter();
    this.sansFifo.set(actif);
    this.lotsLibres.set([]);
    this.quantitesLibres.set([]);
    this.erreurExport.set('');
    if (!actif || !r) return;
    this.service.lotsDisponibles(r.reference).subscribe({
      next: ({ lignes }) => {
        this.lotsLibres.set(lignes);
        this.quantitesLibres.set(lignes.map(() => 0));
      },
      error: (err: HttpErrorResponse) => this.erreurExport.set(err.error?.message || 'Erreur'),
    });
  }

  changerQuantiteLibre(index: number, valeur: number | null): void {
    const max = this.lotsLibres()[index]?.quantite ?? 0;
    const q = Math.max(0, Math.min(max, Math.floor(Number(valeur) || 0)));
    this.quantitesLibres.update((liste) => liste.map((v, i) => (i === index ? q : v)));
    this.erreurExport.set('');
  }

  // Tout le lot (ou rien) d'un clic
  toutLeLot(index: number): void {
    const lot = this.lotsLibres()[index];
    if (lot) this.changerQuantiteLibre(index, this.quantitesLibres()[index] === lot.quantite ? 0 : lot.quantite);
  }

  confirmerSansFifo(): void {
    const r = this.aExporter();
    const destination = this.destinationExport();
    if (!r || !this.estAdministrateur()) return;
    if (!destination) {
      this.erreurExport.set('Choisissez la destination : P1, P2, P3, CET ou MCW.');
      return;
    }
    const choix = this.lotsLibres()
      .map((l, i) => ({ ids: l.ids, quantite: this.quantitesLibres()[i] }))
      .filter((c) => c.quantite > 0);
    if (!choix.length) {
      this.erreurExport.set('Indiquez la quantité à sortir sur au moins un lot.');
      return;
    }
    this.exportEnCours.set(true);
    this.service.exporterChoix(r.reference, choix, destination, this.motifSecours.trim()).subscribe({
      next: ({ quantite, hors_fifo, placesLiberees }) => {
        this.exportEnCours.set(false);
        this.aExporter.set(null);
        this.toast.afficher(
          `Sortie ${hors_fifo ? 'hors FIFO' : '(conforme au FIFO)'} : ${quantite} × ${r.reference} vers ${destination}` +
            (placesLiberees.length ? ` · place(s) libérée(s) : ${placesLiberees.map((e) => this.nom(e)).join(', ')}` : '')
        );
        this.charger();
      },
      error: (err: HttpErrorResponse) => {
        // Le stock a pu changer : on recharge les lots
        this.exportEnCours.set(false);
        const message = err.error?.message || 'Sortie impossible';
        this.basculerSansFifo(true);
        this.erreurExport.set(message);
        this.service.getStock().subscribe((data) => this.lignes.set(data));
      },
    });
  }

  // À chaque quantité saisie, le serveur indique ce que le FIFO va sortir (lots et emplacements)
  changerQuantiteExport(valeur: number | null): void {
    const r = this.aExporter();
    this.quantiteExport.set(valeur);
    this.apercu.set(null);
    this.erreurExport.set('');
    if (!r || valeur === null) return;
    if (!Number.isInteger(valeur) || valeur <= 0) {
      this.erreurExport.set('La quantité doit être un nombre entier positif.');
      return;
    }
    if (valeur > r.disponible) {
      this.erreurExport.set(`Stock insuffisant : ${r.disponible} disponible(s).`);
      return;
    }
    const n = ++this.demandeApercu;
    this.service.apercuExport(r.reference, valeur).subscribe({
      next: (a) => n === this.demandeApercu && this.apercu.set(a),
      error: (err: HttpErrorResponse) => n === this.demandeApercu && this.erreurExport.set(err.error?.message || 'Erreur'),
    });
  }

  confirmerExport(): void {
    const r = this.aExporter();
    const quantite = this.quantiteExport();
    if (!r || !quantite || !this.apercu()) return;
    const destination = this.destinationExport();
    if (!destination) {
      this.erreurExport.set('Choisissez la destination : P1, P2, P3, CET ou MCW.');
      return;
    }
    if (!this.estAdmin()) return;
    const motif = this.motifSecours.trim();
    if (motif.length < 3 && !(this.estAdministrateur() && !motif)) {
      this.erreurExport.set('Indiquez le motif de la sortie sans contrôle mobile (ex. téléphone en panne).');
      return;
    }
    this.exportEnCours.set(true);
    this.service.exporter(r.reference, quantite, destination, motif).subscribe({
      next: ({ placesLiberees }) => {
        this.exportEnCours.set(false);
        this.aExporter.set(null);
        this.toast.afficher(
          `Sortie de secours : ${quantite} × ${r.reference} vers ${destination}` +
            (placesLiberees.length ? ` · place(s) libérée(s) : ${placesLiberees.join(', ')}` : '')
        );
        this.charger();
      },
      error: (err: HttpErrorResponse) => {
        // Le stock a pu changer entre l'aperçu et la confirmation : on recalcule
        this.exportEnCours.set(false);
        this.erreurExport.set(err.error?.message || 'Sortie impossible');
        this.service.getStock().subscribe((data) => this.lignes.set(data));
      },
    });
  }

  filtrerType(type: TypeProduit | ''): void {
    this.filtreType.set(this.filtreType() === type ? '' : type);
  }

  // Trace une séparation entre deux références différentes
  nouvelleReference(index: number): boolean {
    const liste = this.filtrees();
    return index > 0 && liste[index].reference !== liste[index - 1].reference;
  }
}
