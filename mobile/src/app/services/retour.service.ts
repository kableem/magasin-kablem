import { Injectable } from '@angular/core';
import { Couleur } from './modeles';

// Retour à chaque scan : vibration + son (vert = 2 bips aigus, orange = 2 bips moyens, rouge = bip grave long)
@Injectable({ providedIn: 'root' })
export class RetourService {
  private audio: AudioContext | null = null;

  signaler(couleur: Couleur): void {
    const vibrations: Record<Couleur, number[]> = { vert: [80], orange: [120, 80, 120], rouge: [400, 120, 400] };
    try {
      navigator.vibrate?.(vibrations[couleur]);
    } catch {
      // vibration non disponible (ordinateur, iPhone)
    }
    const sons: Record<Couleur, [number, number][]> = {
      vert: [[1320, 0.09], [1760, 0.12]],
      orange: [[660, 0.15], [660, 0.15]],
      rouge: [[220, 0.55]],
    };
    this.jouer(sons[couleur]);
  }

  // Petit bip au moment où le QR est lu (avant la réponse du serveur)
  lu(): void {
    try {
      navigator.vibrate?.(30);
    } catch {}
    this.jouer([[990, 0.05]]);
  }

  private jouer(notes: [number, number][]): void {
    try {
      this.audio ??= new AudioContext();
      let t = this.audio.currentTime;
      for (const [frequence, duree] of notes) {
        const osc = this.audio.createOscillator();
        const volume = this.audio.createGain();
        osc.type = 'square';
        osc.frequency.value = frequence;
        volume.gain.setValueAtTime(0.18, t);
        volume.gain.exponentialRampToValueAtTime(0.001, t + duree);
        osc.connect(volume).connect(this.audio.destination);
        osc.start(t);
        osc.stop(t + duree);
        t += duree + 0.05;
      }
    } catch {
      // son non disponible
    }
  }
}
