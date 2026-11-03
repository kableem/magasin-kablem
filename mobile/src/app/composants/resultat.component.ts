import { Component, computed, effect, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { checkmark, alert, close, keypadOutline, timeOutline, arrowForward } from 'ionicons/icons';
import { LIBELLES_TYPE, ResultatControle } from '../services/modeles';
import { EmplPipe } from './empl.pipe';

// Résultat d'un contrôle : bandeau de couleur, emplacement en étiquette jaune (comme au rayonnage),
// flash plein écran à l'arrivée pour être vu de loin. compact = liste (pas de flash).
@Component({
  selector: 'app-resultat',
  standalone: true,
  imports: [EmplPipe, IonIcon, DatePipe],
  template: `
    @if (r(); as r) {
      @if (flash() && !compact()) {
        <div class="flash" [attr.data-couleur]="r.couleur"></div>
      }
      <article class="resultat" [class.compact]="compact()" [attr.data-couleur]="r.couleur">
        <header class="bandeau">
          <span class="icone"><ion-icon [name]="icone()"></ion-icon></span>
          <div>
            <h2>{{ r.titre }}</h2>
            @if (r.produit) {
              <p class="produit">
                <b class="mono">{{ r.produit.reference }}</b>
                <span>lot {{ r.produit.lot }}</span>
              </p>
            }
          </div>
        </header>

        <div class="corps">
          @if (emplacements().length) {
            <div class="emplacement">
              <small>{{ etiquette() }}</small>
              @if (emplacements().length === 1) {
                <span class="k-etiquette geante" [class.vide]="!emplacements()[0].code">{{ (emplacements()[0].code | empl) || 'À définir' }}</span>
              } @else {
                <div class="plusieurs">
                  @for (e of emplacements(); track $index) {
                    <span class="k-etiquette moyenne" [class.vide]="!e.code">{{ (e.code | empl) || 'À définir' }} <em>×{{ e.quantite }}</em></span>
                  }
                </div>
              }
            </div>
          }

          @if (r.resultat === 'faux_emplacement' && r.emplacement_scanne) {
            <p class="scanne">
              Vous êtes en <span class="k-etiquette barre">{{ r.emplacement_scanne | empl }}</span>
            </p>
          }

          @if (r.ecart !== null && r.resultat === 'ecart_quantite') {
            <div class="quantites">
              <div><small>Ticket</small><b>{{ r.quantite_ticket }}</b></div>
              <div><small>Import</small><b>{{ r.quantite_attendue }}</b></div>
              <div class="ecart"><small>Écart</small><b>{{ r.ecart > 0 ? '+' : '' }}{{ r.ecart }}</b></div>
            </div>
          }

          @if (r.colis; as c) {
            <div class="colis">
              <span class="num">Colis <b>n° {{ c.numero }}</b></span>
              <span class="barre-colis"><i [style.width.%]="c.attendus ? (100 * (c.recus > c.attendus ? c.attendus : c.recus)) / c.attendus : 0"></i></span>
              <span class="compte"><b>{{ c.recus }}</b>/{{ c.attendus }} reçus</span>
            </div>
          }
          @if (r.produit?.type) {
            <span class="k-pastille" [class]="'k-pastille ' + r.produit!.type">{{ libelleType() }}</span>
          }
          <p class="message">{{ r.message }}</p>
          <p class="pied">
            <span><ion-icon name="time-outline"></ion-icon>{{ r.date | date: 'HH:mm:ss' }}</span>
            @if (r.saisie_manuelle) {
              <span class="manuel"><ion-icon name="keypad-outline"></ion-icon>saisie manuelle</span>
            }
            @if (r.rejoue) {
              <span>déjà reçu par le serveur</span>
            }
          </p>
        </div>
      </article>
    }
  `,
  styles: `
    :host { display: block; }
    .flash { position: fixed; inset: 0; z-index: 9999; pointer-events: none; animation: flash 0.7s ease-out forwards; }
    .flash[data-couleur='vert'] { background: var(--k-vert); }
    .flash[data-couleur='orange'] { background: var(--k-orange); }
    .flash[data-couleur='rouge'] { background: var(--k-erreur); }
    @keyframes flash { 0% { opacity: 0.55; } 100% { opacity: 0; } }

    .resultat { --c: var(--k-vert); --fond-c: var(--k-vert-clair); overflow: hidden; background: var(--k-surface); border-radius: 24px; box-shadow: var(--k-ombre-forte); animation: entre 0.32s cubic-bezier(0.2, 0.9, 0.25, 1.15) both; }
    .resultat[data-couleur='orange'] { --c: var(--k-orange); --fond-c: var(--k-orange-clair); }
    .resultat[data-couleur='rouge'] { --c: var(--k-erreur); --fond-c: var(--k-erreur-clair); }
    @keyframes entre { from { opacity: 0; transform: translateY(14px) scale(0.97); } }

    .bandeau { display: flex; align-items: center; gap: 14px; padding: 18px 18px 16px; color: #fff; background: var(--c); background-image: linear-gradient(135deg, rgba(255, 255, 255, 0.16), transparent 60%); }
    .icone { display: grid; place-items: center; width: 56px; height: 56px; flex: none; border-radius: 50%; background: #fff; box-shadow: 0 6px 16px -6px rgba(0, 0, 0, 0.35); animation: pop 0.45s 0.08s cubic-bezier(0.2, 0.9, 0.3, 1.5) both; }
    .icone ion-icon { font-size: 34px; color: var(--c); --ionicon-stroke-width: 64px; }
    @keyframes pop { from { transform: scale(0.3); opacity: 0; } }
    h2 { margin: 0; font-size: 24px; font-weight: 900; line-height: 1.1; }
    .produit { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 4px 0 0; font-size: 15px; opacity: 0.95; }
    .produit b { font-size: 19px; }

    .corps { padding: 16px 18px 14px; }
    .emplacement { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 2px 0 14px; padding: 16px 10px; background: var(--k-surface-2); border-radius: 18px; }
    .emplacement small { font-size: 12.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--k-gris); }
    .geante { font-size: 58px; line-height: 1.05; padding: 4px 22px 4px 18px; border-left-width: 10px; }
    .plusieurs { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
    .moyenne { font-size: 28px; }
    .moyenne em { font-style: normal; font-size: 17px; opacity: 0.7; margin-left: 4px; }
    .scanne { display: flex; align-items: center; justify-content: center; gap: 8px; margin: -4px 0 14px; font-size: 15px; color: var(--k-gris); }
    .barre { font-size: 18px; text-decoration: line-through; text-decoration-thickness: 3px; text-decoration-color: var(--k-erreur); background: #eee; }
    .quantites { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 14px; }
    .quantites div { display: flex; flex-direction: column; align-items: center; padding: 10px 6px; background: var(--k-surface-2); border-radius: 14px; }
    .quantites small { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--k-gris); }
    .quantites b { font-size: 28px; font-weight: 900; color: var(--k-nuit); }
    .quantites .ecart { background: var(--fond-c); }
    .quantites .ecart b { color: var(--c); }
    .colis { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; margin-bottom: 12px; padding: 10px 12px; background: var(--k-surface-2); border-radius: 14px; font-size: 14px; color: var(--k-gris); }
    .colis b { color: var(--k-nuit); }
    .barre-colis { height: 8px; overflow: hidden; background: #dfe4ee; border-radius: 99px; }
    .barre-colis i { display: block; height: 100%; background: var(--c); border-radius: 99px; transition: width 0.4s ease-out; }
    .message { margin: 10px 0 0; font-size: 16.5px; line-height: 1.45; color: var(--k-texte); }
    .pied { display: flex; flex-wrap: wrap; gap: 14px; margin: 12px 0 0; padding-top: 10px; font-size: 13px; color: var(--k-gris); border-top: 1px solid var(--k-bord); }
    .pied span { display: inline-flex; align-items: center; gap: 4px; }
    .pied .manuel { color: var(--k-orange); font-weight: 700; }

    .compact { box-shadow: var(--k-ombre); animation: none; }
    .compact .bandeau { padding: 12px 14px; }
    .compact .icone { width: 40px; height: 40px; animation: none; }
    .compact .icone ion-icon { font-size: 24px; }
    .compact h2 { font-size: 18px; }
    .compact .geante { font-size: 34px; }
    .compact .emplacement { padding: 10px; margin-bottom: 8px; }
    .compact .message { font-size: 14.5px; }
  `,
})
export class ResultatComponent {
  readonly r = input<ResultatControle | null>(null);
  readonly compact = input(false);
  readonly flash = signal(false);

  constructor() {
    addIcons({ checkmark, alert, close, keypadOutline, timeOutline, arrowForward });
    // Flash plein écran à chaque nouveau résultat
    effect(() => {
      if (!this.r() || this.compact()) return;
      this.flash.set(true);
      setTimeout(() => this.flash.set(false), 700);
    });
  }

  readonly icone = computed(() => ({ vert: 'checkmark', orange: 'alert', rouge: 'close' })[this.r()?.couleur ?? 'vert']);
  readonly libelleType = computed(() => {
    const p = this.r()?.produit;
    return p?.type ? LIBELLES_TYPE[p.type] + (p.taille_bobine ? ' · ' + p.taille_bobine : '') : '';
  });

  // Titre au-dessus de l'emplacement affiché en grand
  readonly etiquette = computed(() => {
    const r = this.r();
    if (r?.resultat === 'bon_emplacement') return 'Rangé en';
    if (r?.resultat === 'deplace') return 'Posé en';
    if (r?.controle !== 'export') return 'Emplacement prévu';
    return r.resultat === 'prelevement_ok' ? 'Prélèvement suivant' : 'À prendre en';
  });

  // Emplacement(s) affiché(s) : prévu (réception, erreur) ou confirmé (bon emplacement)
  readonly emplacements = computed(() => {
    const r = this.r();
    if (!r) return [];
    if (r.resultat === 'bon_emplacement' || r.resultat === 'deplace') return [{ code: r.emplacement_scanne, quantite: 0 }];
    const avecPrevu = ['conforme', 'ecart_quantite', 'faux_emplacement', 'import_en_attente', 'prelevement_ok', 'mauvais_produit'];
    return avecPrevu.includes(r.resultat) ? r.emplacements_prevus : [];
  });
}
