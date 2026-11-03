import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../services/auth';
import { ToastService } from '../../services/toast';
import { LIBELLES_ROLES, Role, Utilisateur, UtilisateurService } from '../../services/utilisateur';

@Component({
  selector: 'app-utilisateurs',
  imports: [FormsModule, DatePipe],
  templateUrl: './utilisateurs.html',
  styleUrl: './utilisateurs.css',
})
export class Utilisateurs implements OnInit {
  private service = inject(UtilisateurService);
  private auth = inject(AuthService);
  private toastService = inject(ToastService);

  readonly libellesRoles = LIBELLES_ROLES;
  readonly roles = Object.keys(LIBELLES_ROLES) as Role[];
  readonly moi = computed(() => this.auth.utilisateur()?.id);

  utilisateurs = signal<Utilisateur[]>([]);
  chargement = signal(true);
  erreur = signal('');

  recherche = signal('');
  filtreRole = signal<Role | ''>('');

  // Formulaire (ajout / modification)
  formOuvert = signal(false);
  editionId = signal<number | null>(null);
  form: Utilisateur = this.formVide();
  erreurForm = signal('');
  enregistrement = signal(false);
  afficherMdp = signal(false);

  // Confirmation de suppression
  aSupprimer = signal<Utilisateur | null>(null);

  readonly filtres = computed(() => {
    const q = this.recherche().trim().toLowerCase();
    const role = this.filtreRole();
    return this.utilisateurs().filter(
      (u) =>
        (!role || u.role === role) &&
        (!q || `${u.prenom} ${u.nom} ${u.matricule}`.toLowerCase().includes(q))
    );
  });

  readonly stats = computed(() => {
    const liste = this.utilisateurs();
    return {
      total: liste.length,
      admins: liste.filter((u) => u.role === 'admin').length,
      chefs: liste.filter((u) => u.role === 'chef_magasin').length,
      magasiniers: liste.filter((u) => u.role === 'magasinier').length,
      planificateurs: liste.filter((u) => u.role === 'planificateur').length,
      inactifs: liste.filter((u) => !u.actif).length,
    };
  });

  ngOnInit(): void {
    this.charger();
  }

  charger(): void {
    this.service.getUtilisateurs().subscribe({
      next: (data) => {
        this.utilisateurs.set(data);
        this.chargement.set(false);
        this.erreur.set('');
      },
      error: () => {
        this.chargement.set(false);
        this.erreur.set("Impossible de charger les utilisateurs (API lancée ?)");
      },
    });
  }

  ouvrirAjout(): void {
    this.editionId.set(null);
    this.form = this.formVide();
    this.ouvrirForm();
  }

  ouvrirModification(u: Utilisateur): void {
    this.editionId.set(u.id!);
    this.form = { ...u, actif: !!u.actif, motDePasse: '' };
    this.ouvrirForm();
  }

  fermerForm(): void {
    this.formOuvert.set(false);
  }

  // Le matricule n'accepte que des chiffres : tout autre caractère est retiré pendant la saisie
  chiffresSeulement(evenement: Event): void {
    const champ = evenement.target as HTMLInputElement;
    const chiffres = champ.value.replace(/\D/g, '');
    if (chiffres !== champ.value) champ.value = chiffres;
    this.form.matricule = chiffres;
  }

  enregistrer(): void {
    const f = this.form;
    if (!f.matricule.trim() || !f.prenom.trim() || !f.nom.trim()) {
      this.erreurForm.set('Matricule, prénom et nom sont obligatoires.');
      return;
    }
    if (!/^\d+$/.test(f.matricule.trim())) {
      this.erreurForm.set('Le matricule doit contenir uniquement des chiffres.');
      return;
    }
    if (!this.editionId() && !f.motDePasse) {
      this.erreurForm.set('Le mot de passe est obligatoire pour un nouveau compte.');
      return;
    }

    const id = this.editionId();
    const requete = id ? this.service.modifier(id, f) : this.service.ajouter(f);
    this.enregistrement.set(true);
    requete.subscribe({
      next: () => {
        this.enregistrement.set(false);
        this.formOuvert.set(false);
        this.afficherToast(id ? 'Utilisateur modifié' : `Compte ${f.matricule} créé`);
        this.charger();
      },
      error: (err: HttpErrorResponse) => {
        this.enregistrement.set(false);
        this.erreurForm.set(err.error?.message || "Erreur lors de l'enregistrement.");
      },
    });
  }

  basculerActif(u: Utilisateur): void {
    this.service.modifier(u.id!, { ...u, actif: !u.actif }).subscribe({
      next: () => {
        this.afficherToast(u.actif ? 'Compte désactivé' : 'Compte activé');
        this.charger();
      },
      error: (err: HttpErrorResponse) => this.afficherToast(err.error?.message || 'Erreur', true),
    });
  }

  confirmerSuppression(): void {
    const u = this.aSupprimer();
    if (!u) return;
    this.service.supprimer(u.id!).subscribe({
      next: () => {
        this.aSupprimer.set(null);
        this.afficherToast(`Compte ${u.matricule} supprimé`);
        this.charger();
      },
      error: (err: HttpErrorResponse) => {
        this.aSupprimer.set(null);
        this.afficherToast(err.error?.message || 'Suppression impossible', true);
      },
    });
  }

  genererMotDePasse(): void {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const valeurs = crypto.getRandomValues(new Uint32Array(8));
    this.form.motDePasse = Array.from(valeurs, (v) => caracteres[v % caracteres.length]).join('');
    this.afficherMdp.set(true);
  }

  private afficherToast(message: string, erreur = false): void {
    this.toastService.afficher(message, erreur);
  }

  private ouvrirForm(): void {
    this.erreurForm.set('');
    this.afficherMdp.set(false);
    this.formOuvert.set(true);
  }

  private formVide(): Utilisateur {
    return { matricule: '', nom: '', prenom: '', role: 'magasinier', actif: true, motDePasse: '' };
  }
}
