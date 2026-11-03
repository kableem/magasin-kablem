import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import {
  FiltresReclamations,
  ImportReclame,
  MOTIFS_RECLAMATION,
  ProduitReclame,
  ReceptionService,
  SOLUTIONS_RECLAMATION,
  STATUTS_RECLAMATION,
  SolutionReclamation,
  CompteursReclamations,
  StatutReclamation,
  formatNombre,
  libelleMotif,
  libelleProduit,
  libelleSolution,
  libelleStatut,
} from '../../services/reception';
import { AuthService, peutGererMagasin } from '../../services/auth';
import { ToastService } from '../../services/toast';
import { enregistrerFichier } from '../../services/telechargement';

// Historique des réclamations : chaque import et ses produits réclamés
// (manquants, non conformes, endommagés, non commandés…), téléchargeable en PDF ou Excel.
@Component({
  selector: 'app-reclamations',
  imports: [FormsModule, DatePipe, RouterLink],
  templateUrl: './reclamations.html',
  styleUrl: './reclamations.css',
})
export class Reclamations implements OnInit {
  private service = inject(ReceptionService);
  private toast = inject(ToastService);
  private auth = inject(AuthService);

  // Suivi avec l'Italie et délai : administrateur et chef de magasin
  readonly estGestionnaire = computed(() => peutGererMagasin(this.auth.utilisateur()));
  readonly statuts = STATUTS_RECLAMATION;
  readonly solutions = SOLUTIONS_RECLAMATION;
  readonly libelleStatut = libelleStatut;
  readonly libelleSolution = libelleSolution;

  filtreStatut = signal(''); // '', ouverte, envoyee, reglee, en_retard

  // Fenêtre de suivi d'une réclamation
  aSuivre = signal<ProduitReclame | null>(null);
  suivi = { statut: 'ouverte' as StatutReclamation, solution: null as SolutionReclamation | null, note: '' };
  erreurSuivi = signal('');
  enregistrementSuivi = signal(false);

  // Nombre de réclamations par statut et délai de retard
  compteurs = signal<CompteursReclamations | null>(null);
  saisieDelai = signal(7);
  erreurDelai = signal('');

  readonly motifs = MOTIFS_RECLAMATION;
  readonly libelle = libelleProduit;
  readonly libelleMotif = libelleMotif;
  readonly nombre = formatNombre;

  imports = signal<ImportReclame[]>([]);
  chargement = signal(true);
  erreur = signal('');
  telechargement = signal<string | null>(null); // format en cours de téléchargement

  // Filtres combinables
  filtreReference = signal('');
  filtreMotif = signal('');
  dateDu = signal('');
  dateAu = signal('');

  private filtres(): FiltresReclamations {
    return {
      statut: this.filtreStatut(),
      reference: this.filtreReference(),
      motif: this.filtreMotif(),
      du: this.dateDu(),
      au: this.dateAu(),
    };
  }

  readonly nbFiltresActifs = computed(
    () =>
      [this.filtreStatut(), this.filtreReference().trim(), this.filtreMotif(), this.dateDu(), this.dateAu()].filter(Boolean)
        .length
  );

  readonly nbProduits = computed(() => this.imports().reduce((s, i) => s + i.produits.length, 0));

  // Quantité réclamée par motif (cartes en haut de page)
  readonly parMotif = computed(() =>
    this.motifs.map((m) => ({
      ...m,
      quantite: this.imports()
        .flatMap((i) => i.produits)
        .filter((p) => p.motif === m.valeur)
        .reduce((s, p) => s + p.quantite, 0),
    }))
  );

  ngOnInit(): void {
    this.charger();
    this.chargerCompteurs();
  }

  filtrerStatut(statut: string): void {
    this.filtreStatut.set(statut);
    this.charger();
  }

  // ---------- Suivi avec l'Italie ----------
  ouvrirSuivi(p: ProduitReclame): void {
    this.aSuivre.set(p);
    this.suivi = { statut: p.statut, solution: p.solution, note: p.note_suivi ?? '' };
    this.erreurSuivi.set('');
  }

  enregistrerSuivi(): void {
    const p = this.aSuivre();
    if (!p) return;
    if (this.suivi.statut === 'reglee' && !this.suivi.solution) {
      this.erreurSuivi.set('Indiquez la solution : avoir, renvoi, remplacement ou autre.');
      return;
    }
    this.enregistrementSuivi.set(true);
    this.service
      .suivreReclamation(p.id, {
        statut: this.suivi.statut,
        solution: this.suivi.statut === 'reglee' ? this.suivi.solution : null,
        note: this.suivi.note.trim() || null,
      })
      .subscribe({
        next: () => {
          this.enregistrementSuivi.set(false);
          this.aSuivre.set(null);
          this.toast.afficher(`${p.reference} : ${libelleStatut(this.suivi.statut)}`);
          this.charger();
          this.chargerCompteurs();
        },
        error: (err: HttpErrorResponse) => {
          this.enregistrementSuivi.set(false);
          this.erreurSuivi.set(err.error?.message || 'Enregistrement impossible');
        },
      });
  }

  // ---------- Compteurs par statut ----------
  chargerCompteurs(): void {
    this.service.getCompteursReclamations().subscribe({
      next: (c) => {
        this.compteurs.set(c);
        this.saisieDelai.set(c.delai_jours);
      },
      error: () => this.compteurs.set(null),
    });
  }

  enregistrerDelai(): void {
    const n = Number(this.saisieDelai());
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      this.erreurDelai.set('Entrez un nombre de jours entre 1 et 365.');
      return;
    }
    this.service.setDelaiReclamation(n).subscribe({
      next: () => {
        this.erreurDelai.set('');
        this.toast.afficher(`Une réclamation non réglée est en retard après ${n} jours`);
        this.charger();
        this.chargerCompteurs();
      },
      error: (err: HttpErrorResponse) => this.erreurDelai.set(err.error?.message || 'Modification impossible'),
    });
  }

  charger(): void {
    this.chargement.set(true);
    this.service.getReclamations(this.filtres()).subscribe({
      next: (data) => {
        this.imports.set(data);
        this.chargement.set(false);
        this.erreur.set('');
      },
      error: () => {
        this.chargement.set(false);
        this.erreur.set('Impossible de charger les réclamations (API lancée ?)');
      },
    });
  }

  effacerFiltres(): void {
    this.filtreReference.set('');
    this.filtreMotif.set('');
    this.dateDu.set('');
    this.dateAu.set('');
    this.charger();
  }

  filtrerMotif(motif: string): void {
    this.filtreMotif.set(this.filtreMotif() === motif ? '' : motif);
    this.charger();
  }

  // Télécharge la liste affichée (filtres appliqués), ou un seul import
  telecharger(format: 'pdf' | 'excel' | 'mail', importId?: number): void {
    const cle = format + (importId ?? '');
    this.telechargement.set(cle);
    const filtres = importId ? { import: importId } : this.filtres();
    this.service.telechargerReclamations(format, filtres).subscribe({
      next: (reponse) => {
        this.telechargement.set(null);
        enregistrerFichier(reponse, { pdf: 'reclamations.pdf', excel: 'reclamations.xlsx', mail: 'reclamation.eml' }[format]);
        if (format === 'mail') {
          this.toast.afficher('Mail prêt : ouvrez le fichier téléchargé, il s\'ouvre dans Outlook avec le PDF joint. Indiquez le destinataire puis envoyez.');
        }
      },
      error: (err: HttpErrorResponse) => {
        this.telechargement.set(null);
        this.toast.afficher(err.status === 0 ? 'Serveur injoignable' : 'Téléchargement impossible', true);
      },
    });
  }
}
