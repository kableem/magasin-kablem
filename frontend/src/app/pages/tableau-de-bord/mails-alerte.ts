import { Component, OnInit, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

interface ReglagesMails {
  destinataires: string[];
  minutes: number;
  compte: string | null; // compte qui envoie (backend/.env), null s'il n'est pas réglé
}

// Mails d'alerte au service logistique (administrateur) : une sortie urgente pas terminée après 2 h
// envoie un seul mail aux adresses réglées ici. Le compte qui envoie est dans backend/.env.
@Component({
  selector: 'app-mails-alerte',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="fond" (click)="fermer.emit()">
      <form class="modale" (click)="$event.stopPropagation()" (ngSubmit)="enregistrer()" novalidate>
        <div class="modale-entete">
          <h2>Mails d'alerte</h2>
          <button type="button" class="icone-btn" (click)="fermer.emit()" aria-label="Fermer">
            <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
          </button>
        </div>
        <p class="intro">
          Une sortie urgente posée près de la porte et pas encore sortie après <b>{{ duree(minutes) }}</b> devient critique :
          un seul mail part automatiquement au service logistique.
        </p>

        @if (chargement()) {
          <p class="intro">Chargement…</p>
        } @else {
          <div class="compte" [class.manque]="!compte()">
            @if (compte()) {
              Envoyé depuis <b>{{ compte() }}</b>
            } @else {
              Compte d'envoi pas encore réglé : ajoutez SMTP_HOST, SMTP_USER et SMTP_PASSWORD dans <code>backend/.env</code>, puis redémarrez le serveur.
            }
          </div>

          <label class="champ">
            <span>Adresses du service logistique</span>
            <textarea name="destinataires" rows="3" placeholder="logistique@kablem.tn, responsable.logistique@kablem.tn" [(ngModel)]="destinataires"></textarea>
            <small>Séparez les adresses par une virgule ou un retour à la ligne.</small>
          </label>

          <label class="champ court">
            <span>Mail après (minutes)</span>
            <input name="minutes" type="number" min="1" max="1440" [(ngModel)]="minutes" />
          </label>

          @if (erreur()) {
            <p class="erreur">{{ erreur() }}</p>
          }
          @if (info()) {
            <p class="info">{{ info() }}</p>
          }
        }

        <div class="modale-pied">
          <button type="button" class="btn btn-secondaire" [disabled]="occupe() || chargement()" (click)="essai()">Envoyer un mail d'essai</button>
          <button type="submit" class="btn btn-principal" [disabled]="occupe() || chargement()">{{ occupe() ? 'Patientez…' : 'Enregistrer' }}</button>
        </div>
      </form>
    </div>
  `,
  styles: `
    .modale { max-width: 560px; }
    .intro { margin: 10px 0 14px; font-size: 14px; }
    .compte { margin-bottom: 14px; padding: 10px 14px; font-size: 13.5px; color: #1d6b3a; background: #e3f4e8; border-radius: 10px; }
    .compte.manque { color: #8a5a00; background: #fdf1d8; }
    .compte code { font-size: 12.5px; }
    .champ { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; font-size: 13.5px; font-weight: 600; color: var(--gris); }
    .champ small { font-weight: 500; }
    .champ textarea { padding: 10px 12px; font: inherit; font-weight: 500; color: var(--nuit); resize: vertical; }
    .champ.court input { max-width: 140px; height: 40px; }
    .info { margin: 0; padding: 10px 14px; font-size: 13.5px; color: #1d6b3a; background: #e3f4e8; border-radius: 10px; }
  `,
})
export class MailsAlerte implements OnInit {
  private http = inject(HttpClient);
  private api = '/api/parametres/mails';
  readonly fermer = output<void>();

  destinataires = '';
  minutes = 120;
  readonly compte = signal<string | null>(null);
  readonly chargement = signal(true);
  readonly occupe = signal(false);
  readonly erreur = signal('');
  readonly info = signal('');

  async ngOnInit(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<ReglagesMails>(this.api));
      this.destinataires = r.destinataires.join(', ');
      this.minutes = r.minutes;
      this.compte.set(r.compte);
    } catch (e) {
      this.erreur.set(this.message(e, 'Réglages indisponibles'));
    } finally {
      this.chargement.set(false);
    }
  }

  duree(min: number): string {
    const m = Number(min) || 0;
    return m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m / 60} h`;
  }

  private async sauver(): Promise<void> {
    const r = await firstValueFrom(this.http.put<{ destinataires: string[]; minutes: number }>(this.api, { destinataires: this.destinataires, minutes: Number(this.minutes) }));
    this.destinataires = r.destinataires.join(', ');
    this.minutes = r.minutes;
  }

  async enregistrer(): Promise<void> {
    await this.agir(async () => {
      await this.sauver();
      this.info.set('Réglages enregistrés.');
    });
  }

  // Enregistre d'abord, puis envoie le mail d'essai aux adresses
  async essai(): Promise<void> {
    await this.agir(async () => {
      await this.sauver();
      const r = await firstValueFrom(this.http.post<{ message: string }>(`${this.api}/essai`, {}));
      this.info.set(r.message);
    });
  }

  private async agir(f: () => Promise<void>): Promise<void> {
    this.erreur.set('');
    this.info.set('');
    this.occupe.set(true);
    try {
      await f();
    } catch (e) {
      this.erreur.set(this.message(e, 'Action impossible'));
    } finally {
      this.occupe.set(false);
    }
  }

  private message(e: unknown, defaut: string): string {
    const err = e as HttpErrorResponse;
    return err?.status === 0 ? 'Serveur injoignable' : (err?.error?.message ?? defaut);
  }
}
