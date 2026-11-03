import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  ExportProduction,
  ReceptionService,
  TYPES_PRODUIT,
  TypeProduit,
  formatNombre,
  libelleProduit,
} from '../../services/reception';

// Historique des sorties vers la production. Une sortie se fait depuis Gestion de stock
// (bouton « Exporter ») : les lots et les emplacements sont imposés par le FIFO.
@Component({
  selector: 'app-export',
  imports: [FormsModule, DatePipe, RouterLink],
  templateUrl: './export.html',
  styleUrl: './export.css',
})
export class Export implements OnInit {
  private service = inject(ReceptionService);

  readonly types = TYPES_PRODUIT;
  readonly libelle = libelleProduit;
  readonly nombre = formatNombre;

  exports = signal<ExportProduction[]>([]);
  chargement = signal(true);
  erreur = signal('');

  // Filtres combinables
  filtreReference = signal('');
  filtreLot = signal('');
  filtreType = signal<TypeProduit | ''>('');
  dateDu = signal(''); // AAAA-MM-JJ, date de la sortie
  dateAu = signal('');

  readonly nbFiltresActifs = computed(
    () =>
      [this.filtreReference().trim(), this.filtreLot().trim(), this.filtreType(), this.dateDu(), this.dateAu()].filter(
        Boolean
      ).length
  );

  readonly filtres = computed(() => {
    const ref = this.filtreReference().trim().toLowerCase();
    const lot = this.filtreLot().trim().toLowerCase();
    const type = this.filtreType();
    const du = this.dateDu();
    const au = this.dateAu();
    return this.exports().filter((e) => {
      const jour = e.date_export.slice(0, 10);
      return (
        (!ref || e.reference.toLowerCase().includes(ref)) &&
        (!lot || e.details.some((d) => d.lot.toLowerCase().includes(lot))) &&
        (!type || e.type === type) &&
        (!du || jour >= du) &&
        (!au || jour <= au)
      );
    });
  });

  readonly totalSorti = computed(() => this.filtres().reduce((s, e) => s + e.quantite, 0));

  ngOnInit(): void {
    this.service.getExports().subscribe({
      next: (data) => {
        this.exports.set(data);
        this.chargement.set(false);
      },
      error: () => {
        this.chargement.set(false);
        this.erreur.set('Impossible de charger les exports (API lancée ?)');
      },
    });
  }

  effacerFiltres(): void {
    this.filtreReference.set('');
    this.filtreLot.set('');
    this.filtreType.set('');
    this.dateDu.set('');
    this.dateAu.set('');
  }
}
