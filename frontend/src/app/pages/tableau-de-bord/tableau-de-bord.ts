import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  MOTIFS_RECLAMATION,
  ReceptionService,
  TableauDeBord,
  ZoneRemplissage,
  formatNombre,
  libelleMotif,
} from '../../services/reception';

type Etat = 'bon' | 'attention' | 'critique';

// Tableau de bord du chef de magasin (et de l'administrateur) :
// remplissage, alertes, activité du jour et de la semaine, réclamations.
@Component({
  selector: 'app-tableau-de-bord',
  imports: [DatePipe, RouterLink],
  templateUrl: './tableau-de-bord.html',
  styleUrl: './tableau-de-bord.css',
})
export class TableauDeBordPage implements OnInit {
  private service = inject(ReceptionService);

  readonly nombre = formatNombre;
  readonly libelleMotif = libelleMotif;
  readonly motifs = MOTIFS_RECLAMATION;
  readonly maintenant = new Date();

  donnees = signal<TableauDeBord | null>(null);
  chargement = signal(true);
  erreur = signal('');
  derniereMaj = signal<Date | null>(null);
  survol = signal<number | null>(null); // jour survolé dans le graphique

  // Seuils : vert sous 80 %, orange de 80 à 90 %, rouge à partir de 90 %
  etatZone(z: ZoneRemplissage): Etat {
    return z.taux >= 90 ? 'critique' : z.taux >= 80 ? 'attention' : 'bon';
  }
  readonly libelleEtat: Record<Etat, string> = { bon: 'Correct', attention: 'À surveiller', critique: 'Critique' };

  // Largeur (%) d'un segment libre / partiel / plein dans la barre d'une zone
  part(z: ZoneRemplissage, n: number): number {
    return z.total ? (100 * n) / z.total : 0;
  }

  readonly nbCritiques = computed(() => this.donnees()?.alertes.filter((a) => a.niveau === 'critique').length ?? 0);

  // Graphique des 7 derniers jours : une seule échelle pour les entrées et les sorties
  readonly maxJour = computed(() => {
    const jours = this.donnees()?.activite.jours ?? [];
    const max = Math.max(1, ...jours.flatMap((j) => [j.entres, j.sortis]));
    // graduation lisible : 5, 10, 20, 50, 100…
    const pas = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    return pas.find((p) => p >= max) ?? max;
  });
  hauteur(v: number): number {
    return (100 * v) / this.maxJour();
  }

  readonly totalSortiesSemaine = computed(() =>
    (this.donnees()?.activite.destinations ?? []).reduce((s, d) => s + d.quantite, 0)
  );

  quantiteMotif(motif: string): number {
    return this.donnees()?.reclamations.par_motif.find((m) => m.motif === motif)?.quantite ?? 0;
  }
  readonly totalReclame = computed(() =>
    (this.donnees()?.reclamations.par_motif ?? []).reduce((s, m) => s + m.quantite, 0)
  );

  ngOnInit(): void {
    this.charger();
  }

  charger(): void {
    this.chargement.set(true);
    this.service.getTableauDeBord().subscribe({
      next: (d) => {
        this.donnees.set(d);
        this.chargement.set(false);
        this.erreur.set('');
        this.derniereMaj.set(new Date());
      },
      error: () => {
        this.chargement.set(false);
        this.erreur.set('Impossible de charger le tableau de bord (API lancée ?)');
      },
    });
  }
}
