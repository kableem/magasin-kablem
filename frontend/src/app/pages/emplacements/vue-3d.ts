import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type * as T from 'three';
import type { OrbitControls as TOrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LigneStock } from '../../services/reception';
import { BLOCS, Bloc, Emplacement, emplacementTampon } from './plan-magasin';

// ---------- Dimensions du magasin (en mètres, approximatives) ----------
const BAIE = 1.3; // largeur d'un emplacement (1 palette)
const PROFONDEUR = 1.15; // profondeur d'une façade
const NIVEAU = 1.05; // hauteur entre deux lisses
const ALLEE = 6; // largeur des allées entre les blocs (assez large pour circuler dans la vue 3D)
const LONGUEUR = 11 * BAIE; // 11 emplacements par façade
const TAMPON_PAS_X = 1.45; // place tampon (1 palette au sol) : largeur
const TAMPON_PAS_Z = 1.3; // place tampon : profondeur

// Couleurs reprises des photos du magasin
const COULEURS = {
  montant: 0xa3abb9,
  lisse: 0x1f4fb8,
  etiquette: '#ffe14a',
  bois: 0xd9b27c,
  carton: 0xc9a26b,
  sol: 0xdfe2e8,
  ligneSol: 0xf2c200,
  mur: 0xeef0f4,
  survol: 0x0c71c3,
  selection: 0xe02222,
};

// Couleurs des tourets de fil (bobines), choisies selon la référence
const COULEURS_FIL = [0xd8c21e, 0x8d9096, 0x1f1f22, 0x34459a, 0x6b4430, 0x2f6b45, 0xc0392b, 0xe6e6e6];

// Taille et disposition des bobines sur une palette (en mètres, par rapport au centre)
const FORMES_BOBINE = {
  grande: { rayon: 0.36, hauteur: 0.66, places: [[0, 0]] },
  moyenne: { rayon: 0.24, hauteur: 0.5, places: [[-0.26, 0], [0.26, 0]] },
  petite: {
    rayon: 0.14,
    hauteur: 0.36,
    places: [[-0.33, -0.19], [0, -0.19], [0.33, -0.19], [-0.33, 0.19], [0, 0.19], [0.33, 0.19]],
  },
};

interface Case {
  emplacement: Emplacement;
  centre: T.Vector3; // centre de la case
  normale: number; // +1 : la façade regarde vers +z, -1 : vers -z
}

@Component({
  selector: 'app-vue-3d',
  template: `
    <div class="scene" #scene>
      @if (chargement()) {
        <p class="chargement">Chargement de la vue 3D…</p>
      }
      @if (survol(); as s) {
        <div class="bulle" [style.left.px]="s.x" [style.top.px]="s.y">
          <b>{{ s.code }}</b>
          @if (s.contenu) {
            <span>{{ s.contenu }}</span>
          } @else {
            <span class="libre">Libre</span>
          }
        </div>
      }
      <div class="aide">Glisser : tourner · Clic droit : déplacer · Molette : zoomer · Clic : voir l'emplacement</div>
      <div class="legende">
        <span><i class="bobine"></i>Bobine</span>
        <span><i class="cosse"></i>Cosse</span>
        <span><i class="connecteur"></i>Connecteur</span>
        <button type="button" (click)="vueGenerale()">Vue générale</button>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .scene {
      position: relative;
      height: min(72vh, 720px);
      min-height: 420px;
      overflow: hidden;
      background: linear-gradient(180deg, #f4f6fa 0%, #e6e9ef 100%);
      border: 1px solid var(--bord);
      border-radius: 16px;
    }
    .scene canvas { display: block; width: 100%; height: 100%; outline: none; }
    .chargement { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--gris); }
    .bulle {
      position: absolute;
      z-index: 2;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 10px;
      font-size: 13px;
      pointer-events: none;
      color: #fff;
      background: rgba(6, 22, 58, 0.88);
      border-radius: 8px;
      transform: translate(14px, 14px);
    }
    .bulle b { font-family: Consolas, monospace; font-size: 15px; color: #ffe14a; }
    .bulle .libre { color: #8ee0b2; }
    .aide {
      position: absolute;
      left: 12px;
      top: 12px;
      padding: 6px 10px;
      font-size: 12.5px;
      color: var(--gris);
      background: rgba(255, 255, 255, 0.85);
      border-radius: 8px;
    }
    .legende {
      position: absolute;
      left: 12px;
      bottom: 12px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      font-size: 13px;
      background: rgba(255, 255, 255, 0.9);
      border-radius: 10px;
    }
    .legende span { display: inline-flex; align-items: center; gap: 6px; }
    .legende i { width: 14px; height: 14px; border-radius: 3px; }
    .legende .bobine { background: #34459a; border-radius: 50%; }
    .legende .cosse { background: #b98f58; border-radius: 50%; }
    .legende .connecteur { background: #c9a26b; }
    .legende button {
      padding: 5px 10px;
      font: inherit;
      font-weight: 600;
      color: var(--nuit);
      background: #fff;
      border: 1px solid var(--bord);
      border-radius: 8px;
      cursor: pointer;
    }
  `,
})
export class Vue3d implements AfterViewInit, OnDestroy {
  private zone = inject(NgZone);
  private conteneur = viewChild.required<ElementRef<HTMLDivElement>>('scene');

  // Blocs dessinés (le plan réel A à D par défaut ; la page « Emplacement test » donne son plan d'essai)
  readonly blocs = input<Bloc[]>(BLOCS);
  // Numéros du magasin affichés à la place du code (ex. A110 → 0012) ; vide = codes de l'application
  readonly numeros = input<Map<string, string>>(new Map());
  // true : pas d'étiquette sur les emplacements sans numéro du magasin (essai sur les cosses)
  readonly seulementNumeros = input(false);
  // Contenu de chaque emplacement : 1 palette, ou 1 / 2 / 6 bobines (grande / moyenne / petite)
  readonly occupation = input.required<Map<string, LigneStock[]>>();
  readonly selection = input<Emplacement | null>(null);
  readonly blocFocus = input<string>('');
  readonly capaciteTampon = input<number>(20); // nombre de places de la zone tampon
  readonly choisir = output<Emplacement>();

  chargement = signal(true);
  survol = signal<{ x: number; y: number; code: string; contenu: string } | null>(null);

  private THREE?: typeof T;
  private renderer?: T.WebGLRenderer;
  private scene?: T.Scene;
  private camera?: T.PerspectiveCamera;
  private controls?: TOrbitControls;
  private raycaster?: T.Raycaster;
  private contenus?: T.Group; // palettes posées dans les emplacements
  private zones: T.Mesh[] = []; // une zone cliquable (invisible) par emplacement
  private cases = new Map<string, Case>();
  private cadreSurvol?: T.Mesh;
  private cadreSelection?: T.Mesh;
  private animation?: { debut: number; de: [T.Vector3, T.Vector3]; vers: [T.Vector3, T.Vector3] };
  private boucle = 0;
  private observateur?: ResizeObserver;
  private aDetruire: { dispose(): void }[] = [];
  private profondeurTotale = 0;
  private longueurMax = LONGUEUR; // longueur du bloc le plus long
  private zMaxCamera = Infinity; // la caméra reste devant le mur côté bloc D
  private groupes = new Map<string, T.Group>(); // un groupe 3D par bloc
  private blocIsole = ''; // bloc affiché seul ('' = tout le magasin)
  private groupeTampon?: T.Group; // zone tampon (reconstruite quand sa capacité change)

  constructor() {
    // La zone tampon suit sa capacité (réglée par l'administrateur)
    effect(() => {
      const capacite = this.capaciteTampon();
      if (!this.scene) return;
      this.construireTampon(capacite);
      this.construireContenus(untracked(this.occupation));
    });
    // Les palettes suivent l'occupation des emplacements
    effect(() => {
      const occupation = this.occupation();
      if (this.scene) this.construireContenus(occupation);
    });
    // Emplacement choisi : cadre rouge + caméra devant la case
    effect(() => {
      const e = this.selection();
      if (!this.scene) return;
      this.montrerSelection(e);
    });
    // Choix d'un bloc dans les onglets : la caméra se place devant le bloc,
    // sauf si l'emplacement choisi est dans ce bloc (il garde la priorité)
    effect(() => {
      const bloc = this.blocFocus();
      if (!this.scene) return;
      const choisi = untracked(this.selection);
      if (choisi && (!bloc || choisi.bloc === bloc)) this.montrerSelection(choisi);
      else if (bloc) this.allerAuBloc(bloc);
      else this.vueGenerale();
    });
  }

  async ngAfterViewInit(): Promise<void> {
    // three.js est chargé seulement quand la vue 3D est ouverte
    const [THREE, { OrbitControls }] = await Promise.all([
      import('three'),
      import('three/examples/jsm/controls/OrbitControls.js'),
    ]);
    this.THREE = THREE;
    const hote = this.conteneur().nativeElement;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xeef1f5);
    hote.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xeef1f5, 60, 120);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05; // ne pas passer sous le sol
    this.controls.minDistance = 2;
    this.controls.maxDistance = 80;
    this.raycaster = new THREE.Raycaster();

    this.construireMagasin();
    this.construireTampon(this.capaciteTampon());
    this.construireContenus(this.occupation());
    if (this.blocFocus()) this.allerAuBloc(this.blocFocus(), false);
    else this.vueGenerale(false);
    this.montrerSelection(this.selection(), false);

    this.redimensionner();
    this.observateur = new ResizeObserver(() => this.redimensionner());
    this.observateur.observe(hote);
    this.brancherSouris();
    this.chargement.set(false);

    // La boucle de rendu tourne hors d'Angular (pas de détection de changement à chaque image)
    this.zone.runOutsideAngular(() => {
      const rendre = (t: number) => {
        this.boucle = requestAnimationFrame(rendre);
        this.animerCamera(t);
        this.controls!.update();
        this.renderer!.render(this.scene!, this.camera!);
      };
      this.boucle = requestAnimationFrame(rendre);
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.boucle);
    this.observateur?.disconnect();
    this.controls?.dispose();
    this.scene?.traverse((o) => {
      const m = o as T.Mesh;
      m.geometry?.dispose();
    });
    this.aDetruire.forEach((d) => d.dispose());
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }

  // ---------- Construction du magasin ----------
  private construireMagasin(): void {
    const THREE = this.THREE!;
    const scene = this.scene!;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa3b5, 1.6));
    const soleil = new THREE.DirectionalLight(0xffffff, 1.6);
    soleil.position.set(10, 25, 18);
    scene.add(soleil);

    const mat = (couleur: number) => this.retenir(new THREE.MeshLambertMaterial({ color: couleur }));
    const matMontant = mat(COULEURS.montant);
    const matLisse = mat(COULEURS.lisse);
    let cible: T.Object3D = scene;
    const boite = (l: number, h: number, p: number, m: T.Material, x: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(l, h, p), m);
      b.position.set(x, y, z);
      cible.add(b);
      return b;
    };

    // Position z de chaque bloc : A contre le mur, puis B, C, D… séparés par des allées
    const blocs = this.blocs();
    let z = 0;
    let zFinD = 0; // la porte de sortie est dans l'allée qui suit le bloc D
    const hauteur = 5 * NIVEAU + 0.25;
    const zoneGeo = new THREE.BoxGeometry(BAIE * 0.92, NIVEAU * 0.9, PROFONDEUR * 0.92);
    const zoneMat = this.retenir(new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));

    for (const bloc of blocs) {
      // Tout le rayonnage du bloc dans un groupe, pour pouvoir l'isoler
      const groupe = new THREE.Group();
      scene.add(groupe);
      this.groupes.set(bloc.lettre, groupe);
      cible = groupe;
      const nbFacades = bloc.facades.length;
      const zDebut = z;
      const zFin = z + nbFacades * PROFONDEUR;
      const longueur = bloc.nbEmplacements * BAIE; // 11 emplacements (14 pour le bloc E d'essai)

      // Montants (gris) : à chaque baie, sur chaque ligne de profondeur
      for (let p = 0; p <= nbFacades; p++) {
        for (let k = 0; k <= bloc.nbEmplacements; k++) {
          boite(0.08, hauteur, 0.08, matMontant, k * BAIE, hauteur / 2, zDebut + p * PROFONDEUR);
        }
      }

      for (const f of bloc.facades) {
        // Façade tournée vers le bloc D (+z) ou vers le bloc A (-z)
        const normale = f.normale;
        const zAvant = normale === 1 ? zFin : zDebut;
        const zArriere = zAvant - normale * PROFONDEUR;
        const zCentre = (zAvant + zArriere) / 2;

        // Lisses bleues : une lisse basse au sol, puis une par niveau (+ le haut)
        const hauteursLisses = [0.15, 1, 2, 3, 4, 5].map((n, i) => (i === 0 ? n : n * NIVEAU));
        for (const y of hauteursLisses) {
          boite(longueur, 0.12, 0.06, matLisse, longueur / 2, y, zAvant);
          boite(longueur, 0.12, 0.06, matLisse, longueur / 2, y, zArriere);
        }

        for (const n of f.niveaux) {
          n.emplacements.forEach((e) => {
            const x = (e.position + 0.5) * BAIE; // position 0 = contre le mur du fond
            const yBase = n.niveau === 0 ? 0 : n.niveau * NIVEAU + 0.06;
            const centre = new THREE.Vector3(x, yBase + NIVEAU * 0.45, zCentre);
            this.cases.set(e.code, { emplacement: e, centre, normale });

            // Zone cliquable invisible
            const zone = new THREE.Mesh(zoneGeo, zoneMat);
            zone.position.copy(centre);
            zone.userData['code'] = e.code;
            zone.userData['bloc'] = bloc.lettre;
            groupe.add(zone);
            this.zones.push(zone);

            // Étiquette jaune avec le code, sur la lisse avant
            if (this.seulementNumeros() && !this.numeros().has(e.code)) return;
            const yLisse = n.niveau === 0 ? 0.15 : n.niveau * NIVEAU;
            const etiquette = this.etiquette(this.numeros().get(e.code) ?? e.code, 0.62, 0.2);
            etiquette.position.set(x, yLisse, zAvant + normale * 0.04);
            etiquette.rotation.y = normale === 1 ? 0 : Math.PI;
            groupe.add(etiquette);
          });
        }
      }

      // Panneau jaune « BLOC A » au-dessus de chaque extrémité du rayonnage
      for (const cote of [-1, 1]) {
        const panneau = this.panneauBloc(bloc.lettre);
        panneau.position.set(cote === -1 ? -0.05 : longueur + 0.05, hauteur + 1.05, (zDebut + zFin) / 2);
        panneau.rotation.y = (cote * Math.PI) / 2;
        groupe.add(panneau);
      }

      if (bloc.lettre === 'D') zFinD = zFin;
      z = zFin + ALLEE;
    }
    cible = scene;
    this.profondeurTotale = z - ALLEE;
    this.longueurMax = Math.max(...blocs.map((b) => b.nbEmplacements * BAIE));
    const LONGUEUR = this.longueurMax; // sol, murs et lignes : jusqu'au bout du bloc le plus long
    // Mur du bout : collé derrière le dernier bloc s'il n'a qu'une façade (H, comme A),
    // sinon au-delà de l'allée du dernier bloc (allée de la porte, côté D)
    const dernierContreMur = blocs.length > 1 && blocs[blocs.length - 1].contreMur;
    const zMurGauche = this.profondeurTotale + (dernierContreMur ? 0.25 : ALLEE);

    // Sol, lignes jaunes des allées et mur derrière le bloc A (à droite en vue générale)
    const sol = new THREE.Mesh(
      new THREE.PlaneGeometry(LONGUEUR + 16, this.profondeurTotale + 16),
      mat(COULEURS.sol)
    );
    sol.rotation.x = -Math.PI / 2;
    sol.position.set(LONGUEUR / 2, 0, this.profondeurTotale / 2);
    scene.add(sol);

    const matLigne = this.retenir(new THREE.MeshBasicMaterial({ color: COULEURS.ligneSol }));
    let zl = 0;
    for (const bloc of blocs) {
      const zFin = zl + bloc.facades.length * PROFONDEUR;
      const longueur = bloc.nbEmplacements * BAIE;
      for (const zLigne of [zl - 0.35, zFin + 0.35]) {
        if (zLigne < 0 || zLigne > zMurGauche) continue;
        const ligne = new THREE.Mesh(new THREE.PlaneGeometry(longueur + 0.6, 0.1), matLigne);
        ligne.rotation.x = -Math.PI / 2;
        ligne.position.set(longueur / 2, 0.005, zLigne);
        scene.add(ligne);
      }
      zl = zFin + ALLEE;
    }

    const mur = new THREE.Mesh(new THREE.PlaneGeometry(LONGUEUR + 16, 8), mat(COULEURS.mur));
    mur.position.set(LONGUEUR / 2, 4, -0.25);
    scene.add(mur);

    // Mur du fond (côté emplacements 00) : ferme toutes les allées entre les blocs.
    // La porte de sortie vers la production est dans ce mur, dans l'allée du bloc D, devant D011.
    this.zMaxCamera = zMurGauche - 0.8;
    const xMurFond = -1.2;
    const zDebutFond = -0.4;
    const zFinFond = zMurGauche + 0.15;
    const porte = { centre: zFinD + ALLEE / 2, largeur: 3, hauteur: 3.6 };
    const zPorte1 = porte.centre - porte.largeur / 2;
    const zPorte2 = porte.centre + porte.largeur / 2;

    const matMurFond = mat(0xd9dce3);
    const segment = (z1: number, z2: number, y1: number, y2: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, y2 - y1, z2 - z1), matMurFond);
      m.position.set(xMurFond, (y1 + y2) / 2, (z1 + z2) / 2);
      scene.add(m);
    };
    segment(zDebutFond, zPorte1, 0, 8);
    segment(zPorte2, zFinFond, 0, 8);
    segment(zPorte1, zPorte2, porte.hauteur, 8);
    for (const [z1, z2] of [[zDebutFond, zPorte1], [zPorte2, zFinFond]]) {
      const plinthe = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.25, z2 - z1), matLigne);
      plinthe.position.set(xMurFond + 0.15, 0.125, (z1 + z2) / 2);
      scene.add(plinthe);
    }

    // Mur du bout (plein) : côté bloc D, ou derrière le bloc H dans le plan d'essai
    const murGauche = new THREE.Mesh(new THREE.BoxGeometry(LONGUEUR + 9.35, 8, 0.3), matMurFond);
    murGauche.position.set((xMurFond + LONGUEUR + 8) / 2, 4, zMurGauche);
    scene.add(murGauche);

    // Cadre vert de la porte et panneau « SORTIE PRODUCTION »
    const matPorte = this.retenir(new THREE.MeshLambertMaterial({ color: 0x2e7d4f }));
    for (const z of [zPorte1, zPorte2]) {
      const montantPorte = new THREE.Mesh(new THREE.BoxGeometry(0.4, porte.hauteur, 0.2), matPorte);
      montantPorte.position.set(xMurFond, porte.hauteur / 2, z);
      scene.add(montantPorte);
    }
    const traverse = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, porte.largeur + 0.2), matPorte);
    traverse.position.set(xMurFond, porte.hauteur, porte.centre);
    scene.add(traverse);
    const sortie = this.panneauTexte('SORTIE', 'PRODUCTION', '#2e7d4f', '#ffffff');
    sortie.position.set(xMurFond + 0.2, porte.hauteur + 0.85, porte.centre);
    sortie.rotation.y = Math.PI / 2;
    scene.add(sortie);

    const murLabel = this.panneauTexte('MUR', 'côté 00', '#d9dce3', '#333333');
    murLabel.position.set(-1.0, 6.6, this.profondeurTotale / 2);
    murLabel.rotation.y = Math.PI / 2;
    scene.add(murLabel);

    // Cadres de survol (bleu) et de sélection (rouge)
    const cadreGeo = new THREE.BoxGeometry(BAIE * 0.96, NIVEAU * 0.94, PROFONDEUR * 0.96);
    this.cadreSurvol = new THREE.Mesh(
      cadreGeo,
      this.retenir(new THREE.MeshBasicMaterial({ color: COULEURS.survol, transparent: true, opacity: 0.18, depthWrite: false }))
    );
    this.cadreSurvol.visible = false;
    scene.add(this.cadreSurvol);
    this.cadreSelection = new THREE.Mesh(
      cadreGeo,
      this.retenir(new THREE.MeshBasicMaterial({ color: COULEURS.selection, transparent: true, opacity: 0.3, depthWrite: false }))
    );
    this.cadreSelection.visible = false;
    scene.add(this.cadreSelection);

    // Magasin plus long (plan d'essai) : brouillard et recul de la caméra à la mesure
    const k = this.echelle();
    scene.fog = new THREE.Fog(0xeef1f5, 60 * k, 120 * k);
    this.camera!.far = 200 * k;
    this.camera!.updateProjectionMatrix();
    this.controls!.maxDistance = 80 * k;
  }

  // 1 pour le magasin réel (A à D), plus grand quand il y a plus de blocs
  private echelle(): number {
    return Math.max(1, this.profondeurTotale / 27);
  }

  // Palettes posées dans les emplacements occupés
// Zone tampon : places numérotées au sol, au bout ouvert des allées, devant les blocs A et B
  private construireTampon(capacite: number): void {
    const THREE = this.THREE!;
    const scene = this.scene!;
    if (this.groupeTampon) {
      scene.remove(this.groupeTampon);
      this.groupeTampon.traverse((o) => (o as T.Mesh).geometry?.dispose());
      this.zones = this.zones.filter((z) => z.userData['bloc'] !== 'T');
      for (const code of [...this.cases.keys()]) if (code.startsWith('T')) this.cases.delete(code);
    }
    const g = new THREE.Group();
    g.userData['bloc'] = 'T';

    // Les blocs A et B occupent z = 0 → fin du bloc B
    const zFinB = PROFONDEUR + ALLEE + 2 * PROFONDEUR;
    const lignes = Math.max(1, Math.floor((zFinB - 0.3) / TAMPON_PAS_Z));
    const colonnes = Math.ceil(capacite / lignes);
    const x0 = LONGUEUR + 1.6;
    const largeur = colonnes * TAMPON_PAS_X;
    const profondeur = Math.min(capacite, lignes) * TAMPON_PAS_Z;

    // Sol de la zone (orange clair) et bordure jaune
    const matSol = this.retenir(new THREE.MeshLambertMaterial({ color: 0xf6e3c4 }));
    const sol = new THREE.Mesh(new THREE.PlaneGeometry(largeur + 0.4, profondeur + 0.4), matSol);
    sol.rotation.x = -Math.PI / 2;
    sol.position.set(x0 + largeur / 2, 0.004, 0.3 + profondeur / 2);
    g.add(sol);
    const matBord = this.retenir(new THREE.MeshBasicMaterial({ color: 0xf2a900 }));
    const bord = (l: number, p: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(l, p), matBord);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.006, z);
      g.add(m);
    };
    bord(largeur + 0.5, 0.12, x0 + largeur / 2, 0.1);
    bord(largeur + 0.5, 0.12, x0 + largeur / 2, 0.5 + profondeur);
    bord(0.12, profondeur + 0.5, x0 - 0.2, 0.3 + profondeur / 2);
    bord(0.12, profondeur + 0.5, x0 + largeur + 0.2, 0.3 + profondeur / 2);

    // Panneau « ZONE TAMPON »
    const panneau = this.panneauTexte('ZONE TAMPON', `${capacite} places`, '#f2a900', '#111111');
    panneau.position.set(x0 + largeur / 2, 2.3, 0.3 + profondeur + 0.4);
    g.add(panneau);
    for (const dx of [-1.1, 1.1]) {
      const pied = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.75, 0.06), this.retenir(new THREE.MeshLambertMaterial({ color: 0x777777 })));
      pied.position.set(x0 + largeur / 2 + dx, 0.875, 0.3 + profondeur + 0.4);
      g.add(pied);
    }

    // Places T01, T02… : marquage au sol, code, zone cliquable
    const zoneGeo = new THREE.BoxGeometry(TAMPON_PAS_X * 0.9, NIVEAU * 0.9, TAMPON_PAS_Z * 0.9);
    const zoneMat = this.retenir(new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    for (let n = 1; n <= capacite; n++) {
      const e = emplacementTampon(n);
      const col = Math.floor((n - 1) / lignes);
      const ligne = (n - 1) % lignes;
      const x = x0 + col * TAMPON_PAS_X + TAMPON_PAS_X / 2;
      const z = 0.3 + ligne * TAMPON_PAS_Z + TAMPON_PAS_Z / 2;
      const centre = new THREE.Vector3(x, NIVEAU * 0.45, z);
      this.cases.set(e.code, { emplacement: e, centre, normale: 1 });

      const cadre = new THREE.Mesh(new THREE.PlaneGeometry(TAMPON_PAS_X - 0.12, TAMPON_PAS_Z - 0.12), this.retenir(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })));
      cadre.rotation.x = -Math.PI / 2;
      cadre.position.set(x, 0.008, z);
      g.add(cadre);
      const etiquette = this.etiquette(e.code, 0.62, 0.2);
      etiquette.rotation.x = -Math.PI / 2;
      etiquette.position.set(x, 0.012, z + TAMPON_PAS_Z / 2 - 0.16);
      g.add(etiquette);

      const zone = new THREE.Mesh(zoneGeo, zoneMat);
      zone.position.copy(centre);
      zone.userData['code'] = e.code;
      zone.userData['bloc'] = 'T';
      g.add(zone);
      this.zones.push(zone);
    }

    g.visible = !this.blocIsole || this.blocIsole === 'T';
    this.groupeTampon = g;
    scene.add(g);
  }

  private construireContenus(occupation: Map<string, LigneStock[]>): void {
    const THREE = this.THREE!;
    if (this.contenus) {
      this.scene!.remove(this.contenus);
      this.contenus.traverse((o) => (o as T.Mesh).geometry?.dispose());
    }
    this.contenus = new THREE.Group();

    const matBois = this.retenir(new THREE.MeshLambertMaterial({ color: COULEURS.bois }));
    const matCarton = this.retenir(new THREE.MeshLambertMaterial({ color: COULEURS.carton }));
    const matCosse = this.retenir(new THREE.MeshLambertMaterial({ color: 0xb98f58 }));
    const matEtiquetteVerte = this.retenir(new THREE.MeshLambertMaterial({ color: 0x9be3a9 }));
    const matsFil = COULEURS_FIL.map((c) => this.retenir(new THREE.MeshLambertMaterial({ color: c })));
    const matFlasque = this.retenir(new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }));

    for (const [code, lignes] of occupation) {
      const c = this.cases.get(code);
      const ligne = lignes[0];
      if (!c || !ligne) continue;
      const g = new THREE.Group();
      g.userData['bloc'] = c.emplacement.bloc;
      g.visible = !this.blocIsole || c.emplacement.bloc === this.blocIsole;
      const yBase = c.centre.y - NIVEAU * 0.45;
      g.position.set(c.centre.x, yBase, c.centre.z);

      // Palette en bois
      const palette = new THREE.Mesh(new THREE.BoxGeometry(BAIE * 0.82, 0.13, PROFONDEUR * 0.82), matBois);
      palette.position.y = 0.065;
      g.add(palette);

      if (ligne.type === 'bobine') {
        // Tourets de fil posés sur la palette : 1 grande, 2 moyennes ou jusqu'à 6 petites
        const forme = FORMES_BOBINE[ligne.taille_bobine ?? 'grande'];
        // Une bobine dessinée par produit (une ligne de quantité 3 = 3 bobines)
        const bobines = lignes.flatMap((l) => Array.from({ length: l.quantite ?? 1 }, () => l));
        bobines.slice(0, forme.places.length).forEach((bobine, k) => {
          const [dx, dz] = forme.places[k];
          const fil = new THREE.Mesh(
            new THREE.CylinderGeometry(forme.rayon, forme.rayon, forme.hauteur, 24),
            matsFil[this.hash(bobine.reference) % matsFil.length]
          );
          fil.position.set(dx, 0.13 + forme.hauteur / 2, dz);
          g.add(fil);
          for (const yF of [0.13 + 0.02, 0.13 + forme.hauteur - 0.02]) {
            const flasque = new THREE.Mesh(
              new THREE.CylinderGeometry(forme.rayon * 1.12, forme.rayon * 1.12, 0.04, 24),
              matFlasque
            );
            flasque.position.set(dx, yF, dz);
            g.add(flasque);
          }
        });
      } else if (ligne.type === 'cosse') {
        // Bobines plates de cosses, empilées : une par cosse (10 au maximum par palette)
        const nbCosses = Math.min(10, lignes.reduce((s, l) => s + (l.quantite ?? 1), 0));
        for (let k = 0; k < nbCosses; k++) {
          const disque = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.06, 28), matCosse);
          disque.position.y = 0.13 + 0.035 + k * 0.072;
          g.add(disque);
        }
      } else {
        // Cartons de connecteurs avec étiquette verte
        for (let k = 0; k < 4; k++) {
          const carton = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.42), matCarton);
          carton.position.set(k % 2 ? 0.27 : -0.27, 0.13 + 0.16 + Math.floor(k / 2) * 0.33, 0);
          g.add(carton);
          const label = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.1), matEtiquetteVerte);
          label.position.set(carton.position.x, carton.position.y, c.normale * 0.211);
          label.rotation.y = c.normale === 1 ? 0 : Math.PI;
          g.add(label);
        }
      }
      this.contenus.add(g);
    }
    this.scene!.add(this.contenus);
  }

  // ---------- Textures dessinées (étiquettes, panneaux) ----------
  private etiquette(texte: string, largeur: number, hauteur: number): T.Mesh {
    const THREE = this.THREE!;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 42;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = COULEURS.etiquette;
    ctx.fillRect(0, 0, 128, 42);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 30px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(texte, 64, 23);
    const texture = this.retenir(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    const mat = this.retenir(new THREE.MeshBasicMaterial({ map: texture }));
    return new THREE.Mesh(new THREE.PlaneGeometry(largeur, hauteur), mat);
  }

  // Panneau à deux lignes (sortie, mur)
  private panneauTexte(ligne1: string, ligne2: string, fond: string, texte: string): T.Mesh {
    const THREE = this.THREE!;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 140;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = fond;
    ctx.fillRect(0, 0, 320, 140);
    ctx.fillStyle = texte;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 54px Arial, sans-serif';
    ctx.fillText(ligne1, 160, 48);
    ctx.font = 'bold 34px Arial, sans-serif';
    ctx.fillText(ligne2, 160, 108);
    const texture = this.retenir(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    const mat = this.retenir(new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
    return new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.14), mat);
  }

  private panneauBloc(lettre: string): T.Mesh {
    const THREE = this.THREE!;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 200;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = COULEURS.etiquette;
    ctx.fillRect(0, 0, 256, 200);
    ctx.strokeStyle = '#c9a800';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 248, 192);
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 40px Arial, sans-serif';
    ctx.fillText('BLOC', 128, 38);
    ctx.font = 'bold 140px Arial, sans-serif';
    ctx.fillText(lettre, 128, 128);
    const texture = this.retenir(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    // Face avant seulement : vu de dos, le panneau n'apparaît pas à l'envers
    const mat = this.retenir(new THREE.MeshBasicMaterial({ map: texture }));
    return new THREE.Mesh(new THREE.PlaneGeometry(2, 1.56), mat);
  }

  // ---------- Caméra ----------
  vueGenerale(anime = true): void {
    if (!this.THREE) return;
    this.isoler('');
    const V = this.THREE.Vector3;
    // Vue depuis le bout des allées : mur à droite, puis blocs A, B, C, D vers la gauche
    const longueur = this.longueurMax;
    const centre = new V(longueur / 2 - 1, 1.8, this.profondeurTotale / 2);
    const k = this.echelle();
    this.deplacer(new V(longueur + 26 * k, 15 * k, this.profondeurTotale / 2 + 4), centre, anime);
  }

  private allerAuBloc(lettre: string, anime = true): void {
    const cases = [...this.cases.values()].filter((c) => c.emplacement.bloc === lettre);
    if (!cases.length || !this.THREE) return;
    this.isoler(lettre);
    const V = this.THREE.Vector3;
    const z = cases.reduce((s, c) => s + c.centre.z, 0) / cases.length;
    const LONGUEUR = Math.max(...cases.map((c) => c.centre.x)) + BAIE / 2; // longueur de ce bloc
    // Vue depuis l'allée devant le bloc (côté +z) ; bloc contre le mur du bout (H) : depuis le côté -z
    if (cases.every((c) => c.normale === -1)) {
      this.deplacer(new V(LONGUEUR / 2 + 4, 6.5, z - 12), new V(LONGUEUR / 2, 2.4, z), anime);
      return;
    }
    const zCamera = Math.min(z + 12, this.zMaxCamera);
    // Près du mur côté D, la caméra recule dans l'allée pour voir tout le bloc
    const xCamera = zCamera < z + 12 ? LONGUEUR + 6 : LONGUEUR / 2 + 4;
    this.deplacer(new V(xCamera, 6.5, zCamera), new V(LONGUEUR / 2, 2.4, z), anime);
  }

  private montrerSelection(e: Emplacement | null, anime = true): void {
    if (!this.cadreSelection) return;
    const c = e ? this.cases.get(e.code) : undefined;
    this.cadreSelection.visible = !!c;
    if (!c) return;
    this.cadreSelection.position.copy(c.centre);
    // Les autres blocs sont masqués pour voir l'emplacement sans obstacle
    this.isoler(c.emplacement.bloc);
    // Caméra en face de l'emplacement, un peu en hauteur
    const V = this.THREE!.Vector3;
    // Zone tampon (au sol) : vue plongeante depuis le bout des allées ; rayonnages : en face de la case
    const position =
      c.emplacement.bloc === 'T'
        ? new V(c.centre.x + 4.5, c.centre.y + 5, c.centre.z + 2.5)
        : new V(c.centre.x + 1.2, c.centre.y + 1.6, Math.min(c.centre.z + c.normale * 5.5, this.zMaxCamera));
    this.deplacer(position, c.centre.clone(), anime);
  }

  // Affiche un seul bloc ('' = tout le magasin)
  private isoler(lettre: string): void {
    this.blocIsole = lettre;
    for (const [l, g] of this.groupes) g.visible = !lettre || l === lettre;
    if (this.groupeTampon) this.groupeTampon.visible = !lettre || lettre === 'T';
    this.contenus?.children.forEach((g) => (g.visible = !lettre || g.userData['bloc'] === lettre));
    if (this.cadreSurvol) this.cadreSurvol.visible = false;
  }

  private deplacer(position: T.Vector3, cible: T.Vector3, anime: boolean): void {
    if (!this.camera || !this.controls) return;
    if (!anime) {
      this.camera.position.copy(position);
      this.controls.target.copy(cible);
      return;
    }
    this.animation = {
      debut: performance.now(),
      de: [this.camera.position.clone(), this.controls.target.clone()],
      vers: [position, cible],
    };
  }

  private animerCamera(t: number): void {
    if (!this.animation) return;
    const k = Math.min(1, (t - this.animation.debut) / 700);
    const doux = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    this.camera!.position.lerpVectors(this.animation.de[0], this.animation.vers[0], doux);
    this.controls!.target.lerpVectors(this.animation.de[1], this.animation.vers[1], doux);
    if (k === 1) this.animation = undefined;
  }

  // ---------- Souris : survol et clic ----------
  private brancherSouris(): void {
    const canvas = this.renderer!.domElement;
    let depart: { x: number; y: number } | null = null;

    this.zone.runOutsideAngular(() => {
      canvas.addEventListener('pointermove', (ev) => {
        const code = this.toucher(ev);
        const c = code ? this.cases.get(code) : undefined;
        this.cadreSurvol!.visible = !!c;
        canvas.style.cursor = c ? 'pointer' : 'grab';
        if (c) this.cadreSurvol!.position.copy(c.centre);
        const contenu = code ? this.occupation().get(code) ?? [] : [];
        const rect = canvas.getBoundingClientRect();
        this.zone.run(() =>
          this.survol.set(
            code
              ? {
                  x: ev.clientX - rect.left,
                  y: ev.clientY - rect.top,
                  code: this.numeros().has(code) ? `${this.numeros().get(code)} · ${code}` : code,
                  contenu: contenu.length
                    ? contenu.length > 1 || (contenu[0].quantite ?? 1) > 1
                      ? `${contenu.reduce((s, l) => s + (l.quantite ?? 1), 0)} × ${[...new Set(contenu.map((l) => l.reference))].join(', ')}`
                      : `${contenu[0].reference} · lot ${contenu[0].lot}`
                    : '',
                }
              : null
          )
        );
      });
      canvas.addEventListener('pointerleave', () => {
        this.cadreSurvol!.visible = false;
        this.zone.run(() => this.survol.set(null));
      });
      canvas.addEventListener('pointerdown', (ev) => (depart = { x: ev.clientX, y: ev.clientY }));
      canvas.addEventListener('pointerup', (ev) => {
        // Un vrai clic (pas une rotation de la caméra)
        if (!depart || Math.hypot(ev.clientX - depart.x, ev.clientY - depart.y) > 5 || ev.button !== 0) return;
        const code = this.toucher(ev);
        const c = code ? this.cases.get(code) : undefined;
        if (c) this.zone.run(() => this.choisir.emit(c.emplacement));
      });
    });
  }

  private toucher(ev: PointerEvent): string | null {
    const canvas = this.renderer!.domElement;
    const rect = canvas.getBoundingClientRect();
    const souris = new this.THREE!.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster!.setFromCamera(souris, this.camera!);
    const visibles = this.zones.filter((z) => !this.blocIsole || z.userData['bloc'] === this.blocIsole);
    const touche = this.raycaster!.intersectObjects(visibles, false)[0];
    return touche ? (touche.object.userData['code'] as string) : null;
  }

  private redimensionner(): void {
    const hote = this.conteneur().nativeElement;
    const l = hote.clientWidth;
    const h = hote.clientHeight;
    if (!l || !h) return;
    this.renderer!.setSize(l, h);
    this.camera!.aspect = l / h;
    this.camera!.updateProjectionMatrix();
  }

  private retenir<R extends { dispose(): void }>(ressource: R): R {
    this.aDetruire.push(ressource);
    return ressource;
  }

  private hash(texte: string): number {
    let h = 0;
    for (const c of texte) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h;
  }
}
