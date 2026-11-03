import { Injectable, signal } from '@angular/core';

// Petite notification affichée en bas à droite (rendue dans app.html)
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly message = signal('');
  readonly erreur = signal(false);
  private minuteur?: ReturnType<typeof setTimeout>;

  afficher(message: string, erreur = false): void {
    clearTimeout(this.minuteur);
    this.message.set(message);
    this.erreur.set(erreur);
    this.minuteur = setTimeout(() => this.message.set(''), 3000);
  }
}
