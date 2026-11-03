import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonContent, IonIcon, ViewWillEnter } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowDown, arrowUp, chevronForward, logOutOutline, cloudOfflineOutline, sparklesOutline, clipboardOutline } from 'ionicons/icons';
import { AuthService } from '../../services/auth.service';
import { ControlesService } from '../../services/controles.service';
import { ControleResume, LIBELLES_ROLES } from '../../services/modeles';

// Accueil après la connexion : Import (réception et rangement) ou Export (sortie vers la production)
@Component({
  selector: 'app-menu',
  standalone: true,
  imports: [RouterLink, IonContent, IonIcon],
  template: `
    <ion-content [fullscreen]="true">
      <section class="hero">
        <div class="motif"></div>
        <div class="barre">
          <span class="logo"><img src="assets/logo-kablem.png" alt="Kab-lem" /></span>
          <button type="button" class="sortir" (click)="auth.deconnexion()" aria-label="Déconnexion">
            <ion-icon name="log-out-outline"></ion-icon>
          </button>
        </div>
        @if (auth.session(); as s) {
          <p class="salut">{{ salutation }}</p>
          <h1><span class="mono">{{ s.utilisateur.matricule }}</span></h1>
          <span class="role">{{ roles[s.utilisateur.role] }}</span>
        }

        <div class="jour">
          <div><b>{{ duJour().length }}</b><small>contrôles aujourd'hui</small></div>
          <div [class.alerte]="nbAlertes() > 0"><b>{{ nbAlertes() }}</b><small>alertes</small></div>
          <a routerLink="/attente" [class.attente]="controles.nbAttente() > 0"><b>{{ controles.nbAttente() }}</b><small>en attente</small></a>
        </div>
      </section>

      <nav class="choix">
        <a class="carte import k-apparait" routerLink="/import">
          <span class="bulle"><ion-icon name="arrow-down"></ion-icon></span>
          <span class="texte">
            <strong>Import</strong>
            <small>Les produits arrivés d'Italie</small>
            <span class="etapes"><i>Réception</i><i>Rangement</i><i>Consulter</i></span>
          </span>
          <ion-icon class="fleche" name="chevron-forward"></ion-icon>
        </a>
        <a class="carte export k-apparait" routerLink="/export" style="animation-delay: 60ms">
          <span class="bulle"><ion-icon name="arrow-up"></ion-icon></span>
          <span class="texte">
            <strong>Export</strong>
            <small>Sortie vers la production</small>
            <span class="etapes"><i>FIFO imposé</i><i>Bon produit</i><i>Bon emplacement</i></span>
          </span>
          <ion-icon class="fleche" name="chevron-forward"></ion-icon>
        </a>
        <a class="carte ranger k-apparait" routerLink="/ranger" style="animation-delay: 120ms">
          <span class="bulle"><ion-icon name="sparkles-outline"></ion-icon></span>
          <span class="texte">
            <strong>Ranger le magasin</strong>
            <small>Déplacer librement pour libérer des places</small>
            <span class="etapes"><i>Ticket</i><i>Départ</i><i>Arrivée</i><i>Contrôlé</i></span>
          </span>
          <ion-icon class="fleche" name="chevron-forward"></ion-icon>
        </a>
        @if (gestionnaire()) {
          <a class="carte inventaire k-apparait" routerLink="/inventaire" style="animation-delay: 180ms">
            <span class="bulle"><ion-icon name="clipboard-outline"></ion-icon></span>
            <span class="texte">
              <strong>Inventaire</strong>
              <small>Compter le stock réel, emplacement par emplacement</small>
            </span>
            <ion-icon class="fleche" name="chevron-forward"></ion-icon>
          </a>
        }
      </nav>

      @if (!enLigne()) {
        <p class="hors-ligne"><ion-icon name="cloud-offline-outline"></ion-icon> Pas de réseau : les scans d'import sont gardés sur le téléphone.</p>
      }
      <p class="signature">Kab-lem Tunisia · Menzel Jemil</p>
    </ion-content>
  `,
  styles: `
    .hero { position: relative; overflow: hidden; padding: calc(14px + var(--ion-safe-area-top, 0px)) 20px 80px; color: #fff; background: var(--k-degrade-nuit); border-bottom: 5px solid var(--k-rouge); border-radius: 0 0 34px 34px; }
    .motif { position: absolute; inset: 0; opacity: 0.07; background-image: repeating-linear-gradient(135deg, #fff 0 2px, transparent 2px 22px); }
    .barre { position: relative; display: flex; align-items: center; justify-content: space-between; }
    .logo { display: inline-flex; padding: 8px 12px; background: #fff; border-radius: 14px; }
    .logo img { height: 30px; display: block; }
    .sortir { display: grid; place-items: center; width: 48px; height: 48px; color: #fff; font-size: 24px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 50%; }
    .salut { position: relative; margin: 22px 0 0; font-size: 16px; color: #c7d0ec; }
    h1 { position: relative; margin: 0; font-size: 40px; font-weight: 900; line-height: 1.05; }
    .role { position: relative; display: inline-block; margin-top: 6px; padding: 2px 12px; font-size: 13px; font-weight: 700; background: rgba(255, 255, 255, 0.14); border-radius: 999px; }
    .jour { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 20px; }
    .jour > * { display: flex; flex-direction: column; padding: 10px 12px; color: #fff; text-decoration: none; background: rgba(255, 255, 255, 0.09); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 16px; }
    .jour b { font-size: 26px; font-weight: 900; line-height: 1.1; }
    .jour small { font-size: 12.5px; color: #c7d0ec; line-height: 1.2; }
    .jour .alerte { background: rgba(224, 34, 34, 0.3); border-color: rgba(255, 120, 110, 0.5); }
    .jour .attente { background: rgba(255, 210, 31, 0.22); border-color: rgba(255, 210, 31, 0.5); }

    .choix { position: relative; display: grid; gap: 14px; margin: -56px 16px 0; }
    .carte { display: flex; align-items: center; gap: 16px; min-height: 128px; padding: 18px 16px 18px 18px; text-decoration: none; border-radius: 26px; box-shadow: var(--k-ombre-forte); transition: transform 0.12s; }
    .carte:active { transform: scale(0.98); }
    .import { color: var(--k-nuit); background: var(--k-surface); border: 1px solid var(--k-bord); }
    .export { color: #fff; background: var(--k-degrade-rouge); }
    .bulle { display: grid; place-items: center; width: 68px; height: 68px; flex: none; font-size: 34px; border-radius: 22px; }
    .import .bulle { color: #fff; background: var(--k-degrade-nuit); }
    .export .bulle { color: var(--k-rouge); background: #fff; }
    .texte { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .texte strong { font-size: 28px; font-weight: 900; line-height: 1.1; }
    .texte small { font-size: 15px; opacity: 0.8; }
    .etapes { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .etapes i { padding: 2px 9px; font-style: normal; font-size: 12px; font-weight: 700; border-radius: 999px; }
    .import .etapes i { color: var(--k-marine); background: var(--k-surface-2); }
    .export .etapes i { background: rgba(255, 255, 255, 0.18); }
    .ranger { min-height: 104px; color: var(--k-nuit); background: var(--k-vert-clair); border: 1px solid #bfe6cf; }
    .ranger .bulle { color: #fff; background: var(--k-vert); }
    .ranger .texte strong { font-size: 23px; }
    .ranger .etapes i { color: var(--k-vert); background: var(--k-surface); }
    .inventaire { min-height: 92px; color: var(--k-nuit); background: var(--k-surface); border: 1px dashed var(--k-bord); }
    .inventaire .bulle { width: 56px; height: 56px; font-size: 28px; color: var(--k-marine); background: var(--k-surface-2); }
    .inventaire .texte strong { font-size: 22px; }
    .fleche { flex: none; font-size: 26px; opacity: 0.55; }
    .hors-ligne { display: flex; align-items: center; gap: 8px; margin: 16px 18px 0; padding: 12px 14px; font-weight: 600; color: #7a4a00; background: var(--k-orange-clair); border-radius: 14px; }
    .signature { margin: 26px 0 calc(18px + var(--ion-safe-area-bottom, 0px)); text-align: center; font-size: 13px; color: var(--k-gris); }
  `,
})
export class MenuPage implements ViewWillEnter {
  readonly auth = inject(AuthService);
  readonly controles = inject(ControlesService);
  readonly roles = LIBELLES_ROLES;
  // Inventaire : chef de magasin et administrateur
  readonly gestionnaire = computed(() => ['admin', 'chef_magasin'].includes(this.auth.session()?.utilisateur.role ?? ''));
  readonly mesControles = signal<ControleResume[]>([]);
  readonly enLigne = signal(navigator.onLine);
  readonly salutation = new Date().getHours() < 18 ? 'Bonjour' : 'Bonsoir';

  readonly duJour = computed(() => {
    const d = new Date();
    const jour = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return this.mesControles().filter((c) => c.date.slice(0, 10) === jour);
  });
  readonly nbAlertes = computed(() => this.duJour().filter((c) => c.couleur !== 'vert').length);

  constructor() {
    addIcons({ sparklesOutline, clipboardOutline, arrowDown, arrowUp, chevronForward, logOutOutline, cloudOfflineOutline });
    window.addEventListener('online', () => this.enLigne.set(true));
    window.addEventListener('offline', () => this.enLigne.set(false));
  }

  // Chiffres du jour rafraîchis à chaque retour sur l'accueil
  async ionViewWillEnter(): Promise<void> {
    try {
      this.mesControles.set(await this.controles.mesControles());
    } catch {
      // hors ligne : on garde les derniers chiffres
    }
  }
}
