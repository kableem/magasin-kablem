import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { pageAccueil } from '../../guards/auth-guard';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../services/auth';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login implements OnInit, OnDestroy {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private horloge?: ReturnType<typeof setInterval>;

  matricule = '';
  motDePasse = '';
  seSouvenir = true;

  afficherMdp = signal(false);
  chargement = signal(false);
  erreur = signal('');
  secouer = signal(false);
  majActive = signal(false);
  maintenant = signal(new Date());

  readonly annee = new Date().getFullYear();

  // Illustration : colis dans le camion (import)
  readonly colisCamion = [
    { x: 80, y: 244, w: 30, h: 28, c: 'bleu' },
    { x: 114, y: 250, w: 24, h: 22, c: 'clair' },
    { x: 142, y: 240, w: 26, h: 32, c: 'rouge' },
    { x: 84, y: 220, w: 22, h: 24, c: 'clair' },
  ];

  // Illustration : étagère de 3 niveaux (A, B, C) × 3 colonnes
  readonly cellules = ['A', 'B', 'C'].flatMap((niveau, l) =>
    [0, 1, 2].map((c) => ({ code: `${niveau}-0${c + 1}`, x: 350 + 77 * c, y: 120 + 60 * l }))
  );

  // Illustration : colis rangés en stock (A-02 reste libre pour le colis qui arrive)
  readonly stock = [
    { x: 358, y: 150, w: 30, h: 30, c: 'clair' },
    { x: 392, y: 158, w: 26, h: 22, c: 'rouge' },
    { x: 512, y: 146, w: 34, h: 34, c: 'bleu' },
    { x: 550, y: 160, w: 24, h: 20, c: 'clair' },
    { x: 358, y: 206, w: 62, h: 34, c: 'clair' },
    { x: 435, y: 212, w: 28, h: 28, c: 'rouge' },
    { x: 467, y: 212, w: 28, h: 28, c: 'clair' },
    { x: 358, y: 270, w: 28, h: 30, c: 'bleu' },
    { x: 390, y: 274, w: 30, h: 26, c: 'clair' },
    { x: 435, y: 266, w: 60, h: 34, c: 'clair' },
    { x: 512, y: 272, w: 30, h: 28, c: 'rouge' },
  ];

  readonly heure = computed(() =>
    this.maintenant().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  );
  readonly date = computed(() => {
    const d = this.maintenant().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    return d.charAt(0).toUpperCase() + d.slice(1);
  });
  // Équipes de l'usine : matin 6h-14h, après-midi 14h-22h, nuit 22h-6h
  readonly poste = computed(() => {
    const h = this.maintenant().getHours();
    if (h >= 6 && h < 14) return 'Poste du matin';
    if (h >= 14 && h < 22) return "Poste de l'après-midi";
    return 'Poste de nuit';
  });

  ngOnInit(): void {
    this.horloge = setInterval(() => this.maintenant.set(new Date()), 15000);
  }

  ngOnDestroy(): void {
    clearInterval(this.horloge);
  }

  verifierMajuscules(event: KeyboardEvent): void {
    this.majActive.set(event.getModifierState?.('CapsLock') ?? false);
  }

  connexion(): void {
    if (this.chargement()) return;
    if (!this.matricule.trim() || !this.motDePasse) {
      this.afficherErreur('Veuillez saisir votre matricule et votre mot de passe.');
      return;
    }

    this.chargement.set(true);
    this.erreur.set('');
    this.auth.login(this.matricule.trim(), this.motDePasse, this.seSouvenir).subscribe({
      next: () => {
        const retour = this.route.snapshot.queryParamMap.get('retour') || pageAccueil(this.auth);
        this.router.navigateByUrl(retour);
      },
      error: (err: HttpErrorResponse) => {
        this.chargement.set(false);
        this.motDePasse = '';
        this.afficherErreur(
          err.status === 0
            ? "Serveur injoignable. Vérifiez que l'API est lancée."
            : err.error?.message || 'Connexion impossible, réessayez.'
        );
      },
    });
  }

  private afficherErreur(message: string): void {
    this.erreur.set(message);
    this.secouer.set(true);
    setTimeout(() => this.secouer.set(false), 500);
  }
}
