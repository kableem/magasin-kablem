import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FiltresRanger, MouvementRanger, PersonneRanger, ReceptionService, SuiviRanger, formatNombre, libelleProduit } from '../../services/reception';
import { LIBELLES_ROLES } from '../../services/utilisateur';
import { enregistrerFichier } from '../../services/telechargement';
import { ToastService } from '../../services/toast';

type Periode = 'jour' | '7j' | '30j' | 'tout' | 'dates';

// Date locale AAAA-MM-JJ, décalée de n jours
function dateLocale(decalage = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + decalage);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const aujourdhui = () => dateLocale();

// « Ranger le magasin » (page Emplacements) : les magasiniers rangent librement avec le mobile, sans
// suggestion du système ; ici le chef et le directeur suivent ce qui a été fait : chiffres de la période,
// travail de chaque personne, chaque déplacement (qui, quand, quel produit, d'où, vers où, emplacement
// libéré) et les déplacements refusés par les contrôles. Fichiers Excel et PDF de l'historique.
@Component({
  selector: 'app-ranger-magasin',
  imports: [FormsModule, DatePipe],
  templateUrl: './ranger-magasin.html',
  styleUrl: './ranger-magasin.css',
})
export class RangerMagasin implements OnInit {
  private service = inject(ReceptionService);
  private toast = inject(ToastService);
  readonly nombre = formatNombre;
  readonly libelleProduit = libelleProduit;
  readonly roles = LIBELLES_ROLES as Record<string, string | undefined>;

  readonly periodes: { valeur: Periode; libelle: string }[] = [
    { valeur: 'jour', libelle: "Aujourd'hui" },
    { valeur: '7j', libelle: '7 jours' },
    { valeur: '30j', libelle: '30 jours' },
    { valeur: 'tout', libelle: 'Tout' },
  ];
  readonly periode = signal<Periode>('jour');
  du = '';
  au = '';
  par = '';
  reference = '';
  emplacement = '';

  readonly suivi = signal<SuiviRanger | null>(null);
  readonly chargement = signal(false);
  readonly erreur = signal('');
  readonly telechargement = signal<'excel' | 'pdf' | null>(null);

  // Déplacements regroupés par jour (Aujourd'hui, Hier, puis la date)
  readonly parJour = computed(() => {
    const jours: { cle: string; titre: string; mouvements: MouvementRanger[]; liberes: number }[] = [];
    const titre = (cle: string) =>
      cle === dateLocale() ? "Aujourd'hui" : cle === dateLocale(-1) ? 'Hier' : cle.split('-').reverse().join('/');
    for (const m of this.suivi()?.mouvements ?? []) {
      const cle = m.date.slice(0, 10);
      let j = jours[jours.length - 1];
      if (!j || j.cle !== cle) jours.push((j = { cle, titre: titre(cle), mouvements: [], liberes: 0 }));
      j.mouvements.push(m);
      if (m.depuis_liberee) j.liberes++;
    }
    return jours;
  });

  // Part de chaque personne dans les déplacements de la période (barre)
  readonly maxDeplacements = computed(() => Math.max(1, ...(this.suivi()?.par_personne ?? []).map((p) => p.deplacements)));

  ngOnInit(): void {
    this.charger();
  }

  private filtres(): FiltresRanger {
    const bornes: Record<Periode, [string, string]> = {
      jour: [dateLocale(), dateLocale()],
      '7j': [dateLocale(-6), dateLocale()],
      '30j': [dateLocale(-29), dateLocale()],
      tout: ['', ''],
      dates: [this.du, this.au],
    };
    const [du, au] = bornes[this.periode()];
    return { du, au, par: this.par, reference: this.reference.trim(), emplacement: this.emplacement.trim().toUpperCase() };
  }

  charger(): void {
    this.chargement.set(true);
    this.erreur.set('');
    this.service.getSuiviRanger(this.filtres()).subscribe({
      next: (s) => {
        this.suivi.set(s);
        this.chargement.set(false);
      },
      error: (e: HttpErrorResponse) => {
        this.chargement.set(false);
        this.erreur.set(e.status === 0 ? "Serveur injoignable. Vérifiez que l'API est lancée." : (e.error?.message ?? 'Chargement impossible'));
      },
    });
  }

  choisirPeriode(p: Periode): void {
    this.periode.set(p);
    if (p !== 'dates') {
      this.du = '';
      this.au = '';
    }
    this.charger();
  }

  // Dates saisies à la main : période « dates »
  changerDates(): void {
    this.periode.set(this.du || this.au ? 'dates' : 'tout');
    this.charger();
  }

  // Un clic sur une personne : ses déplacements seulement (un 2e clic enlève le filtre)
  filtrerPersonne(p: PersonneRanger): void {
    this.par = this.par === p.matricule ? '' : p.matricule;
    this.charger();
  }

  effacer(): void {
    this.par = '';
    this.reference = '';
    this.emplacement = '';
    this.charger();
  }

  nomComplet(p: { prenom: string | null; nom: string | null; matricule: string | null }): string {
    return [p.prenom, p.nom].filter(Boolean).join(' ') || p.matricule || '—';
  }

  initiales(p: { prenom: string | null; nom: string | null; matricule: string | null }): string {
    const lettres = [p.prenom, p.nom].filter(Boolean).map((x) => x!.trim().charAt(0).toUpperCase()).join('');
    return lettres || p.matricule?.slice(0, 2) || '?';
  }

  // Tout l'historique de « Ranger le magasin » (mêmes filtres) en Excel ou en PDF
  telecharger(format: 'excel' | 'pdf'): void {
    this.telechargement.set(format);
    this.service.telechargerHistoriqueEmplacements(format, { ...this.filtres(), origine: 'regroupement' }).subscribe({
      next: (reponse) => {
        this.telechargement.set(null);
        enregistrerFichier(reponse, format === 'pdf' ? 'ranger-le-magasin.pdf' : 'ranger-le-magasin.xlsx');
      },
      error: () => {
        this.telechargement.set(null);
        this.toast.afficher('Téléchargement impossible', true);
      },
    });
  }
}
