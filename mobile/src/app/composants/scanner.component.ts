import { EmplPipe } from './empl.pipe';
import { Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonButton, IonIcon, IonInput, IonSpinner } from '@ionic/angular/standalone';
import { BrowserQRCodeReader } from '@zxing/browser';
import { DecodeHintType } from '@zxing/library';
import { addIcons } from 'ionicons';
import { CameraService } from '../services/camera.service';
import { ResultatControle, estCodeEmplacement, estQrArticle, ressembleTicket } from '../services/modeles';
import { ResultatComponent } from './resultat.component';
import {
  cameraOutline, keypadOutline, flashlight, flashlightOutline, closeOutline, scanOutline, arrowDown, checkmark, alert, close,
  chevronDown, chevronUp, arrowForward,
} from 'ionicons/icons';

export interface Lecture {
  texte: string;
  manuel: boolean; // true = saisie manuelle de secours (marquée dans le journal)
}

// Règle générale du scan, pour tous les écrans : le scan passe avant tout.
//  - Le viseur reste en haut de l'écran (il ne descend jamais quand une liste s'allonge).
//  - La caméra reste ouverte d'une étape à l'autre (CameraService) : pendant la vérification
//    par le serveur, la lecture est seulement suspendue.
//  - Après chaque QR lu, courte pause (PAUSE_MS) pour passer au QR suivant ; le QR doit rester
//    stable quelques lectures. Le QR qui vient d'être lu n'est pas relu tant qu'il reste devant
//    la caméra : pour le relire (après une erreur), on l'écarte puis on le représente.
//  - Seul le QR dont le centre est dans le cadre est accepté (un voisin sur la planche est ignoré).
//  - Le résultat s'affiche dans une bande sous le viseur (touchez-la pour le détail), avec un éclair
//    de couleur, un son et une vibration : on peut scanner le produit suivant tout de suite.
const PAUSE_MS = 700;
const OUVERTURE_MS = 500;
const LECTURES_STABLES = 2;
const ABSENCES_RELECTURE = 6; // images sans ce QR (≈ 0,7 s) avant de pouvoir le relire
const RELECTURE_MIN_MS = 2000;
const CADRE = 0.64; // côté du cadre carré, en fraction de la hauteur du viseur
const INTERVALLE_MS = 120;
const COTE_MAX = 900; // image réduite à 900 px pour un décodage rapide
const RESULTAT_FRAIS_MS = 2500;

// Zone du cadre dans l'image de la caméra (pixels de la vidéo)
interface Zone { x: number; y: number; l: number; h: number }
interface Trouve { texte: string; cx: number; cy: number }
const dansZone = (z: Zone, x: number, y: number) => x >= z.x && x <= z.x + z.l && y >= z.y && y <= z.y + z.h;

// Lecteur QR natif du téléphone (Android / Chrome) : rapide et donne la position de chaque QR
interface DetecteurNatif { detect(source: HTMLVideoElement): Promise<{ rawValue: string; boundingBox: DOMRectReadOnly }[]> }
let natifPartage: Promise<DetecteurNatif | null> | null = null;
function detecteurNatif(): Promise<DetecteurNatif | null> {
  natifPartage ??= (async () => {
    try {
      const BD = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): DetecteurNatif; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
      if (!BD || !(await BD.getSupportedFormats()).includes('qr_code')) return null;
      return new BD({ formats: ['qr_code'] });
    } catch {
      return null;
    }
  })();
  return natifPartage;
}

// Scan d'un QR avec la caméra arrière du téléphone, ou saisie manuelle de secours.
// actif = false : lecture suspendue (vérification en cours), la caméra reste ouverte.
// cible : emplacement où aller, affiché en grand sur le viseur ; compteur : avancement (ex. « 3/6 »).
// resultat : dernier résultat, affiché sous le viseur ; fixe = viseur collé en haut de l'écran.
@Component({
  selector: 'app-scanner',
  standalone: true,
  imports: [EmplPipe, FormsModule, IonButton, IonIcon, IonInput, IonSpinner, ResultatComponent],
  host: { '[class.fixe]': 'fixe()' },
  template: `
    @if (!manuel()) {
      <div class="viseur" [attr.data-couleur]="frais() ? resultat()?.couleur : null" [class.suspendu]="!actif()">
        <video #video playsinline muted></video>

        @if (!erreur() && !demarrage()) {
          <div class="cadre" [class.pause]="attente()">
            <i class="coin hg"></i><i class="coin hd"></i><i class="coin bg"></i><i class="coin bd"></i>
            @if (actif() && !attente()) {
              <span class="laser"></span>
            }
          </div>
        }
        @if (demarrage()) {
          <div class="info"><ion-spinner name="crescent"></ion-spinner><span>Ouverture de la caméra…</span></div>
        }
        @if (erreur(); as e) {
          <div class="info erreur">
            <span class="bulle"><ion-icon name="camera-outline"></ion-icon></span>
            <span>{{ e }}</span>
          </div>
        }

        <div class="haut">
          <span class="consigne"><ion-icon name="scan-outline"></ion-icon><span>{{ consigne() }}</span></span>
          @if (compteur()) {
            <span class="compteur">{{ compteur() }}</span>
          }
        </div>

        @if (!actif()) {
          <div class="verif"><ion-spinner name="dots"></ion-spinner></div>
        }
        @if (indice(); as i) {
          <div class="indice"><ion-icon name="arrow-down"></ion-icon>{{ i }}</div>
        }

        <div class="bas">
          @if (cible()) {
            <span class="cible"><small>{{ cibleTexte() }}</small><span class="k-etiquette">{{ cible() | empl }}</span></span>
          }
          <span class="outils">
            <button type="button" class="rond" (click)="ouvrirManuel()" aria-label="QR illisible : saisie manuelle"><ion-icon name="keypad-outline"></ion-icon></button>
            @if (torche() !== null) {
              <button type="button" class="rond" [class.allumee]="torche()" (click)="basculerTorche()" aria-label="Lampe">
                <ion-icon [name]="torche() ? 'flashlight' : 'flashlight-outline'"></ion-icon>
              </button>
            }
          </span>
        </div>
      </div>
    } @else {
      <form class="manuel k-apparait" (ngSubmit)="valider()">
        <div class="manuel-tete">
          <span><ion-icon name="keypad-outline"></ion-icon> Saisie manuelle</span>
          <button type="button" (click)="manuel.set(false)" aria-label="Revenir à la caméra"><ion-icon name="close-outline"></ion-icon></button>
        </div>
        <label class="k-libelle">{{ libelleManuel() }}</label>
        <div class="k-champ">
          <ion-input [placeholder]="exempleManuel()" [(ngModel)]="saisie" name="saisie" autocapitalize="characters" class="mono"></ion-input>
        </div>
        <p class="note">Cette saisie est marquée « saisie manuelle » dans le journal.</p>
        <ion-button type="submit" expand="block" class="k-btn-principal" [disabled]="!saisie.trim()">Valider</ion-button>
      </form>
    }

    @if (resultat(); as r) {
      @if (eclair()) {
        <div class="eclair" [attr.data-couleur]="r.couleur"></div>
      }
      <button type="button" class="bande k-apparait" [attr.data-couleur]="r.couleur" (click)="detail.set(!detail())" [attr.aria-expanded]="detail()">
        <span class="icone"><ion-icon [name]="icone()"></ion-icon></span>
        <span class="texte">
          <b>{{ r.titre }}</b>
          <small [class.entier]="detail()">{{ r.message }}</small>
        </span>
        @if (codeResultat()) {
          <span class="k-etiquette">{{ codeResultat() }}</span>
        }
        <ion-icon class="ouvrir" [name]="detail() ? 'chevron-up' : 'chevron-down'"></ion-icon>
      </button>
      @if (detail()) {
        <app-resultat class="detail" [r]="r" [compact]="true"></app-resultat>
      }
    }
  `,
  styles: `
    :host { display: block; }
    :host(.fixe) { position: sticky; top: 0; z-index: 20; padding-bottom: 10px; background: var(--k-fond); box-shadow: 0 -16px 0 var(--k-fond); }
    .viseur { position: relative; overflow: hidden; width: 100%; aspect-ratio: 4 / 3; max-height: 42vh; margin: 0 auto; background: radial-gradient(circle at 50% 40%, #13296b, #050d22 75%); border-radius: 24px; box-shadow: var(--k-ombre-forte), inset 0 0 0 0 transparent; transition: box-shadow 0.2s; }
    .viseur[data-couleur='vert'] { box-shadow: 0 0 0 5px var(--k-vert), var(--k-ombre-forte); }
    .viseur[data-couleur='orange'] { box-shadow: 0 0 0 5px var(--k-orange), var(--k-ombre-forte); }
    .viseur[data-couleur='rouge'] { box-shadow: 0 0 0 5px var(--k-erreur), var(--k-ombre-forte); }
    video { width: 100%; height: 100%; object-fit: cover; }
    .suspendu video { filter: brightness(0.55); }
    .cadre { position: absolute; top: 50%; left: 50%; height: 64%; aspect-ratio: 1; transform: translate(-50%, -50%); border-radius: 16px; box-shadow: 0 0 0 999px rgba(5, 13, 34, 0.42); transition: opacity 0.2s; }
    .cadre.pause { opacity: 0.55; }
    .coin { position: absolute; width: 30px; height: 30px; border: 5px solid #fff; filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4)); }
    .hg { top: -2px; left: -2px; border-right: 0; border-bottom: 0; border-radius: 16px 0 0 0; }
    .hd { top: -2px; right: -2px; border-left: 0; border-bottom: 0; border-radius: 0 16px 0 0; }
    .bg { bottom: -2px; left: -2px; border-right: 0; border-top: 0; border-radius: 0 0 0 16px; }
    .bd { bottom: -2px; right: -2px; border-left: 0; border-top: 0; border-radius: 0 0 16px 0; }
    .laser { position: absolute; left: 8%; right: 8%; height: 3px; border-radius: 3px; background: var(--k-rouge); box-shadow: 0 0 14px 3px rgba(224, 34, 34, 0.75); animation: balaye 1.8s ease-in-out infinite; }
    @keyframes balaye { 0%, 100% { top: 10%; } 50% { top: 88%; } }
    .info { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; color: #fff; text-align: center; font-size: 15px; line-height: 1.4; }
    .bulle { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 50%; background: rgba(255, 255, 255, 0.12); }
    .bulle ion-icon { font-size: 28px; color: var(--k-jaune); }
    .haut { position: absolute; top: 10px; left: 10px; right: 10px; display: flex; align-items: flex-start; gap: 8px; }
    .consigne { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; padding: 7px 13px; font-size: 14.5px; font-weight: 700; color: #fff; background: rgba(6, 22, 58, 0.72); backdrop-filter: blur(8px); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 999px; }
    .consigne span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .consigne ion-icon { flex: none; font-size: 17px; color: #ff6b62; }
    .compteur { flex: none; padding: 3px 12px; font-size: 22px; font-weight: 900; line-height: 1.25; color: var(--k-nuit); background: #fff; border-radius: 999px; box-shadow: 0 6px 14px -6px rgba(0, 0, 0, 0.5); }
    .verif { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: grid; place-items: center; width: 64px; height: 64px; color: #fff; background: rgba(6, 22, 58, 0.7); border-radius: 50%; }
    .verif ion-spinner { width: 34px; height: 34px; color: #fff; }
    .indice { position: absolute; left: 10px; right: 10px; bottom: 66px; display: flex; align-items: center; gap: 8px; padding: 9px 13px; font-size: 14px; font-weight: 700; line-height: 1.3; color: #111; background: var(--k-jaune); border-radius: 14px; box-shadow: 0 8px 18px -8px rgba(0, 0, 0, 0.6); animation: k-apparait 0.2s ease-out both; }
    .indice ion-icon { flex: none; font-size: 19px; }
    .bas { position: absolute; left: 10px; right: 10px; bottom: 10px; display: flex; align-items: flex-end; gap: 8px; }
    .cible { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px 6px 6px; background: rgba(6, 22, 58, 0.72); backdrop-filter: blur(8px); border-radius: 14px; }
    .cible small { padding-left: 4px; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #cfd6ee; }
    .cible .k-etiquette { font-size: 30px; line-height: 1.05; padding: 2px 14px; border-left-width: 7px; }
    .outils { margin-left: auto; display: flex; gap: 8px; }
    .rond { display: grid; place-items: center; width: 48px; height: 48px; color: #fff; font-size: 22px; background: rgba(6, 22, 58, 0.72); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 50%; }
    .rond.allumee { color: #111; background: var(--k-jaune); }

    .bande { --c: var(--k-vert); --fond-c: var(--k-vert-clair); display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 10px; padding: 9px 12px 9px 9px; font: inherit; text-align: left; color: var(--k-texte); background: var(--fond-c); border: 0; border-left: 6px solid var(--c); border-radius: 16px; box-shadow: var(--k-ombre); }
    .bande[data-couleur='orange'] { --c: var(--k-orange); --fond-c: var(--k-orange-clair); }
    .bande[data-couleur='rouge'] { --c: var(--k-erreur); --fond-c: var(--k-erreur-clair); }
    .bande .icone { display: grid; place-items: center; flex: none; width: 38px; height: 38px; color: #fff; font-size: 22px; background: var(--c); border-radius: 50%; }
    .bande .texte { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .bande b { font-size: 16px; font-weight: 800; line-height: 1.2; color: var(--k-nuit); }
    .bande small { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13.5px; line-height: 1.3; color: var(--k-texte); }
    .bande small.entier { display: block; }
    .bande .k-etiquette { flex: none; font-size: 20px; padding: 2px 10px; }
    .bande .ouvrir { flex: none; font-size: 18px; color: var(--k-gris); }
    .detail { display: block; margin-top: 8px; }
    .eclair { position: fixed; inset: 0; z-index: 9999; pointer-events: none; animation: eclair 0.6s ease-out forwards; }
    .eclair[data-couleur='vert'] { background: var(--k-vert); }
    .eclair[data-couleur='orange'] { background: var(--k-orange); }
    .eclair[data-couleur='rouge'] { background: var(--k-erreur); }
    @keyframes eclair { 0% { opacity: 0.5; } 100% { opacity: 0; } }

    .manuel { padding: 16px; background: var(--k-surface); border: 2px dashed var(--k-bord); border-radius: 24px; }
    .manuel-tete { display: flex; align-items: center; justify-content: space-between; font-weight: 700; color: var(--k-marine); }
    .manuel-tete span { display: flex; align-items: center; gap: 8px; }
    .manuel-tete button { display: grid; place-items: center; width: 44px; height: 44px; font-size: 24px; color: var(--k-gris); background: var(--k-surface-2); border: 0; border-radius: 50%; }
    .manuel .k-libelle { margin-top: 12px; }
    .note { margin: 8px 2px 14px; font-size: 13px; color: var(--k-gris); }
  `,
})
export class ScannerComponent implements OnDestroy {
  private camera = inject(CameraService);
  private hote = inject(ElementRef<HTMLElement>);

  readonly actif = input(true);
  readonly consigne = input('Visez le QR code');
  readonly libelleManuel = input('Contenu du QR');
  readonly exempleManuel = input('ex. F0391;13000;10;202613167;1');
  // Ce que l'on attend : un ticket produit, une étiquette d'emplacement, ou n'importe quel QR
  readonly attendu = input<'ticket' | 'emplacement' | 'tout'>('tout');
  readonly cible = input<string | null>(null);
  readonly cibleTexte = input('Allez en');
  readonly compteur = input<string | null>(null);
  readonly resultat = input<ResultatControle | null>(null);
  readonly fixe = input(true);
  readonly lecture = output<Lecture>();

  private video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private lecteur = new BrowserQRCodeReader(new Map([[DecodeHintType.TRY_HARDER, true]]));
  private natif: DetecteurNatif | null = null;
  private tour = 0;
  private analyseEnCours = false;
  private flux: MediaStream | null = null;
  private branche = false; // ce scanner utilise la caméra partagée
  private detruit = false;
  private boucle: ReturnType<typeof setTimeout> | undefined;
  private toile = document.createElement('canvas');
  private finAttente = 0;
  private candidat = { texte: '', n: 0, date: 0 };
  private dejaSignale = 0;
  private minuterieIndice: ReturnType<typeof setTimeout> | undefined;
  private minuterieAttente: ReturnType<typeof setTimeout> | undefined;
  private minuterieFrais: ReturnType<typeof setTimeout> | undefined;
  private readonly visibilite = () => {
    if (!document.hidden && this.branche) void this.brancherVideo();
  };

  readonly demarrage = signal(false);
  readonly erreur = signal<string | null>(null);
  readonly manuel = signal(false);
  readonly torche = signal<boolean | null>(null); // null = pas de lampe sur cet appareil
  readonly indice = signal<string | null>(null); // mauvais QR visé : on continue de scanner
  readonly attente = signal(false); // courte pause après un QR lu
  readonly frais = signal(false); // résultat qui vient d'arriver : viseur entouré de sa couleur
  readonly eclair = signal(false);
  readonly detail = signal(false);
  saisie = '';

  readonly icone = computed(() => ({ vert: 'checkmark', orange: 'alert', rouge: 'close' })[this.resultat()?.couleur ?? 'vert']);
  // Emplacement à montrer dans la bande du résultat : rangé en, ou prévu (un seul)
  readonly codeResultat = computed(() => {
    const r = this.resultat();
    if (!r) return null;
    if (r.resultat === 'bon_emplacement' || r.resultat === 'deplace') return r.emplacement_scanne;
    // Ranger le magasin refusé : le produit n'a pas bougé (aucun emplacement à montrer)
    if (r.controle === 'ranger') return null;
    const prevus = r.emplacements_prevus.filter((e) => e.code);
    return prevus.length === 1 ? prevus[0].code : null;
  });

  constructor() {
    addIcons({ cameraOutline, keypadOutline, flashlight, flashlightOutline, closeOutline, scanOutline, arrowDown, checkmark, alert, close, chevronDown, chevronUp, arrowForward });
    effect(() => {
      const manuel = this.manuel();
      untracked(() => (manuel ? this.debrancher() : void this.brancher()));
    });
    // Nouveau résultat : éclair plein écran et viseur entouré de sa couleur un instant
    effect(() => {
      const r = this.resultat();
      untracked(() => {
        this.detail.set(false);
        clearTimeout(this.minuterieFrais);
        if (!r) {
          this.frais.set(false);
          return;
        }
        this.frais.set(true);
        this.eclair.set(true);
        setTimeout(() => this.eclair.set(false), 600);
        this.minuterieFrais = setTimeout(() => this.frais.set(false), RESULTAT_FRAIS_MS);
      });
    });
    document.addEventListener('visibilitychange', this.visibilite);
  }

  ngOnDestroy(): void {
    this.detruit = true;
    document.removeEventListener('visibilitychange', this.visibilite);
    clearTimeout(this.minuterieIndice);
    clearTimeout(this.minuterieAttente);
    clearTimeout(this.minuterieFrais);
    this.debrancher();
  }

  ouvrirManuel(): void {
    this.manuel.set(true);
  }

  valider(): void {
    const texte = this.saisie.trim();
    if (!texte) return;
    this.saisie = '';
    this.manuel.set(false);
    this.lecture.emit({ texte, manuel: true });
  }

  async basculerTorche(): Promise<void> {
    try {
      const allumer = !this.torche();
      if (await this.camera.allumerTorche(allumer)) this.torche.set(allumer);
    } catch {
      this.torche.set(null);
    }
  }

  // Le scanner s'affiche : il prend la caméra partagée (déjà ouverte si l'étape d'avant scannait)
  private async brancher(): Promise<void> {
    if (this.branche) return;
    this.branche = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.erreur.set("Caméra indisponible : l'application doit être ouverte en HTTPS. Utilisez la saisie manuelle.");
      this.branche = false;
      return;
    }
    const chaude = this.camera.dernier.date > 0;
    this.demarrage.set(true);
    try {
      this.flux = await this.camera.prendre();
      if (this.detruit || this.manuel()) return;
      await this.brancherVideo();
      this.natif ??= await detecteurNatif();
      // pas de lecture tout de suite : le QR de l'étape d'avant est peut-être encore devant la caméra
      this.pause(chaude ? Math.max(0, this.camera.dernier.date + PAUSE_MS - Date.now()) : OUVERTURE_MS);
      clearTimeout(this.boucle);
      this.analyser();
    } catch (e) {
      this.branche = false;
      this.flux = null;
      const nom = (e as Error)?.name;
      this.erreur.set(
        nom === 'NotAllowedError'
          ? 'Accès à la caméra refusé : autorisez-le dans le navigateur, ou utilisez la saisie manuelle.'
          : "Impossible d'ouvrir la caméra. Utilisez la saisie manuelle."
      );
    } finally {
      this.demarrage.set(false);
      if (this.detruit && this.branche) this.debrancher();
    }
  }

  // Branche le flux sur la vidéo (rouvert par le service si le téléphone s'était mis en veille)
  private async brancherVideo(): Promise<void> {
    if (document.hidden) return;
    this.flux = await this.camera.ouvrir();
    await new Promise((r) => setTimeout(r)); // la vidéo apparaît après le rendu (retour de la saisie manuelle)
    const video = this.video()?.nativeElement;
    if (!video || this.detruit) return;
    if (video.srcObject !== this.flux) video.srcObject = this.flux;
    await video.play().catch(() => {});
    const capacites = (this.flux.getVideoTracks()[0]?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
    this.torche.set(capacites.torch ? this.camera.torche : null);
    this.erreur.set(null);
  }

  private debrancher(): void {
    clearTimeout(this.boucle);
    const video = this.video()?.nativeElement;
    if (video) video.srcObject = null;
    if (this.branche) this.camera.rendre();
    this.branche = false;
    this.flux = null;
    this.torche.set(null);
  }

  private pause(ms: number): void {
    this.finAttente = Date.now() + ms;
    this.candidat = { texte: '', n: 0, date: 0 };
    clearTimeout(this.minuterieAttente);
    this.attente.set(ms > 0);
    if (ms > 0) this.minuterieAttente = setTimeout(() => this.attente.set(false), ms);
  }

  // Une image toutes les INTERVALLE_MS, seulement quand ce scanner est à l'écran et attend un QR
  private analyser = (): void => {
    if (!this.branche) return;
    this.boucle = setTimeout(this.analyser, INTERVALLE_MS);
    const video = this.video()?.nativeElement;
    if (this.analyseEnCours || !video || video.readyState < 2 || !this.actif() || Date.now() < this.finAttente) return;
    if (document.hidden || this.hote.nativeElement.closest('.ion-page-hidden')) return;
    this.analyseEnCours = true;
    this.lireCadre(video)
      .then((texte) => this.branche && this.actif() && Date.now() >= this.finAttente && this.vu(texte))
      .finally(() => (this.analyseEnCours = false));
  };

  // Zone affichée dans le cadre (carré centré), en pixels de la vidéo (vidéo en « object-fit: cover »)
  private zoneCadre(video: HTMLVideoElement): Zone | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const ew = video.clientWidth;
    const eh = video.clientHeight;
    if (!vw || !vh || !ew || !eh) return null;
    const echelle = Math.max(ew / vw, eh / vh);
    const cote = (eh * CADRE) / echelle;
    return { x: (vw - cote) / 2, y: (vh - cote) / 2, l: cote, h: cote };
  }

  // Texte du QR visé, ou null : seul un QR dont le centre est dans le cadre est accepté
  private async lireCadre(video: HTMLVideoElement): Promise<string | null> {
    const zone = this.zoneCadre(video);
    if (!zone) return null;
    // 1. Lecteur natif : tous les QR de l'image avec leur position, on garde celui du cadre le plus proche du centre
    if (this.natif) {
      try {
        const codes = await this.natif.detect(video);
        const cx = zone.x + zone.l / 2;
        const cy = zone.y + zone.h / 2;
        const vus = codes
          .map((c) => ({ texte: c.rawValue.trim(), x: c.boundingBox.x + c.boundingBox.width / 2, y: c.boundingBox.y + c.boundingBox.height / 2 }))
          .filter((c) => c.texte);
        const choix = vus
          .filter((c) => dansZone(zone, c.x, c.y))
          .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
        if (!choix && vus.length) this.horsCadre(vus[0].texte);
        return choix?.texte ?? null;
      } catch {
        this.natif = null; // lecteur natif en panne : zxing prend le relais
      }
    }
    // 2. zxing sur le cadre seul (un voisin hors du cadre ne gêne pas)
    const r = this.decoder(video, zone);
    if (r) return r.texte;
    // 3. Une image sur deux : zxing sur l'image entière (QR plus grand que le cadre, ou un peu décentré),
    //    accepté seulement si le centre du QR est dans le cadre
    if (++this.tour % 2 === 0) {
      const e = this.decoder(video, { x: 0, y: 0, l: video.videoWidth, h: video.videoHeight });
      if (e && dansZone(zone, e.cx, e.cy)) return e.texte;
      if (e) this.horsCadre(e.texte);
    }
    return null;
  }

  // Décode une zone de l'image de la caméra ; renvoie le texte et le centre du QR (pixels de la vidéo)
  private decoder(video: HTMLVideoElement, z: Zone): Trouve | null {
    const k = Math.min(1, COTE_MAX / Math.max(z.l, z.h));
    const toile = this.toile;
    toile.width = Math.max(1, Math.round(z.l * k));
    toile.height = Math.max(1, Math.round(z.h * k));
    const ctx = toile.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, z.x, z.y, z.l, z.h, 0, 0, toile.width, toile.height);
    try {
      const r = this.lecteur.decodeFromCanvas(toile);
      const texte = r.getText().trim();
      if (!texte) return null;
      const pts = r.getResultPoints() ?? [];
      const moy = (f: (p: (typeof pts)[number]) => number, defaut: number) =>
        pts.length ? pts.reduce((s, p) => s + f(p), 0) / pts.length : defaut;
      return { texte, cx: z.x + moy((p) => p.getX(), toile.width / 2) / k, cy: z.y + moy((p) => p.getY(), toile.height / 2) / k };
    } catch {
      return null; // pas de QR lisible dans cette zone
    }
  }

  // Image analysée : le QR qui vient d'être lu, toujours devant la caméra, n'est pas relu
  private vu(texte: string | null): void {
    const d = this.camera.dernier;
    if (texte && texte === d.texte && (this.camera.absences < ABSENCES_RELECTURE || Date.now() - d.date < RELECTURE_MIN_MS)) {
      this.camera.absences = 0;
      if (this.dejaSignale !== d.date) {
        this.dejaSignale = d.date;
        this.montrerIndice('Déjà lu : présentez le QR suivant', false);
      }
      return;
    }
    this.camera.absences++;
    if (texte) this.traiter(texte);
  }

  private traiter(texte: string): void {
    const maintenant = Date.now();
    // QR tenu stable : le même texte plusieurs lectures d'affilée (un QR vu au passage est ignoré)
    if (texte === this.candidat.texte && maintenant - this.candidat.date < 1000) this.candidat.n++;
    else this.candidat = { texte, n: 1, date: maintenant };
    this.candidat.date = maintenant;
    if (this.candidat.n < LECTURES_STABLES) return;
    this.candidat = { texte: '', n: 0, date: 0 };
    this.camera.dernier = { texte, date: maintenant };
    this.camera.absences = 0;
    this.pause(PAUSE_MS);
    // Mauvais QR (ex. le QR « Codice Articolo » du haut du ticket) : consigne, et on continue
    const conseil = this.conseil(texte);
    if (conseil) {
      this.montrerIndice(conseil, true);
      return;
    }
    this.indice.set(null);
    this.lecture.emit({ texte, manuel: false });
  }

  private conseil(texte: string): string | null {
    if (this.attendu() === 'ticket' && estCodeEmplacement(texte)) return "Étiquette d'emplacement lue : scannez maintenant le ticket vert du produit";
    if (this.attendu() === 'ticket' && estQrArticle(texte)) return 'QR du haut lu : visez le QR du bas du ticket (avec le lot)';
    if (this.attendu() === 'ticket' && !ressembleTicket(texte)) return "Ce n'est pas un ticket produit : visez le QR du bas du ticket vert";
    if (this.attendu() === 'emplacement' && ressembleTicket(texte)) return "C'est un ticket produit : visez l'étiquette de l'emplacement";
    return null;
  }

  // QR vu mais hors du cadre : on le dit, sans le lire (souvent l'étiquette voisine)
  private horsCadre(texte: string): void {
    if (this.indice()) return;
    const court = texte.length > 14 ? texte.slice(0, 12) + '…' : texte;
    this.indice.set(`${court} vu à côté du cadre : centrez le QR visé`);
    clearTimeout(this.minuterieIndice);
    this.minuterieIndice = setTimeout(() => this.indice.set(null), 1500);
  }

  private montrerIndice(texte: string, vibrer: boolean): void {
    this.indice.set(texte);
    if (vibrer) {
      try {
        navigator.vibrate?.([40, 60, 40]);
      } catch {}
    }
    clearTimeout(this.minuterieIndice);
    this.minuterieIndice = setTimeout(() => this.indice.set(null), 2500);
  }
}
