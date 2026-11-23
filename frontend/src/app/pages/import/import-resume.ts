import { Component, OnDestroy, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ApercuImportResume, ReceptionService, formatNombre } from '../../services/reception';

type EtatLigne = 'ok' | 'absente' | 'illisible';
interface LigneApercu {
  ligne: number;
  reference: string;
  pieces: number | null;
  famille: string; // bobine, cosse, connecteur, inconnue
  libelle: string;
  etat: EtatLigne;
  message: string;
}

// Import « par référence » : le fichier de l'Italie ne donne que la référence et le total de pièces
// (« Codice » / « Somma di quantità »). On importe le fichier Excel (ou on colle les lignes) ;
// le lot et les pièces de chaque colis seront lus sur les tickets à la réception mobile.
// Grand écran : à gauche la livraison et la source, à droite l'aperçu ligne par ligne, avec les lignes
// à corriger mises en avant et retirables d'un clic.
@Component({
  selector: 'app-import-resume',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="fond" (click)="fermer.emit()">
      <form class="modale modale-resume" (click)="$event.stopPropagation()" (ngSubmit)="enregistrer()" novalidate>
        <header class="entete">
          <div>
            <h2>Import par référence</h2>
            <p>Le fichier de l'Italie donne <b>la référence et le total de pièces</b>. À la réception, chaque ticket scanné donne son lot et ses pièces : l'application compare avec ce total.</p>
          </div>
          <button type="button" class="icone-btn" (click)="fermer.emit()" aria-label="Fermer">
            <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
          </button>
        </header>

        <div class="corps">
          <!-- ===== Colonne gauche : livraison et source ===== -->
          <section class="colonne-saisie">
            <div class="etape">
              <span class="num">1</span>
              <h3>La livraison</h3>
            </div>
            <label class="champ">
              N° de livraison
              <input name="numero" class="mono" maxlength="50" placeholder="ex. PackingKLTN_291026" [(ngModel)]="numero" (ngModelChange)="dateDepuisNumero()" autocomplete="off" />
            </label>
            <label class="champ">
              Date d'envoi
              <input name="date" type="date" [(ngModel)]="dateEnvoi" (ngModelChange)="dateTouchee = true" />
            </label>

            <div class="etape">
              <span class="num">2</span>
              <h3>Le fichier</h3>
            </div>
            <input #fichier type="file" accept=".xlsx,.xls,.csv" hidden (change)="choisirFichier(fichier)" />
            <button
              type="button"
              class="depot"
              [class.survol]="survol()"
              [class.charge]="!!nomFichier()"
              [disabled]="lecture()"
              (click)="fichier.click()"
              (dragover)="$event.preventDefault(); survol.set(true)"
              (dragleave)="survol.set(false)"
              (drop)="deposer($event)"
            >
              <svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zm-4.7 9-1.4-1.4L9.4 14 6.9 11.4l1.4-1.4 2.5 2.6 2.5-2.6 1.4 1.4-2.5 2.6 2.5 2.6-1.4 1.4-2.5-2.6L8.3 18z" /></svg>
              @if (lecture()) {
                <b>Lecture du fichier…</b>
              } @else if (nomFichier()) {
                <b>{{ nomFichier() }}</b>
                <small>Cliquez ou déposez un autre fichier pour le remplacer</small>
              } @else {
                <b>Déposez le fichier Excel ici</b>
                <small>ou cliquez pour le choisir · .xlsx, .xls, .csv · colonnes « Codice » et « Somma di quantità »</small>
              }
            </button>

            <button type="button" class="lien-texte" (click)="texteOuvert.set(!texteOuvert())">
              {{ texteOuvert() ? 'Masquer les lignes' : 'Voir ou coller les lignes à la main' }} ({{ nbLignesTexte() }})
            </button>
            @if (texteOuvert()) {
              <textarea
                name="texte"
                class="mono"
                placeholder="AK 15317766	45 000&#10;F0302	13 500&#10;F0411	6 900"
                [ngModel]="texte()"
                (ngModelChange)="changerTexte($event)"
              ></textarea>
            }

            <p class="regle">Tout écart de pièces sur une référence devient une réclamation (en pièces) à la fin de la réception ; ce qui est reçu entre au stock.</p>
          </section>

          <!-- ===== Colonne droite : aperçu ===== -->
          <section class="colonne-apercu">
            <div class="etape">
              <span class="num">3</span>
              <h3>Vérifiez</h3>
              @if (verification()) {
                <small class="verif">Lecture des lignes…</small>
              }
            </div>

            @if (erreur()) {
              <p class="erreur">{{ erreur() }}</p>
            }

            @if (lignes().length) {
              <div class="compteurs">
                <div class="compteur"><b>{{ nombre(nbReferences()) }}</b><small>références</small></div>
                <div class="compteur"><b>{{ nombre(apercu()?.total ?? 0) }}</b><small>pièces annoncées</small></div>
                <div class="compteur"><b>{{ nombre(nbFamille('cosse')) }}</b><small>cosses</small></div>
                <div class="compteur"><b>{{ nombre(nbFamille('bobine')) }}</b><small>bobines</small></div>
                <div class="compteur"><b>{{ nombre(nbFamille('connecteur')) }}</b><small>connecteurs</small></div>
                <div class="compteur" [class.alerte]="aCorriger().length"><b>{{ aCorriger().length }}</b><small>à corriger</small></div>
              </div>

              @if (aCorriger().length) {
                <div class="bandeau-corriger">
                  <span>
                    <b>{{ aCorriger().length }} ligne(s) empêchent la création.</b>
                    Accessoires, palette, références absentes du catalogue ou lignes sans quantité : retirez-les, ou ajoutez les références au catalogue Articles.
                  </span>
                  <button type="button" class="btn btn-secondaire" (click)="retirerLignes(aCorriger())">Retirer les {{ aCorriger().length }} ligne(s)</button>
                </div>
              } @else if (pret()) {
                <div class="bandeau-pret">Tout est prêt : {{ nbReferences() }} référence(s), {{ nombre(apercu()?.total ?? 0) }} pièces.</div>
              }

              <div class="outils">
                <div class="filtres" role="radiogroup" aria-label="Filtrer les lignes">
                  @for (f of filtres; track f.valeur) {
                    <button type="button" role="radio" [attr.aria-checked]="filtre() === f.valeur" [class.actif]="filtre() === f.valeur" (click)="filtre.set(f.valeur)">
                      {{ f.libelle }} <span>{{ compte(f.valeur) }}</span>
                    </button>
                  }
                </div>
                <input class="recherche" type="search" name="recherche" placeholder="Chercher une référence…" [ngModel]="recherche()" (ngModelChange)="recherche.set($event)" autocomplete="off" />
              </div>

              <div class="table-apercu">
                <table>
                  <thead>
                    <tr><th class="n">Ligne</th><th>Référence</th><th>Type</th><th class="droite">Pièces</th><th>État</th><th></th></tr>
                  </thead>
                  <tbody>
                    @for (l of lignesFiltrees(); track l.ligne) {
                      <tr [attr.data-etat]="l.etat">
                        <td class="n">{{ l.ligne }}</td>
                        <td class="mono ref">{{ l.reference }}</td>
                        <td><span class="type" [attr.data-famille]="l.famille">{{ l.libelle }}</span></td>
                        <td class="droite"><b>{{ l.pieces === null ? '—' : nombre(l.pieces) }}</b></td>
                        <td class="etat">
                          @if (l.etat === 'ok') {
                            <span class="ok">✓ Prête</span>
                          } @else {
                            <span class="ko">{{ l.message }}</span>
                          }
                        </td>
                        <td class="droite">
                          <button type="button" class="retirer" (click)="retirerLignes([l])" [attr.aria-label]="'Retirer la ligne ' + l.ligne" title="Retirer cette ligne">
                            <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>
                          </button>
                        </td>
                      </tr>
                    } @empty {
                      <tr><td colspan="6" class="vide">Aucune ligne ne correspond.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <div class="attente">
                <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14H7v-2h5v2zm5-4H7v-2h10v2zm0-4H7V7h10v2z" /></svg>
                <b>L'aperçu apparaît ici</b>
                <small>Déposez le fichier Excel de l'Italie à gauche : chaque référence est contrôlée avec le catalogue Articles.</small>
                @for (p of apercu()?.problemes ?? []; track $index) {
                  <p class="erreur">{{ p }}</p>
                }
              </div>
            }
          </section>
        </div>

        <footer class="pied">
          <span class="resume">
            @if (pret()) {
              <b>{{ numero }}</b> · {{ nbReferences() }} référence(s) · {{ nombre(apercu()?.total ?? 0) }} pièces
            } @else if (lignes().length && numero.trim().length < 3) {
              Indiquez le n° de livraison.
            } @else if (aCorriger().length) {
              {{ aCorriger().length }} ligne(s) à corriger avant de créer l'import.
            }
          </span>
          <button type="button" class="btn btn-secondaire" (click)="fermer.emit()">Annuler</button>
          <button type="submit" class="btn btn-principal" [disabled]="envoi() || !pret()">{{ envoi() ? 'Création…' : "Créer l'import" }}</button>
        </footer>
      </form>
    </div>
  `,
  styles: `
    .modale-resume { display: flex; flex-direction: column; width: min(1320px, 97vw); height: 94vh; max-width: none; padding: 0; overflow: hidden; }
    .entete { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 26px 14px; border-bottom: 1px solid var(--bord); }
    .entete h2 { margin: 0 0 4px; }
    .icone-btn { flex: none; display: grid; place-items: center; width: 38px; height: 38px; padding: 0; background: none; border: 0; border-radius: 10px; cursor: pointer; }
    .icone-btn:hover { background: #eef2f9; }
    .icone-btn svg { width: 22px; fill: var(--nuit); }
    .entete p { margin: 0; font-size: 13.5px; color: var(--gris); max-width: 820px; }
    .corps { flex: 1; min-height: 0; display: grid; grid-template-columns: 360px 1fr; }
    .colonne-saisie { display: flex; flex-direction: column; gap: 12px; padding: 18px 22px; overflow-y: auto; background: #f7f8fc; border-right: 1px solid var(--bord); }
    .colonne-apercu { display: flex; flex-direction: column; gap: 12px; min-height: 0; padding: 18px 22px; }
    .etape { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
    .etape h3 { margin: 0; font-size: 15px; color: var(--nuit); }
    .etape .num { display: grid; place-items: center; width: 26px; height: 26px; font-size: 13px; font-weight: 800; color: #fff; background: var(--nuit); border-radius: 50%; }
    .etape .verif { margin-left: auto; color: var(--gris); }
    .champ { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--gris); }
    .champ input { height: 40px; background: #fff; }
    .mono { font-family: Consolas, monospace; }
    .depot { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-height: 150px; padding: 18px; font: inherit; text-align: center; color: var(--nuit); background: #fff; border: 2px dashed #b9c2d6; border-radius: 16px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
    .depot svg { width: 42px; fill: #1d6f42; }
    .depot b { font-size: 15px; word-break: break-all; }
    .depot small { font-size: 12.5px; color: var(--gris); }
    .depot:hover, .depot.survol { border-color: #1d6f42; background: #eef8f1; }
    .depot.charge { border-style: solid; border-color: #9fd8b6; background: #f1faf4; }
    .lien-texte { align-self: flex-start; padding: 0; font: inherit; font-size: 13px; font-weight: 600; color: var(--nuit); background: none; border: 0; text-decoration: underline dotted; cursor: pointer; }
    textarea { flex: 1; min-height: 180px; padding: 10px 12px; font-size: 13px; resize: vertical; background: #fff; }
    .regle { margin: auto 0 0; padding-top: 10px; font-size: 12.5px; color: var(--gris); }
    .erreur { margin: 0; padding: 10px 14px; color: #b81818; background: #fde8e8; border-radius: 10px; font-size: 13.5px; }
    .compteurs { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
    .compteur { padding: 10px 14px; background: #f4f6fb; border-radius: 12px; }
    .compteur b { display: block; font-size: 22px; color: var(--nuit); }
    .compteur small { font-size: 12px; color: var(--gris); }
    .compteur.alerte { background: #fde8e8; }
    .compteur.alerte b { color: #b81818; }
    .bandeau-corriger { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; padding: 10px 14px; font-size: 13.5px; color: #7a1f1f; background: #fff1f1; border-left: 4px solid #d7262e; border-radius: 10px; }
    .bandeau-pret { padding: 10px 14px; font-size: 14px; font-weight: 700; color: #0f6a3a; background: #e8f6ee; border-left: 4px solid #1d8a52; border-radius: 10px; }
    .outils { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
    .filtres { display: inline-flex; padding: 3px; background: #eef1f6; border-radius: 10px; }
    .filtres button { padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 600; color: var(--gris); background: none; border: 0; border-radius: 8px; cursor: pointer; }
    .filtres button span { margin-left: 4px; padding: 0 7px; font-size: 11.5px; background: #fff; border-radius: 999px; }
    .filtres button.actif { color: #fff; background: var(--nuit); }
    .filtres button.actif span { color: var(--nuit); }
    .recherche { width: 240px; height: 36px; }
    .table-apercu { flex: 1; min-height: 0; overflow-y: auto; border: 1px solid var(--bord); border-radius: 12px; }
    .table-apercu table { width: 100%; }
    .table-apercu th, .table-apercu td { padding: 7px 12px; }
    .table-apercu thead th { position: sticky; top: 0; z-index: 1; background: #f4f6fb; }
    .table-apercu .n { width: 56px; color: var(--gris); }
    .table-apercu .ref { font-weight: 700; }
    .table-apercu tr[data-etat='absente'] td, .table-apercu tr[data-etat='illisible'] td { background: #fff6f6; }
    .table-apercu .etat .ok { color: #0f7a43; font-weight: 700; font-size: 12.5px; }
    .table-apercu .etat .ko { color: #b81818; font-size: 12.5px; }
    .table-apercu .vide { padding: 24px; text-align: center; color: var(--gris); }
    .retirer { display: grid; place-items: center; width: 30px; height: 30px; margin-left: auto; padding: 0; background: none; border: 0; border-radius: 8px; cursor: pointer; }
    .retirer svg { width: 17px; fill: #9aa3b5; }
    .retirer:hover { background: #fde8e8; }
    .retirer:hover svg { fill: #b81818; }
    .droite { text-align: right; }
    .type { padding: 3px 10px; font-size: 12px; font-weight: 700; color: var(--gris); background: #eef1f6; border-radius: 999px; white-space: nowrap; }
    .type[data-famille='bobine'] { color: #164f96; background: #e8f1fc; }
    .type[data-famille='cosse'] { color: #9a5205; background: #fff2e0; }
    .type[data-famille='connecteur'] { color: #1d6b4f; background: #e3f5ec; }
    .type[data-famille='inconnue'] { color: #b81818; background: #fde8e8; }
    .attente { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 30px; text-align: center; color: var(--gris); border: 2px dashed #dfe3ec; border-radius: 16px; }
    .attente svg { width: 46px; fill: #c3cadb; }
    .attente b { font-size: 16px; color: var(--nuit); }
    .pied { display: flex; align-items: center; gap: 10px; padding: 14px 26px; border-top: 1px solid var(--bord); background: #fff; }
    .pied .resume { flex: 1; font-size: 13.5px; color: var(--gris); }
    @media (max-width: 900px) {
      .corps { grid-template-columns: 1fr; overflow-y: auto; }
      .colonne-saisie { border-right: 0; border-bottom: 1px solid var(--bord); }
      .compteurs { grid-template-columns: repeat(3, 1fr); }
      .table-apercu { min-height: 300px; }
    }
  `,
})
export class ImportResume implements OnDestroy {
  private service = inject(ReceptionService);
  readonly fermer = output<void>();
  readonly cree = output<{ id: number; numero: string; references: number; pieces: number }>();
  readonly nombre = formatNombre;

  numero = '';
  dateEnvoi = '';
  dateTouchee = false;
  readonly lecture = signal(false); // fichier Excel en cours de lecture
  readonly nomFichier = signal('');
  readonly survol = signal(false); // fichier glissé au-dessus de la zone de dépôt
  readonly texteOuvert = signal(false);
  readonly texte = signal('');
  readonly apercu = signal<ApercuImportResume | null>(null);
  readonly verification = signal(false);
  readonly erreur = signal('');
  readonly envoi = signal(false);
  readonly filtre = signal<'tout' | 'corriger' | 'ok'>('tout');
  readonly recherche = signal('');
  readonly filtres = [
    { valeur: 'tout' as const, libelle: 'Toutes' },
    { valeur: 'corriger' as const, libelle: 'À corriger' },
    { valeur: 'ok' as const, libelle: 'Prêtes' },
  ];
  private attente: ReturnType<typeof setTimeout> | undefined;
  private demande = 0;

  // Toutes les lignes lues, dans l'ordre du fichier, avec leur état
  readonly lignes = computed<LigneApercu[]>(() => {
    const a = this.apercu();
    if (!a) return [];
    const refs = a.references.map((r): LigneApercu => {
      const etat: EtatLigne = !r.type ? 'absente' : 'ok';
      return {
        ligne: r.ligne, reference: r.reference, pieces: r.pieces, famille: r.type ?? 'inconnue', libelle: this.libelleType(r), etat,
        message: etat === 'absente' ? 'Absente du catalogue Articles' : '',
      };
    });
    const erreurs = (a.erreurs_lignes ?? []).map((e): LigneApercu => ({
      ligne: e.ligne, reference: e.reference || e.texte.split(/\t|;|\s{2,}/)[0] || e.texte, pieces: null, famille: 'inconnue', libelle: 'Illisible', etat: 'illisible', message: majuscule(e.message),
    }));
    return [...refs, ...erreurs].sort((x, y) => x.ligne - y.ligne);
  });
  readonly aCorriger = computed(() => this.lignes().filter((l) => l.etat !== 'ok'));
  readonly nbReferences = computed(() => this.lignes().filter((l) => l.etat !== 'illisible').length);
  readonly nbLignesTexte = computed(() => this.texte().split(/\r?\n/).filter((l) => l.trim()).length);
  readonly lignesFiltrees = computed(() => {
    const q = this.recherche().trim().toUpperCase();
    return this.lignes().filter((l) =>
      (this.filtre() === 'tout' || (this.filtre() === 'ok' ? l.etat === 'ok' : l.etat !== 'ok')) && (!q || l.reference.toUpperCase().includes(q))
    );
  });

  ngOnDestroy(): void {
    clearTimeout(this.attente);
  }

  compte(f: 'tout' | 'corriger' | 'ok'): number {
    return f === 'tout' ? this.lignes().length : f === 'ok' ? this.lignes().length - this.aCorriger().length : this.aCorriger().length;
  }

  nbFamille(famille: string): number {
    return this.lignes().filter((l) => l.famille === famille).length;
  }

  // ---------- Fichier Excel : bouton ou glisser-déposer ----------
  choisirFichier(champ: HTMLInputElement): void {
    const f = champ.files?.[0];
    champ.value = ''; // le même fichier peut être relu
    if (f) this.lireFichier(f);
  }

  deposer(e: DragEvent): void {
    e.preventDefault();
    this.survol.set(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) this.lireFichier(f);
  }

  // Le serveur lit les colonnes Codice / Somma di quantità ; le n° de livraison est proposé d'après le nom du fichier
  private lireFichier(f: File): void {
    this.erreur.set('');
    this.lecture.set(true);
    this.service.lireFichierImportResume(f).subscribe({
      next: (r) => {
        this.lecture.set(false);
        this.nomFichier.set(f.name);
        if (!this.numero.trim()) {
          this.numero = f.name.replace(/\.[^.]+$/, '').split(' - ')[0].trim().replace(/\s+/g, '_').slice(0, 50);
          this.dateDepuisNumero();
        }
        this.filtre.set('tout');
        this.changerTexte(r.texte);
      },
      error: (e: HttpErrorResponse) => {
        this.lecture.set(false);
        this.erreur.set(e.status === 0 ? 'Serveur injoignable' : (e.error?.message ?? 'Fichier illisible'));
      },
    });
  }

  // Retire des lignes du texte (numéros de ligne de l'aperçu), puis l'aperçu se recalcule
  retirerLignes(liste: LigneApercu[]): void {
    const numeros = new Set(liste.map((l) => l.ligne));
    const restes = this.texte().split(/\r?\n/).filter((_, k) => !numeros.has(k + 1));
    if (this.filtre() === 'corriger' && liste.length === this.aCorriger().length) this.filtre.set('tout');
    this.changerTexte(restes.join('\n'));
  }

  // « PackingKLTN_291026 » : la date d'envoi est proposée d'après les 6 derniers chiffres (JJMMAA)
  dateDepuisNumero(): void {
    if (this.dateTouchee) return;
    const m = /(\d{2})(\d{2})(\d{2})$/.exec(this.numero.trim());
    const [j, mois] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
    this.dateEnvoi = m && j >= 1 && j <= 31 && mois >= 1 && mois <= 12 ? `20${m[3]}-${m[2]}-${m[1]}` : '';
  }

  // Le serveur lit les lignes (même lecture qu'à la création) : aperçu après une courte pause
  changerTexte(t: string): void {
    this.texte.set(t);
    this.erreur.set('');
    clearTimeout(this.attente);
    if (!t.trim()) {
      this.apercu.set(null);
      return;
    }
    this.verification.set(true);
    this.attente = setTimeout(() => {
      const n = ++this.demande;
      this.service.apercuImportResume(t).subscribe({
        next: (a) => {
          if (n !== this.demande) return;
          this.apercu.set(a);
          this.verification.set(false);
        },
        error: (e: HttpErrorResponse) => {
          if (n !== this.demande) return;
          this.verification.set(false);
          this.erreur.set(e.status === 0 ? 'Serveur injoignable' : (e.error?.message ?? 'Lecture impossible'));
        },
      });
    }, 300);
  }

  pret(): boolean {
    const a = this.apercu();
    return !!a && !this.verification() && !a.problemes.length && a.references.length > 0 && this.numero.trim().length >= 3;
  }

  libelleType(r: ApercuImportResume['references'][number]): string {
    if (!r.type) return 'Inconnue';
    if (r.type === 'cosse') return r.type_cosse === 'axiale' ? 'Cosse axiale' : 'Cosse plate';
    if (r.type === 'bobine') return `Bobine · ${r.taille_bobine ?? 'petite'}`;
    return 'Connecteur';
  }

  enregistrer(): void {
    this.erreur.set('');
    if (this.numero.trim().length < 3) return this.erreur.set('Indiquez le n° de livraison.');
    if (!this.pret()) return this.erreur.set('Corrigez les lignes signalées avant de créer l’import.');
    this.envoi.set(true);
    this.service.creerImportResume(this.numero, this.dateEnvoi, this.texte()).subscribe({
      next: (r) => {
        this.envoi.set(false);
        this.cree.emit(r);
      },
      error: (e: HttpErrorResponse) => {
        this.envoi.set(false);
        this.erreur.set(e.status === 0 ? 'Serveur injoignable' : (e.error?.message ?? 'Création impossible'));
      },
    });
  }
}

const majuscule = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
