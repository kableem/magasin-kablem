import { Injectable } from '@angular/core';

// Caméra partagée par tous les scanners de l'application.
// Elle reste ouverte d'une étape à l'autre (ticket → emplacement → produit suivant…) : pas de nouvelle
// ouverture ni d'attente à chaque scan. Elle se coupe GARDE_MS après le dernier scanner affiché,
// et tout de suite quand le téléphone se met en veille ou change d'application.
// Pendant qu'elle est ouverte, l'écran reste allumé (pas de mise en veille entre deux scans).
const GARDE_MS = 20000;

interface VerrouEcran { release(): Promise<void> }

@Injectable({ providedIn: 'root' })
export class CameraService {
  private flux: MediaStream | null = null;
  private ouverture: Promise<MediaStream> | null = null;
  private utilisateurs = 0;
  private arret: ReturnType<typeof setTimeout> | undefined;
  private verrou: VerrouEcran | null = null;
  torche = false;

  // Dernier QR lu, quel que soit le scanner : il n'est pas relu par l'étape suivante
  dernier = { texte: '', date: 0 };
  absences = 0; // images analysées sans ce QR depuis sa lecture

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.couper();
    });
  }

  // Flux de la caméra arrière (ouvert si besoin) pour un scanner affiché
  async prendre(): Promise<MediaStream> {
    this.utilisateurs++;
    clearTimeout(this.arret);
    try {
      return await this.ouvrir();
    } catch (e) {
      this.utilisateurs = Math.max(0, this.utilisateurs - 1);
      throw e;
    }
  }

  // Flux en cours, rouvert s'il a été coupé (retour dans l'application) ; ne compte pas un nouveau scanner
  async ouvrir(): Promise<MediaStream> {
    if (this.flux?.getVideoTracks().some((p) => p.readyState === 'live')) return this.flux;
    this.ouverture ??= navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((f) => {
        this.flux = f;
        this.torche = false;
        void this.garderEcranAllume();
        return f;
      })
      .finally(() => (this.ouverture = null));
    return this.ouverture;
  }

  // Le scanner n'est plus affiché : la caméra reste prête quelques secondes pour l'étape suivante
  rendre(): void {
    this.utilisateurs = Math.max(0, this.utilisateurs - 1);
    if (this.utilisateurs) return;
    clearTimeout(this.arret);
    this.arret = setTimeout(() => this.couper(), GARDE_MS);
  }

  couper(): void {
    clearTimeout(this.arret);
    this.flux?.getTracks().forEach((p) => p.stop());
    this.flux = null;
    this.torche = false;
    void this.verrou?.release().catch(() => {});
    this.verrou = null;
  }

  async allumerTorche(allumer: boolean): Promise<boolean> {
    const piste = this.flux?.getVideoTracks()[0];
    if (!piste) return false;
    await piste.applyConstraints({ advanced: [{ torch: allumer } as MediaTrackConstraintSet] });
    this.torche = allumer;
    return true;
  }

  private async garderEcranAllume(): Promise<void> {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<VerrouEcran> } }).wakeLock;
      this.verrou ??= (await wl?.request('screen')) ?? null;
    } catch {
      // pas de maintien de l'écran sur cet appareil
    }
  }
}
