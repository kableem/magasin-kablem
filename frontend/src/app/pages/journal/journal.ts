import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FiltresJournal, LigneJournal, RESULTATS_ALERTE, ReceptionService, ResumeJournal } from '../../services/reception';
import { ToastService } from '../../services/toast';
import { enregistrerFichier } from '../../services/telechargement';

// Journal des alertes du mobile : faux emplacements, mauvais produits, écarts, produits inconnus.
// Le chef contrôle le travail des magasiniers (qui, quand, quoi, où) et exporte en Excel / PDF.
@Component({
  selector: 'app-journal',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './journal.html',
  styleUrl: './journal.css',
})
export class Journal implements OnInit, OnDestroy {
  private service = inject(ReceptionService);
  private toast = inject(ToastService);
  readonly resultats = RESULTATS_ALERTE;

  readonly lignes = signal<LigneJournal[]>([]);
  readonly resume = signal<ResumeJournal | null>(null);
  readonly utilisateurs = signal<{ id: number; matricule: string; nom: string; role: string }[]>([]);
  readonly chargement = signal(true);
  readonly erreur = signal('');
  readonly telechargement = signal<'pdf' | 'excel' | null>(null);

  // Filtres (7 derniers jours par défaut)
  du = jour(-6);
  au = jour(0);
  utilisateur = '';
  reference = '';
  controle = '';
  resultat = '';
  readonly tout = signal(false); // false = alertes seulement
  manuel = false;

  readonly tauxAlertes = computed(() => {
    const r = this.resume();
    return r && r.total ? Math.round((1000 * r.alertes) / r.total) / 10 : 0;
  });
  readonly maxAlertes = computed(() => Math.max(1, ...(this.resume()?.par_magasinier.map((m) => m.alertes) ?? [1])));

  private minuterie: ReturnType<typeof setInterval> | undefined;

  ngOnInit(): void {
    this.service.getUtilisateursJournal().subscribe({ next: (u) => this.utilisateurs.set(u), error: () => {} });
    this.charger();
    // les scans du mobile arrivent presque en direct
    this.minuterie = setInterval(() => document.visibilityState === 'visible' && this.charger(true), 15000);
  }

  ngOnDestroy(): void {
    clearInterval(this.minuterie);
  }

  filtres(): FiltresJournal {
    return {
      du: this.du, au: this.au, utilisateur: this.utilisateur, reference: this.reference.trim(), controle: this.controle,
      resultat: this.resultat, niveau: this.tout() ? 'tout' : 'alertes', manuel: this.manuel ? '1' : '',
    };
  }

  charger(discret = false): void {
    if (!discret) this.chargement.set(true);
    const f = this.filtres();
    this.service.getJournal(f).subscribe({
      next: (l) => {
        this.lignes.set(l);
        this.chargement.set(false);
        this.erreur.set('');
      },
      error: (e: HttpErrorResponse) => {
        this.chargement.set(false);
        if (!discret) this.erreur.set(e.status === 0 ? "Serveur injoignable. Vérifiez que l'API est lancée." : (e.error?.message ?? 'Chargement impossible'));
      },
    });
    this.service.getResumeJournal(f).subscribe({ next: (r) => this.resume.set(r), error: () => {} });
  }

  basculerTout(valeur: boolean): void {
    this.tout.set(valeur);
    this.resultat = '';
    this.charger();
  }

  voirMagasinier(id: number): void {
    this.utilisateur = this.utilisateur === String(id) ? '' : String(id);
    this.charger();
  }

  periode(jours: number): void {
    this.du = jour(-(jours - 1));
    this.au = jour(0);
    this.charger();
  }

  effacer(): void {
    this.du = jour(-6);
    this.au = jour(0);
    this.utilisateur = '';
    this.reference = '';
    this.controle = '';
    this.resultat = '';
    this.manuel = false;
    this.tout.set(false);
    this.charger();
  }

  telecharger(format: 'pdf' | 'excel'): void {
    this.telechargement.set(format);
    this.service.telechargerJournal(format, this.filtres()).subscribe({
      next: (r) => {
        this.telechargement.set(null);
        enregistrerFichier(r, format === 'pdf' ? 'journal-alertes.pdf' : 'journal-alertes.xlsx');
      },
      error: (e: HttpErrorResponse) => {
        this.telechargement.set(null);
        this.toast.afficher(e.status === 0 ? 'Serveur injoignable' : 'Téléchargement impossible', true);
      },
    });
  }

  lieu(l: LigneJournal): string {
    if (l.controle === 'reception') return l.numero_livraison ?? (l.import_id ? `Import n° ${l.import_id}` : '');
    if (l.controle === 'export') return l.destination ? `Sortie → ${l.destination}` : 'Sortie';
    // Ranger le magasin : départ → arrivée scannés
    if (l.controle === 'ranger') return [l.emplacement_prevu, l.emplacement_scanne].filter(Boolean).join(' → ');
    return '';
  }
}

// Date du jour + décalage, au format AAAA-MM-JJ
function jour(decalage: number): string {
  const d = new Date();
  d.setDate(d.getDate() + decalage);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
