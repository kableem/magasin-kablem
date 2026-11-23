import { nomEmplacement } from '../../services/plan';
import { EmplPipe } from '../../composants/empl.pipe';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { IonButton, IonContent, IonFooter, IonIcon, IonSpinner, IonToolbar, ViewWillEnter } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowDown, cloudOfflineOutline, scanOutline, chevronForward, chevronDown, chevronUp, play, lockClosedOutline, checkmarkDone,
  alertCircle, homeOutline, cubeOutline, flagOutline, removeCircle, addCircle, gridOutline, desktopOutline, closeOutline, downloadOutline,
  layersOutline, checkmarkCircle, refreshOutline, arrowForward, createOutline, printOutline,
} from 'ionicons/icons';
import { Lecture, ScannerComponent } from '../../composants/scanner.component';
import { EnteteComponent } from '../../composants/entete.component';
import { ControlesService, OperationEnAttente } from '../../services/controles.service';
import { RetourService } from '../../services/retour.service';
import { NavigationService } from '../../services/navigation.service';
import {
  CartonReception, PaletteCossesReception, Couleur, ETAPES_IMPORT, FinReception, ImportReception, LIBELLES_TYPE, PaletteReception, ReferenceAttendue, ResultatControle, TypePalette, codeEmplacement, nombre,
  referenceEtLot,
} from '../../services/modeles';

const TAILLES: Record<string, string> = { grande: 'grandes', moyenne: 'moyennes', petite: 'petites' };
// Produits reçus palette par palette (les connecteurs se reçoivent sans palette)
const SUR_PALETTE: TypePalette[] = ['bobine', 'cosse'];
// Bobines et cosses plates : palette par palette ; cosses axiales et connecteurs : un par un
const surPalette = (l: { type: string; type_cosse?: string | null }) => SUR_PALETTE.includes(l.type as TypePalette) && l.type_cosse !== 'axiale';
const majuscule = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// Ce que la caméra attend à l'étape en cours
interface ModeScan {
  attendu: 'ticket' | 'emplacement';
  consigne: string;
  cible: string | null;
  cibleTexte: string;
  compteur: string | null;
}

// Contrôle 1 : la réception physique d'un import, dans l'ordre d'arrivée.
// Les bobines et les cosses se reçoivent palette par palette, sans toucher l'écran : le scan du 1er colis
// ouvre la palette, la palette se termine seule quand elle est pleine (6 petites, 2 moyennes, 1 grande
// ou 10 cosses ; « Terminer la palette » pour une palette incomplète), et l'application donne un
// emplacement vide pour la palette entière (un seul scan d'emplacement), sinon un emplacement par colis
// sur les palettes commencées, sinon la zone tampon. Une palette ne mélange jamais bobines et cosses.
// Les cosses axiales (petites) et les connecteurs se scannent sans palette, un par un.
// Une seule caméra pour tout l'import, toujours en haut de l'écran.
@Component({
  selector: 'app-reception',
  standalone: true,
  imports: [EmplPipe, RouterLink, DatePipe, IonContent, IonButton, IonSpinner, IonIcon, IonFooter, IonToolbar, ScannerComponent, EnteteComponent],
  template: `
    <app-entete titre="Réception" module="Import" retour="/import" [etape]="!!choisi()" (precedent)="precedent()"></app-entete>
    <ion-content class="ion-padding">
      @if (!choisi()) {
        <!-- 1. Choisir l'import : ou scanner directement le 1er ticket, l'import à traiter s'ouvre seul -->
        <app-scanner [actif]="!chargement() && !envoi()" attendu="ticket" consigne="1er ticket : l’import s’ouvre seul" [resultat]="resultat()" (lecture)="lireDepuisListe($event)"></app-scanner>
        <h2 class="titre">Quel import réceptionnez-vous ?</h2>
        <p class="aide">Les imports se réceptionnent dans leur ordre d'arrivée : terminez le premier avant le suivant.</p>
        @if (chargement()) {
          <p class="k-envoi"><ion-spinner name="crescent"></ion-spinner></p>
        }
        @if (erreur()) {
          <p class="erreur"><ion-icon name="alert-circle"></ion-icon>{{ erreur() }}</p>
        }
        <ul class="imports">
          @for (i of imports(); track i.id) {
            <li>
              <button type="button" class="k-carte carte-import k-apparait" [class.prochain]="!i.bloque && i.reception !== 'terminee'" [class.bloque]="i.bloque" (click)="choisir(i)">
                <span class="haut">
                  <span class="code">{{ i.numero_livraison ?? 'Import n° ' + i.id }}</span>
                  @if (i.bloque) {
                    <span class="badge gris"><ion-icon name="lock-closed-outline"></ion-icon>Après {{ i.bloque_par?.numero_livraison ?? 'le précédent' }}</span>
                  } @else if (i.reception !== 'terminee') {
                    <span class="badge vert"><ion-icon name="play"></ion-icon>À traiter maintenant</span>
                  }
                </span>
                <small>Arrivé le {{ i.arrivee | date: 'dd/MM/yyyy' }} · {{ i.produits }} produit(s) · {{ etapes[i.etape] }}</small>
                <span class="barre"><i [style.width.%]="pourcent(i)"></i></span>
                <span class="bas">
                  @if (i.pieces) {
                    <span><b>{{ nombre(i.avancement.recus) }}</b>/{{ nombre(i.avancement.attendus) }} pièces</span>
                  } @else {
                    <span><b>{{ i.avancement.recus }}</b>/{{ i.avancement.attendus }} reçus</span>
                  }
                  <ion-icon name="chevron-forward"></ion-icon>
                </span>
              </button>
            </li>
          } @empty {
            @if (!chargement() && !erreur()) {
              <p class="vide">Aucun import en attente de réception.</p>
            }
          }
        </ul>
      } @else if (fin()) {
        <!-- 3. Réception terminée : le ticket suivant ouvre l'import suivant -->
        <app-scanner [actif]="!chargement() && !envoi()" attendu="ticket" consigne="Ticket de l’import suivant" (lecture)="lireApresFin($event)"></app-scanner>
        @if (fin(); as f) {
          <div class="fin k-apparait" [attr.data-etape]="f.etape">
            <span class="icone"><ion-icon [name]="f.etape === 'a_valider' ? 'alert-circle' : 'checkmark-done'"></ion-icon></span>
            <h2>
              @switch (f.etape) {
                @case ('ajoute') { Réception validée }
                @case ('receptionne') { Réception terminée }
                @default { À valider sur le web }
              }
            </h2>
            <p>
              @switch (f.etape) {
                @case ('ajoute') {
                  @if (separee()) {
                    Réception terminée{{ f.reclamations_creees ? ' : ' + f.reclamations_creees + ' réclamation(s) créée(s) automatiquement' : '' }}.
                    @if (choisi()?.cartons?.length) {
                      Imprimez l'étiquette de chaque carton sur le web (page Import), collez-la, puis Rangement : étiquette d'un carton de la palette, puis emplacement (toute la palette entre au stock).
                    } @else {
                      Passez maintenant au Rangement : scannez chaque produit, puis l'étiquette de son emplacement.
                    }
                    @if (f.hors_import_en_attente?.length) {
                      Pas encore au stock (référence absente du catalogue) : {{ f.hors_import_en_attente!.join(', ') }}.
                    }
                  } @else {
                    Les palettes sont rangées et au stock.{{ aDesAutres() ? ' Rangez les cosses axiales et les connecteurs avec Rangement.' : '' }}
                  }
                }
                @case ('receptionne') {
                  Tous les colis sont conformes. L'import sera validé dès que
                  {{ f.bloque_par?.numero_livraison ?? "l'import plus ancien" }} le sera.
                }
                @default { {{ f.reclamations_creees }} réclamation(s) créée(s) automatiquement. Le chef de magasin vérifie et valide l'import sur le web. }
              }
            </p>
            @if (separee() && f.etape === 'ajoute') {
              <ion-button expand="block" class="k-btn-principal" routerLink="/rangement">
                <ion-icon slot="start" name="grid-outline"></ion-icon> Ranger maintenant
              </ion-button>
            }
            @if (f.anomalies.length) {
              <ul class="ecarts">
                @for (a of f.anomalies; track $index) {
                  <li [attr.data-type]="a.type">
                    <b>{{ libellesAnomalie[a.type] }}</b>
                    @if (a.unite === 'pieces') {
                      <span class="mono">{{ a.reference }}</span> · {{ nombre(a.recues ?? 0) }} / {{ nombre(a.attendues ?? 0) }} pièces
                    } @else {
                      <span class="mono">{{ a.reference }}</span> lot {{ a.lot }} · × {{ a.quantite }}
                      @if (a.type === 'en_trop' || a.type === 'hors_import') {
                        <small>mettez-le de côté</small>
                      }
                    }
                  </li>
                }
              </ul>
            }
          </div>
        }
      } @else {
        <!-- 2. Recevoir l'import choisi : le scan en haut, toujours prêt ; le détail en dessous -->
        @if (choisi(); as i) {
          <app-scanner
            [actif]="!envoi() && !occupe()"
            [attendu]="mode().attendu"
            [consigne]="mode().consigne"
            [cible]="mode().cible"
            [cibleTexte]="mode().cibleTexte"
            [compteur]="mode().compteur"
            [resultat]="resultat()"
            (lecture)="lire($event)"
          ></app-scanner>

          @if (separee() && aDesPlates()) {
            <!-- Palette de cosses : des cartons neufs seulement (rangée entière en haut) ; les cosses séparées n'y vont jamais -->
            @if (modeCosses() === 'carton' && choisi()?.palette_ouverte; as pc) {
              <div class="bandeau-palette k-apparait">
                <span class="pastille-palette"><ion-icon name="grid-outline"></ion-icon></span>
                <span class="bandeau-texte">
                  <b>Palette {{ pc.numero }}</b>
                  <small>{{ pc.cosses ? pc.contenu : 'Vide : scannez les cartons posés dessus' }}</small>
                </span>
                <span class="compte-palette"><b>{{ pc.cosses }}</b></span>
              </div>
            } @else if (modeCosses() === 'carton') {
              <button type="button" class="ouvrir-palette" [disabled]="occupe()" (click)="ouvrirPaletteCosses()">
                <ion-icon name="grid-outline"></ion-icon>
                <span><b>Ouvrir une palette</b><small>ou scannez : la palette s’ouvre seule au 1er carton</small></span>
              </button>
            }
            <!-- Cosses plates : Cartons ou Séparées ; le mode choisi reste jusqu'au prochain changement -->
            @if (questionMode()) {
              <p class="question-mode">Ces cosses arrivent-elles <b>en cartons</b> ou <b>séparées</b> ? Choisissez : le scan continue.</p>
            }
            <div class="modes-cosses" role="radiogroup" aria-label="Cosses en cartons ou séparées" [class.a-choisir]="questionMode()">
              <button type="button" role="radio" [attr.aria-checked]="modeCosses() === 'carton'" [class.actif]="modeCosses() === 'carton'" [disabled]="occupe()" (click)="changerMode('carton')">
                <ion-icon name="cube-outline"></ion-icon> Cartons
              </button>
              <button type="button" role="radio" [attr.aria-checked]="modeCosses() === 'separe'" [class.actif]="modeCosses() === 'separe'" [disabled]="occupe()" (click)="changerMode('separe')">
                <ion-icon name="layers-outline"></ion-icon> Séparées
              </button>
            </div>
            @if (modeCosses() === 'carton') {
              <small class="aide-mode">{{ choisi()?.carton_ouvert ? 'Les cosses vont dans le carton ' + choisi()!.carton_ouvert!.numero + '.' : 'La prochaine cosse ouvre un nouveau carton' + (choisi()?.palette_ouverte ? ' sur la palette ' + choisi()!.palette_ouverte!.numero : '') + '.' }}</small>
            } @else {
              <small class="aide-mode">Cosses séparées : sans palette, chacune se range seule aux niveaux 1 et 2.</small>
            }
          }

          @if (separee() && aDesConnecteurs()) {
            <!-- Connecteurs : chaque carton (ticket vert) sur une palette ; ou compléter une palette du magasin -->
            @if (choisi()?.palette_descendue; as pd) {
              <div class="bandeau-palette descendue k-apparait">
                <span class="pastille-palette"><ion-icon name="arrow-down"></ion-icon></span>
                <span class="bandeau-texte">
                  <b>Palette de {{ pd.emplacement | empl }} descendue</b>
                  <small>{{ etapePalette() === 'remettre' ? 'Posez-la en ' + (pd.emplacement | empl) + ' et scannez cette étiquette.' : pd.contenu + ' · scannez les cartons à ajouter' }}</small>
                </span>
                <span class="compte-palette"><b>+{{ pd.a_ajouter ?? 0 }}</b></span>
              </div>
            } @else if (etapePalette() === 'place') {
              <div class="bandeau-palette descendue k-apparait">
                <span class="pastille-palette"><ion-icon name="scan-outline"></ion-icon></span>
                <span class="bandeau-texte">
                  <b>Compléter une palette du magasin</b>
                  <small>Scannez l'étiquette jaune de la place de la palette de connecteurs.</small>
                </span>
                <button type="button" class="lien" (click)="etapePalette.set(null)">Annuler</button>
              </div>
            } @else {
              @if (choisi()?.palette_ouverte?.famille === 'connecteur') {
                <div class="bandeau-palette k-apparait">
                  <span class="pastille-palette"><ion-icon name="grid-outline"></ion-icon></span>
                  <span class="bandeau-texte">
                    <b>Palette {{ choisi()!.palette_ouverte!.numero }} · connecteurs</b>
                    <small>{{ choisi()!.palette_ouverte!.contenu }}</small>
                  </span>
                  <span class="compte-palette"><b>{{ choisi()!.palette_ouverte!.nb_cartons }}</b></span>
                </div>
              }
              <button type="button" class="ouvrir-palette" [disabled]="occupe()" (click)="etapePalette.set('place')">
                <ion-icon name="arrow-down"></ion-icon>
                <span><b>Compléter une palette du magasin</b><small>Connecteurs : la palette s’ouvre seule au 1er carton ; ou descendez une palette pour la compléter</small></span>
              </button>
            }
          }

          <!-- Plus de correction à la réception (décision du 2026-11-23) : ni « Mettre dans le carton », ni « la sortir du carton » -->

          @if (choisi()?.carton_ouvert; as k) {
            <!-- Carton ouvert : ses cosses (une seule référence, un seul lot) -->
            <section class="palette k-carte carton-ouvert">
              <div class="palette-tete">
                <span class="pastille-palette"><ion-icon name="cube-outline"></ion-icon></span>
                <div>
                  <b>Carton {{ k.numero }}{{ k.palette_numero ? ' · palette ' + k.palette_numero : '' }}</b>
                  <small>{{ k.cosses ? k.reference + ' · lot ' + k.lot + (k.pieces !== null ? ' · ' + nombre(k.pieces) + ' pièces' : '') : 'Scannez le ticket vert de la 1re cosse du carton' }}</small>
                </div>
                <span class="compte-palette"><b>{{ k.cosses }}</b></span>
              </div>
              <ul class="bobines">
                @for (x of k.liste; track x.controle_id) {
                  <li>
                    <span><b class="mono">{{ x.reference }}</b>{{ x.colis ? ' · colis ' + x.colis : '' }}{{ x.pieces !== null ? ' · ' + nombre(x.pieces) : '' }}</span>
                  </li>
                }
              </ul>
            </section>
          }

          @if (enAttente()) {
            <div class="k-attente k-apparait">
              <ion-icon name="cloud-offline-outline"></ion-icon>
              <div>
                <h2>Pas de réseau · {{ controles.attente().length }} scan(s) gardé(s)</h2>
                <p>Continuez à scanner : chaque ticket est enregistré sur le téléphone et partira tout seul au retour du Wi-Fi. Le résultat apparaîtra dans « En attente ». Ne fermez pas l'application.</p>
              </div>
            </div>
          }

          @if (paletteCourante(); as p) {
            @if (p.statut === 'ouverte') {
              <!-- 2a. Palette ouverte : ses colis (bobines ou cosses) -->
              <section class="palette k-carte">
                <div class="palette-tete">
                  <span class="pastille-palette"><ion-icon name="layers-outline"></ion-icon></span>
                  <div>
                    <b>Palette {{ p.numero }}</b>
                    <small>{{ p.type ? contenu(p) + ' · se termine seule à ' + p.capacite : 'scannez le 1er colis : bobine ou cosse' }}</small>
                  </div>
                  <span class="compte-palette"><b>{{ p.n }}</b>{{ p.capacite ? '/' + p.capacite : '' }}</span>
                </div>
                @if (p.bobines.length) {
                  <ul class="bobines">
                    @for (b of p.bobines; track b.controle_id) {
                      <li>
                        <span><b class="mono">{{ b.reference }}</b> lot {{ b.lot }}{{ b.colis ? ' · colis ' + b.colis : '' }}</span>
                      </li>
                    }
                  </ul>
                }
              </section>
            } @else if (p.mode === 'entiere') {
              <!-- 2b. Palette entière : la poser dans son emplacement -->
              <section class="aller k-carte" [class.tampon]="p.tampon || estTampon(p.emplacement)">
                <small>Palette {{ p.numero }} · {{ compte(p) }} · posez-la en</small>
                <span class="k-etiquette grand">{{ p.emplacement | empl }}</span>
                <p>{{ estTampon(p.emplacement) ? 'Zone tampon : plus d’emplacement vide ' + niveaux(p) + '.' : 'Emplacement entièrement vide.' }} Scannez son étiquette.</p>
              </section>
            } @else {
              <!-- 2c. Palette divisée : chaque colis à son emplacement -->
              <section class="palette k-carte">
                <div class="palette-tete">
                  <span class="pastille-palette orange"><ion-icon name="grid-outline"></ion-icon></span>
                  <div>
                    <b>Palette {{ p.numero }} : pas d'emplacement vide</b>
                    <small>Pour chaque {{ nomColis(p, false) }} : son ticket, puis son emplacement</small>
                  </div>
                  <span class="compte-palette"><b>{{ p.n - p.a_ranger }}</b>/{{ p.n }}</span>
                </div>
                <ul class="bobines">
                  @for (b of p.bobines; track b.controle_id) {
                    <li [class.fait]="b.range" [class.choisie]="ticketDivise()?.ticket === b.ticket">
                      <span><b class="mono">{{ b.reference }}</b>{{ b.colis ? ' · colis ' + b.colis : '' }}</span>
                      <span class="cible">
                        @if (b.range) {
                          <ion-icon name="checkmark-circle"></ion-icon>
                        } @else {
                          <ion-icon name="arrow-forward"></ion-icon>
                        }
                        <span class="k-etiquette">{{ b.emplacement | empl }}</span>
                      </span>
                    </li>
                  }
                </ul>
              </section>
            }
          } @else if (toutRecu()) {
            <section class="sans-palette tout-recu k-carte">
              <ion-icon name="checkmark-done"></ion-icon>
              <p><b>Tout est reçu ({{ i.pieces ? nombre(i.avancement.recus) + '/' + nombre(i.avancement.attendus) + ' pièces' : i.avancement.recus + '/' + i.avancement.attendus }}).</b> Touchez « Terminer la réception » en bas.</p>
            </section>
          } @else if (separee()) {
            <section class="sans-palette k-carte">
              <ion-icon name="download-outline"></ion-icon>
              <p>
                @if (aDesPlates()) {
                  <b>Scannez le ticket de chaque produit reçu.</b> Cosses en <b>Cartons</b> : les tickets d'un carton, puis « Terminer le carton » (le suivant s'ouvre au scan suivant) ; les cartons vont sur la palette ouverte, « Terminer la palette » quand elle est pleine (la palette se range en haut).
                  En <b>Séparées</b> : scannez simplement, sans palette (elles se rangent aux niveaux 1 et 2). Les étiquettes des cartons s'imprimeront sur le web.
                } @else {
                  <b>Scannez le ticket de chaque produit reçu</b> : l'application contrôle le produit, le lot et les quantités.
                  Les produits ne sont pas encore rangés : le rangement se fera ensuite, avec <b>Rangement</b>, une fois la réception terminée.
                }
              </p>
            </section>
          } @else if (aDesPalettes()) {
            <section class="sans-palette k-carte">
              <ion-icon name="layers-outline"></ion-icon>
              <p>
                <b>Scannez le 1er colis d'une palette (bobine ou cosse) :</b> la palette s'ouvre toute seule, puis se termine seule quand elle est pleine.
                Palette incomplète : touchez « Terminer la palette ».{{ aDesAutres() ? ' Les cosses axiales et les connecteurs se scannent sans palette, un par un.' : '' }}
              </p>
            </section>
          }

          <section class="suivi k-carte">
            <div class="ligne-suivi">
              <div>
                <span class="code">{{ i.numero_livraison ?? 'Import n° ' + i.id }}</span>
                <small>{{ etapes[i.etape] }}</small>
              </div>
              @if (i.pieces) {
                <span class="compte"><b>{{ nombre(i.avancement.recus) }}</b>/{{ nombre(i.avancement.attendus) }}<small> pièces</small></span>
              } @else {
                <span class="compte"><b>{{ i.avancement.recus }}</b>/{{ i.avancement.attendus }}</span>
              }
            </div>
            <span class="barre"><i [style.width.%]="pourcent(i)"></i></span>
            @if (i.avancement.en_trop || i.avancement.hors_import) {
              <small class="alerte-suivi">{{ i.avancement.en_trop + i.avancement.hors_import }} colis en plus (en trop ou hors import){{ separee() ? ' : ils entrent au stock, une réclamation sera créée' : ' mis de côté' }}</small>
            }
            <button type="button" class="detail" (click)="detailOuvert.set(!detailOuvert())">
              {{ detailOuvert() ? 'Masquer le détail' : 'Voir le détail des produits et des palettes' }}
              <ion-icon [name]="detailOuvert() ? 'chevron-up' : 'chevron-down'"></ion-icon>
            </button>
            @if (detailOuvert()) {
              @if (i.palettes_cosses?.length) {
                <ul class="liste-palettes">
                  @for (p of i.palettes_cosses; track p.id) {
                    <li class="palette-cosses">
                      <span><b>Palette {{ p.numero }}</b> · {{ p.contenu }}<small>{{ etatPaletteCosses(p) }}</small></span>
                    </li>
                    @for (k of p.cartons; track k.id) {
                      @if (k.cosses) {
                        <li class="carton-de-palette">
                          <span><b>Carton {{ k.numero }}</b> · {{ k.cosses }} cosse{{ k.cosses > 1 ? 's' : '' }} {{ k.reference }}<small>{{ etatCarton(k) }}</small></span>
                        </li>
                      }
                    }
                  }
                </ul>
              }
              @if (i.pieces; as pc) {
                <p class="aide-pieces">Total de pièces annoncé par référence ; tout écart sera réclamé.</p>
                <ul class="lignes">
                  @for (r of pc.references; track r.reference) {
                    <li [class.complet]="r.statut === 'conforme' || r.statut === 'tolere'" [class.trop]="r.statut === 'en_trop'">
                      <span><b class="mono">{{ r.reference }}</b><small>{{ types[r.type] }}{{ r.type_cosse ? ' · ' + (r.type_cosse === 'axiale' ? 'axiale' : 'plate') : '' }} · {{ r.colis }} colis{{ r.lots.length ? ' · lot ' + lotsTexte(r) : '' }}</small></span>
                      <span class="qte"><b>{{ nombre(r.recues) }}</b>/{{ nombre(r.attendues) }}</span>
                    </li>
                  }
                </ul>
              } @else {
              <ul class="lignes">
                @for (l of i.lignes ?? []; track l.id) {
                  <li [class.complet]="l.recus >= l.attendue">
                    <span><b class="mono">{{ l.reference }}</b> lot {{ l.lot }}<small>{{ types[l.type] }}{{ l.taille_bobine ? ' · ' + l.taille_bobine : '' }}{{ l.type_cosse ? ' · ' + (l.type_cosse === 'axiale' ? 'axiale' : 'plate') : '' }}</small></span>
                    <span class="qte"><b>{{ l.recus }}</b>/{{ l.attendue }}</span>
                  </li>
                }
              </ul>
              }
              @if (palettes().length) {
                <ul class="liste-palettes">
                  @for (p of palettes(); track p.id) {
                    <li>
                      <span><b>Palette {{ p.numero }}</b> · {{ compte(p) }}<small>{{ etatPalette(p) }}</small></span>
                    </li>
                  }
                </ul>
              }
            }
          </section>
        }
      }
    </ion-content>

    @if (choisi()) {
      <ion-footer class="k-pied">
        <ion-toolbar>
          @if (fin()) {
            <div class="actions">
              <ion-button class="k-btn-clair" (click)="navigation.menu()"><ion-icon slot="start" name="home-outline"></ion-icon>Menu</ion-button>
              <ion-button expand="block" class="k-btn-principal suivant" (click)="retourListe()">Import suivant</ion-button>
            </div>
          } @else if (paletteCourante()?.statut === 'ouverte') {
            <div class="actions">
              @if (!paletteCourante()!.n) {
                <ion-button class="k-btn-clair" [disabled]="occupe()" (click)="annulerPalette()">Annuler la palette</ion-button>
              }
              <ion-button expand="block" class="k-btn-principal suivant" [disabled]="occupe() || !paletteCourante()!.n" (click)="terminerPalette()">
                <ion-icon slot="start" name="checkmark-done"></ion-icon> Terminer la palette
              </ion-button>
            </div>
          } @else if (paletteCourante()) {
            <p class="pied-info">{{ paletteCourante()!.mode === 'entiere' ? 'Scannez l’emplacement pour poser la palette.' : 'Rangez chaque ' + nomColis(paletteCourante(), false) + ' : ticket, puis emplacement.' }}</p>
          } @else {
            <div class="actions">
              @if (separee() && choisi()!.carton_ouvert) {
                @if (choisi()!.palette_ouverte; as pc) {
                  <ion-button class="k-btn-clair fin-btn" [disabled]="occupe()" (click)="terminerPaletteCosses()">
                    <ion-icon slot="start" name="grid-outline"></ion-icon> Fin palette {{ pc.numero }}
                  </ion-button>
                } @else {
                  <ion-button class="k-btn-clair fin-btn" [disabled]="termine()" (click)="confirmerFin()">
                    <ion-icon slot="start" name="flag-outline"></ion-icon> Terminer
                  </ion-button>
                }
                <ion-button expand="block" class="k-btn-principal suivant" [disabled]="occupe()" (click)="terminerCarton()">
                  <ion-icon slot="start" name="checkmark-done"></ion-icon> Terminer le carton {{ choisi()!.carton_ouvert!.numero }}
                </ion-button>
              } @else if (separee() && choisi()!.palette_descendue; as pd) {
                <ion-button expand="block" class="k-btn-principal suivant" [disabled]="occupe() || etapePalette() === 'remettre'" (click)="etapePalette.set('remettre')">
                  <ion-icon slot="start" name="checkmark-done"></ion-icon> Terminer : la remettre en {{ pd.emplacement | empl }}
                </ion-button>
              } @else if (separee() && choisi()!.palette_ouverte) {
                <ion-button class="k-btn-clair fin-btn" [disabled]="termine()" (click)="confirmerFin()">
                  <ion-icon slot="start" name="flag-outline"></ion-icon> Terminer
                </ion-button>
                <ion-button expand="block" class="k-btn-principal suivant" [disabled]="occupe()" (click)="terminerPaletteCosses()">
                  <ion-icon slot="start" name="grid-outline"></ion-icon> Terminer la palette {{ choisi()!.palette_ouverte!.numero }}
                </ion-button>
              } @else if (separee()) {
                <ion-button expand="block" class="suivant" [class.k-btn-principal]="toutRecu()" [class.k-btn-clair]="!toutRecu()" [disabled]="termine() || !choisi()!.avancement.recus" (click)="confirmerFin()">
                  <ion-icon slot="start" name="flag-outline"></ion-icon> Terminer la réception
                </ion-button>
              } @else if (toutRecu()) {
                <ion-button class="k-btn-clair" [disabled]="occupe()" (click)="nouvellePalette()" aria-label="Nouvelle palette">
                  <ion-icon slot="icon-only" name="layers-outline"></ion-icon>
                </ion-button>
                <ion-button expand="block" class="k-btn-principal suivant" [disabled]="termine()" (click)="confirmerFin()">
                  <ion-icon slot="start" name="flag-outline"></ion-icon> Terminer la réception
                </ion-button>
              } @else {
                <ion-button class="k-btn-clair fin-btn" [disabled]="termine() || !choisi()!.avancement.recus" (click)="confirmerFin()">
                  <ion-icon slot="start" name="flag-outline"></ion-icon> Terminer
                </ion-button>
                <ion-button expand="block" class="k-btn-rouge suivant" [disabled]="occupe()" (click)="nouvellePalette()">
                  <ion-icon slot="start" name="layers-outline"></ion-icon> Nouvelle palette
                </ion-button>
              }
            </div>
          }
        </ion-toolbar>
      </ion-footer>
    }

    <!-- Confirmation de fin de réception : feuille en bas de l'écran -->
    @if (confirmation() && choisi(); as i) {
      <div class="voile" (click)="confirmation.set(false)"></div>
      <section class="feuille" [attr.data-etat]="sansEcart(i) ? 'ok' : 'ecart'" role="dialog" aria-modal="true" aria-labelledby="titre-fin">
        <span class="poignee" aria-hidden="true"></span>
        <div class="tete">
          <span class="pastille-fin"><ion-icon [name]="sansEcart(i) ? 'checkmark-done' : 'alert-circle'"></ion-icon></span>
          <div>
            <h2 id="titre-fin">Terminer la réception ?</h2>
            <span class="num">{{ i.numero_livraison ?? 'Import n° ' + i.id }}</span>
          </div>
        </div>

        <div class="bilan">
          @if (i.pieces) {
            <div class="chiffre"><b>{{ nombre(i.avancement.recus) }}</b><span>/{{ nombre(i.avancement.attendus) }}</span></div>
          } @else {
            <div class="chiffre"><b>{{ i.avancement.recus }}</b><span>/{{ i.avancement.attendus }}</span></div>
          }
          <div class="jauge">
            <small>{{ i.pieces ? (sansEcart(i) ? 'Toutes les références sont dans l’écart accepté' : 'Pièces reçues') : sansEcart(i) ? 'Tous les colis sont reçus' : 'Colis reçus' }}</small>
            <span class="barre"><i [style.width.%]="pourcent(i)"></i></span>
          </div>
        </div>

        @if (!sansEcart(i)) {
          <ul class="puces">
            @for (r of horsTolerance(i); track r.reference) {
              <li [class.rouge]="r.ecart < 0" [class.orange]="r.ecart > 0"><ion-icon [name]="r.ecart < 0 ? 'remove-circle' : 'add-circle'"></ion-icon><span><b>{{ r.reference }} : {{ nombre(r.recues) }} / {{ nombre(r.attendues) }} pièces</b> · réclamation de {{ nombre(r.ecart < 0 ? -r.ecart : r.ecart) }} pièces {{ r.ecart < 0 ? 'manquantes' : 'en trop' }}</span></li>
            }
            @if (!i.pieces && manquants(i) > 0) {
              <li class="rouge"><ion-icon name="remove-circle"></ion-icon><span><b>{{ manquants(i) }} manquant(s)</b> · une réclamation sera créée</span></li>
            }
            @if (i.avancement.en_trop + i.avancement.hors_import > 0) {
              <li class="orange"><ion-icon name="add-circle"></ion-icon><span><b>{{ i.avancement.en_trop + i.avancement.hors_import }} colis en plus</b> · {{ separee() ? 'entrent au stock, réclamation créée' : 'à mettre de côté, hors stock' }}</span></li>
            }
          </ul>
        }

        <div class="ensuite">
          <small>Ensuite</small>
          @if (sansEcart(i)) {
            @if (separee()) {
              <p><ion-icon name="checkmark-done"></ion-icon><span>Les écarts deviennent des réclamations, tout ce qui est reçu entre au stock. Ensuite : {{ choisi()?.cartons?.length ? 'étiquettes des cartons sur le web, puis Rangement (étiquette d’un carton de chaque palette, puis emplacement)' : 'Rangement (produit, puis emplacement)' }}.</span></p>
            } @else {
              <p><ion-icon name="checkmark-done"></ion-icon><span>Les palettes sont déjà au stock.{{ aDesAutres() ? ' Rangez les cosses axiales et les connecteurs avec Rangement.' : '' }} L'import suivant pourra être reçu.</span></p>
            }
          } @else {
            <p><ion-icon name="desktop-outline"></ion-icon><span>Le chef vérifie les réclamations et valide l'import sur le web.</span></p>
          }
        </div>

        <ion-button expand="block" class="valider" [class.k-btn-principal]="sansEcart(i)" [class.k-btn-orange]="!sansEcart(i)" (click)="validerFin()">
          <ion-icon slot="start" name="flag-outline"></ion-icon>
          Terminer la réception
        </ion-button>
        <button type="button" class="continuer" (click)="confirmation.set(false)">Continuer à scanner</button>
      </section>
    }
  `,
  styles: `
    .titre { margin: 4px 0 2px; font-size: 21px; font-weight: 700; color: var(--k-nuit); }
    .aide { margin: 0 0 14px; color: var(--k-gris); font-size: 14.5px; }
    .erreur { display: flex; align-items: center; gap: 8px; padding: 12px 14px; font-weight: 600; color: var(--k-erreur); background: var(--k-erreur-clair); border-radius: 14px; }
    .imports { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .carte-import { display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 14px 16px; font: inherit; text-align: left; color: var(--k-texte); }
    .carte-import.prochain { border: 2px solid var(--k-vert); box-shadow: 0 0 0 4px rgba(19, 138, 75, 0.12), var(--k-ombre); }
    .carte-import.bloque { opacity: 0.6; }
    .haut, .bas { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .code { font-family: 'Consolas', 'Roboto Mono', monospace; font-size: 19px; font-weight: 800; color: var(--k-nuit); }
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; font-size: 12.5px; font-weight: 700; border-radius: 999px; }
    .badge.vert { color: #fff; background: var(--k-vert); }
    .badge.gris { color: var(--k-gris); background: var(--k-surface-2); }
    .carte-import small { color: var(--k-gris); font-size: 13px; }
    .barre { display: block; height: 8px; overflow: hidden; background: #e3e8f2; border-radius: 99px; }
    .barre i { display: block; height: 100%; background: linear-gradient(90deg, #1f6fd1, var(--k-vert)); border-radius: 99px; transition: width 0.4s ease-out; }
    .bas { font-size: 14px; color: var(--k-gris); }
    .bas b { color: var(--k-nuit); }
    .bas ion-icon { font-size: 20px; }
    .vide { color: var(--k-gris); text-align: center; margin-top: 24px; }

    .suivi { margin: 12px 0 8px; padding: 14px 16px; }
    .ligne-suivi { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .ligne-suivi small { display: block; color: var(--k-gris); font-size: 13px; }
    .compte { font-size: 15px; color: var(--k-gris); }
    .compte b { font-size: 26px; font-weight: 700; color: var(--k-nuit); }
    .alerte-suivi { display: block; margin-top: 6px; color: var(--k-orange); font-weight: 700; font-size: 13px; }
    .detail { display: flex; align-items: center; gap: 4px; margin-top: 8px; padding: 0; font: inherit; font-size: 14px; font-weight: 600; color: var(--k-marine); background: none; border: 0; }
    .lignes, .liste-palettes { list-style: none; margin: 8px 0 0; padding: 0; }
    .lignes li, .liste-palettes li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0; border-top: 1px solid var(--k-bord); font-size: 14px; }
    .lignes small, .liste-palettes small { display: block; color: var(--k-gris); font-size: 12px; }
    .lignes .qte { font-size: 15px; color: var(--k-gris); }
    .lignes .qte b { color: var(--k-nuit); font-size: 18px; }
    .lignes li.complet .qte b { color: var(--k-vert); }
    .lignes li.trop .qte b { color: var(--k-orange, #b86a00); }
    .aide-pieces { margin: 8px 0 0; font-size: 13px; color: var(--k-gris); }
    .lien { display: inline-flex; align-items: center; gap: 4px; padding: 6px 10px; font: inherit; font-size: 13px; font-weight: 700; color: var(--k-marine); background: var(--k-surface-2); border: 0; border-radius: 10px; }
    app-scanner { margin-bottom: 4px; }

    .palette { margin-top: 4px; padding: 14px 16px; }
    .palette-tete { display: flex; align-items: center; gap: 12px; }
    .palette-tete b { display: block; font-size: 17px; color: var(--k-nuit); }
    .palette-tete small { color: var(--k-gris); font-size: 13px; }
    .pastille-palette { display: grid; place-items: center; flex: none; width: 44px; height: 44px; border-radius: 14px; background: var(--k-vert-clair); color: var(--k-vert); font-size: 24px; }
    .pastille-palette.orange { background: var(--k-orange-clair); color: var(--k-orange); }
    .compte-palette { margin-left: auto; flex: none; white-space: nowrap; font-size: 15px; color: var(--k-gris); }
    .compte-palette b { display: inline; font-size: 28px; font-weight: 800; color: var(--k-nuit); }
    .bobines { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; }
    .bobines li { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 42px; padding: 6px 10px; font-size: 14px; background: var(--k-surface-2); border-radius: 12px; }
    .bobines li.fait { opacity: 0.6; }
    .bobines li.choisie { outline: 2px solid var(--k-rouge); }
    .retirer { display: grid; place-items: center; width: 36px; height: 36px; font-size: 20px; color: var(--k-gris); background: var(--k-surface); border: 1px solid var(--k-bord); border-radius: 50%; }
    .cible { display: inline-flex; align-items: center; gap: 6px; }
    .cible ion-icon { font-size: 18px; color: var(--k-gris); }
    li.fait .cible ion-icon { color: var(--k-vert); }
    .pleine { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; font-weight: 700; color: var(--k-vert); }
    .pleine ion-icon { font-size: 22px; }
    .aller { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 4px; padding: 14px; text-align: center; }
    .aller small { font-size: 13px; font-weight: 700; color: var(--k-gris); }
    .aller p { margin: 0; font-size: 14px; color: var(--k-gris); }
    .aller.tampon { border: 2px solid var(--k-orange); }
    .k-etiquette.grand { padding: 6px 20px; font-size: 38px; line-height: 1; border-left-width: 10px; border-radius: 10px; }
    .sans-palette { display: flex; align-items: flex-start; gap: 12px; margin-top: 4px; padding: 14px 16px; }
    .sans-palette ion-icon { flex: none; font-size: 28px; color: var(--k-marine); }
    .sans-palette p { margin: 0; font-size: 14.5px; line-height: 1.4; color: var(--k-texte); }
    .tout-recu { border: 2px solid var(--k-vert); background: var(--k-vert-clair); }
    .tout-recu ion-icon { color: var(--k-vert); }
    .pied-info { margin: 0; padding: 12px; text-align: center; font-weight: 700; color: var(--k-gris); }

    .fin { --c: var(--k-vert); --fond-c: var(--k-vert-clair); padding: 22px 18px; text-align: center; background: var(--k-surface); border: 2px solid var(--c); border-radius: 24px; box-shadow: var(--k-ombre-forte); }
    .fin[data-etape='a_valider'] { --c: var(--k-orange); --fond-c: var(--k-orange-clair); }
    .fin .icone { display: inline-grid; place-items: center; width: 72px; height: 72px; border-radius: 50%; background: var(--c); }
    .fin .icone ion-icon { font-size: 40px; color: #fff; }
    .fin h2 { margin: 12px 0 6px; font-size: 24px; font-weight: 700; color: var(--c); }
    .fin p { margin: 0; line-height: 1.45; color: var(--k-texte); }
    .ecarts { list-style: none; margin: 14px 0 0; padding: 0; text-align: left; display: grid; gap: 6px; }
    .ecarts li { padding: 8px 12px; font-size: 14px; background: var(--fond-c); border-radius: 12px; }
    .ecarts small { display: block; color: var(--k-gris); }
    .actions { display: flex; gap: 8px; }
    .suivant { flex: 1; }

    .voile { position: fixed; inset: 0; z-index: 1000; background: rgba(6, 22, 58, 0.55); backdrop-filter: blur(3px); animation: fondu 0.2s ease-out; }
    .feuille {
      --c: var(--k-vert); --c-clair: var(--k-vert-clair);
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 1001;
      padding: 10px 20px calc(18px + env(safe-area-inset-bottom));
      background: var(--k-surface); border-radius: 28px 28px 0 0; box-shadow: 0 -18px 40px -18px rgba(6, 22, 58, 0.55);
      animation: monte 0.28s cubic-bezier(0.2, 0.9, 0.3, 1);
    }
    .feuille[data-etat='ecart'] { --c: var(--k-orange); --c-clair: var(--k-orange-clair); }
    .poignee { display: block; width: 44px; height: 5px; margin: 0 auto 14px; background: var(--k-bord); border-radius: 99px; }
    .tete { display: flex; align-items: center; gap: 14px; }
    .pastille-fin { display: grid; place-items: center; flex: none; width: 56px; height: 56px; border-radius: 18px; background: var(--c-clair); }
    .pastille-fin ion-icon { font-size: 32px; color: var(--c); }
    .tete h2 { margin: 0; font-size: 22px; font-weight: 800; color: var(--k-nuit); }
    .num { font-family: 'Consolas', 'Roboto Mono', monospace; font-size: 15px; font-weight: 700; color: var(--k-gris); }
    .bilan { display: flex; align-items: center; gap: 16px; margin: 18px 0 0; padding: 14px 16px; background: var(--k-surface-2); border-radius: 18px; }
    .chiffre { flex: none; color: var(--k-gris); font-size: 18px; font-weight: 700; }
    .chiffre b { font-size: 40px; line-height: 1; color: var(--c); }
    .jauge { flex: 1; display: grid; gap: 8px; }
    .jauge small { font-size: 14px; font-weight: 700; color: var(--k-nuit); }
    .jauge .barre { height: 10px; }
    .jauge .barre i { background: var(--c); }
    .puces { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
    .puces li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; font-size: 14.5px; border-radius: 14px; }
    .puces li ion-icon { flex: none; font-size: 22px; }
    .puces li.rouge { color: var(--k-erreur); background: var(--k-erreur-clair); }
    .puces li.orange { color: #8a5a00; background: var(--k-orange-clair); }
    .ensuite { margin: 16px 0 18px; }
    .ensuite small { font-size: 12px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--k-gris); }
    .ensuite p { display: flex; align-items: flex-start; gap: 10px; margin: 6px 0 0; font-size: 15px; line-height: 1.4; color: var(--k-texte); }
    .ensuite p ion-icon { flex: none; margin-top: 1px; font-size: 22px; color: var(--k-marine); }
    .valider { --border-radius: 16px; min-height: 56px; margin: 0; font-size: 17px; font-weight: 800; }
    .k-btn-orange { --background: var(--k-orange); --background-activated: #b86600; --box-shadow: 0 16px 30px -18px rgba(217, 122, 0, 0.8); }
    .continuer { display: block; width: 100%; min-height: 50px; margin-top: 6px; font: inherit; font-size: 16px; font-weight: 700; color: var(--k-marine); background: none; border: 0; }
    .modes-cosses { display: flex; gap: 0; margin-top: 12px; padding: 4px; background: var(--k-surface-2); border-radius: 16px; }
    .modes-cosses.a-choisir { box-shadow: 0 0 0 3px var(--k-orange); }
    .modes-cosses button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; font: inherit; font-size: 16px; font-weight: 800; color: var(--k-gris); background: none; border: 0; border-radius: 12px; }
    .modes-cosses button ion-icon { font-size: 20px; }
    .modes-cosses button.actif:first-child { color: #fff; background: var(--k-orange); }
    .modes-cosses button.actif:last-child { color: #fff; background: var(--k-marine); }
    .question-mode { margin: 12px 0 0; padding: 10px 12px; font-size: 14.5px; color: #7a4600; background: var(--k-orange-clair); border-radius: 12px; }
    .aide-mode { display: block; margin: 6px 4px 0; color: var(--k-gris); font-size: 13px; }
    .carton-ouvert { border: 2px solid var(--k-orange); }
    .bandeau-palette { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 10px 12px; background: linear-gradient(135deg, #13296b, var(--k-nuit)); border-radius: 18px; color: #fff; box-shadow: var(--k-ombre); }
    .bandeau-palette .pastille-palette { background: rgba(255, 255, 255, 0.16); color: #fff; }
    .bandeau-texte { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .bandeau-texte b { font-size: 16px; }
    .bandeau-texte small { font-size: 12.5px; color: #cfd6ee; }
    .bandeau-palette .compte-palette b { color: #fff; }
    .bandeau-palette.descendue { background: linear-gradient(150deg, #f08a24, #b35600); }
    .bandeau-palette.descendue .lien { color: #fff; font-weight: 800; }
    .ouvrir-palette { display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 10px; padding: 10px 12px; font: inherit; text-align: left; color: var(--k-marine); background: var(--k-surface); border: 2px dashed var(--k-bord); border-radius: 18px; }
    .ouvrir-palette ion-icon { flex: none; font-size: 24px; }
    .ouvrir-palette span { display: flex; flex-direction: column; }
    .ouvrir-palette small { font-size: 12.5px; color: var(--k-gris); }
    .liste-palettes .carton-de-palette { padding-left: 16px; border-top-style: dashed; }
    @keyframes monte { from { transform: translateY(100%); } to { transform: none; } }
    @keyframes fondu { from { opacity: 0; } to { opacity: 1; } }
  `,
})
export class ReceptionPage implements ViewWillEnter {
  protected controles = inject(ControlesService);
  private retour = inject(RetourService);
  readonly navigation = inject(NavigationService);
  readonly etapes = ETAPES_IMPORT;
  readonly types = LIBELLES_TYPE;
  readonly TAILLES = TAILLES;
  readonly libellesAnomalie = {
    manquant: 'Manquant', en_trop: 'Colis en trop', hors_import: 'Hors import', pieces_manquantes: 'Pièces manquantes', pieces_en_trop: 'Pièces en trop',
  } as const;
  readonly nombre = nombre;

  readonly imports = signal<ImportReception[]>([]);
  readonly chargement = signal(false);
  readonly erreur = signal('');
  readonly choisi = signal<ImportReception | null>(null);
  readonly detailOuvert = signal(false);
  readonly fin = signal<FinReception | null>(null);
  readonly termine = signal(false);
  readonly confirmation = signal(false); // feuille « Terminer la réception ? » ouverte

  readonly resultat = signal<ResultatControle | null>(null);
  readonly enAttente = signal<OperationEnAttente | null>(null);
  readonly envoi = signal(false);
  readonly occupe = signal(false); // action sur une palette en cours
  readonly session = signal<Couleur[]>([]);
  // Palette divisée : ticket du colis scanné, en attente du scan de son emplacement
  readonly ticketDivise = signal<{ texte: string; manuel: boolean; ticket: string; emplacement: string } | null>(null);
  // Réponse de « Terminer la palette » (motif de l'emplacement choisi, zone tampon)
  private readonly derniereTerminee = signal<PaletteReception | null>(null);

  // Ticket faux (import par référence) : 1) QR du colis, 2) quantité réelle, 3) étiquette imprimée puis scannée


  // Réception séparée (par défaut) : contrôle seulement, sans palette ; le rangement vient après la validation
  readonly separee = computed(() => this.choisi()?.mode_reception !== 'palette');
  readonly palettes = computed(() => this.choisi()?.palettes ?? []);
  // Palette en cours : ouverte, ou terminée mais pas encore posée
  readonly paletteCourante = computed(() => {
    const liste = this.palettes();
    const p = liste.find((x) => x.statut === 'ouverte') ?? liste.find((x) => x.statut === 'terminee');
    if (!p) return null;
    const t = this.derniereTerminee();
    return t && t.id === p.id && t.statut === p.statut ? { ...p, tampon: t.tampon, motif: t.motif } : p;
  });
  // Produits attendus : lignes de l'import, et pour un import par référence les références annoncées
  // (leurs lignes par lot n'existent qu'après le scan du 1er colis)
  private readonly attendus = computed(() => [...(this.choisi()?.lignes ?? []), ...(this.choisi()?.pieces?.references ?? [])]);
  // Connecteurs : sans palette ; bobines et cosses : palette par palette
  readonly aDesAutres = computed(() => this.attendus().some((l) => !surPalette(l)));
  readonly aDesPalettes = computed(() => this.attendus().some((l) => surPalette(l)));
  // Cosses plates : mode « Cartons » ou « Séparées », gardé (par import) jusqu'au prochain changement
  readonly modeCosses = signal<'carton' | 'separe' | null>(null);
  // Connecteurs : 'place' = scanner l'étiquette de la palette à compléter ; 'remettre' = la remettre à sa place
  readonly etapePalette = signal<'place' | 'remettre' | null>(null);
  readonly aDesConnecteurs = computed(() => !!this.choisi()?.a_des_connecteurs || !!this.choisi()?.palette_descendue || this.attendus().some((l) => l.type === 'connecteur'));
  // 1re cosse plate sans mode choisi : le scan attend la réponse
  private readonly scanEnAttente = signal<Lecture | null>(null);
  readonly questionMode = computed(() => !!this.scanEnAttente());
  // Cosses plates attendues (elles peuvent arriver en cartons) ; un carton ouvert compte aussi
  readonly aDesPlates = computed(() => !!this.choisi()?.carton_ouvert || this.attendus().some((l) => l.type === 'cosse'));
  // Tous les colis attendus sont reçus et aucune palette n'attend : il ne reste qu'à terminer
  readonly toutRecu = computed(() => {
    const i = this.choisi();
    if (!i || this.paletteCourante()) return false;
    // import par référence : chaque référence a au moins son total, à l'écart accepté près
    if (i.pieces) return i.pieces.references.length > 0 && i.pieces.references.every((r) => ['conforme', 'tolere', 'en_trop'].includes(r.statut));
    return i.avancement.attendus > 0 && i.avancement.recus >= i.avancement.attendus;
  });

  readonly mode = computed<ModeScan>(() => {
    const i = this.choisi();
    const p = this.paletteCourante();
    const pd = i?.palette_descendue;
    if (this.etapePalette() === 'place' && !pd) {
      return { attendu: 'emplacement', cible: null, cibleTexte: '', compteur: null, consigne: 'Étiquette de la place de la palette à compléter' };
    }
    if (pd && this.etapePalette() === 'remettre') {
      return { attendu: 'emplacement', cible: pd.emplacement, cibleTexte: 'Remettez-la en', compteur: `+${pd.a_ajouter ?? 0}`, consigne: `Étiquette de ${nomEmplacement(pd.emplacement)}` };
    }
    if (pd) {
      return { attendu: 'ticket', cible: null, cibleTexte: '', compteur: `+${pd.a_ajouter ?? 0}`, consigne: `Carton à ajouter · palette de ${nomEmplacement(pd.emplacement)}` };
    }
    if (p?.statut === 'ouverte') {
      return {
        attendu: 'ticket', cible: null, cibleTexte: '', compteur: p.capacite ? `${p.n}/${p.capacite}` : String(p.n),
        consigne: p.pleine ? `Palette ${p.numero} pleine : terminez-la` : `${p.type ? majuscule(this.nomColis(p, false)) : 'Colis'} ${p.n + 1} · palette ${p.numero}`,
      };
    }
    if (p?.mode === 'entiere') {
      return { attendu: 'emplacement', cible: p.emplacement, cibleTexte: 'Posez la palette en', compteur: `P${p.numero}`, consigne: `Étiquette de ${nomEmplacement(p.emplacement)}` };
    }
    if (p) {
      const t = this.ticketDivise();
      const compteur = `${p.n - p.a_ranger}/${p.n}`;
      return t
        ? { attendu: 'emplacement', cible: t.emplacement, cibleTexte: `Posez la ${this.nomColis(p, false)} en`, compteur, consigne: `Étiquette de ${nomEmplacement(t.emplacement)}` }
        : { attendu: 'ticket', cible: null, cibleTexte: '', compteur, consigne: `Ticket de la ${this.nomColis(p, false)} à ranger` };
    }
    const k = i?.carton_ouvert;
    if (k) {
      const pal = i?.palette_ouverte;
      return { attendu: 'ticket', cible: null, cibleTexte: '', compteur: `${pal ? 'P' + pal.numero + ' · ' : ''}C${k.numero} · ${k.cosses}`, consigne: `Cosse ${k.cosses + 1} · carton ${k.numero}${pal ? ' · palette ' + pal.numero : ''}` };
    }
    const pal = this.separee() ? i?.palette_ouverte : null;
    if (pal) {
      return { attendu: 'ticket', cible: null, cibleTexte: '', compteur: `P${pal.numero} · ${pal.cosses}`, consigne: `Ticket vert · palette ${pal.numero}` };
    }
    return {
      attendu: 'ticket', cible: null, cibleTexte: '', compteur: i ? (i.pieces ? `${nombre(i.avancement.recus)}/${nombre(i.avancement.attendus)}` : `${i.avancement.recus}/${i.avancement.attendus}`) : null,
      consigne: this.toutRecu() ? 'Tout est reçu' : !this.separee() && this.aDesPalettes() ? '1er colis de la palette suivante' : 'Ticket vert du produit',
    };
  });

  constructor() {
    addIcons({
      arrowDown, cloudOfflineOutline, scanOutline, chevronForward, chevronDown, chevronUp, play, lockClosedOutline, checkmarkDone,
      alertCircle, homeOutline, cubeOutline, flagOutline, removeCircle, addCircle, gridOutline, desktopOutline, closeOutline, downloadOutline,
      layersOutline, checkmarkCircle, refreshOutline, arrowForward, createOutline, printOutline,
    });
  }

  ionViewWillEnter(): void {
    if (!this.choisi()) this.chargerListe();
  }

  pourcent(i: ImportReception): number {
    return i.avancement.attendus ? Math.min(100, Math.round((100 * i.avancement.recus) / i.avancement.attendus)) : 0;
  }

  estTampon(code: string | null): boolean {
    return !!code && /^T\d{2}$/i.test(code);
  }

  etatPalette(p: PaletteReception): string {
    if (p.statut === 'ouverte') return 'en cours';
    const un = this.nomColis(p, false);
    if (p.statut === 'rangee') return p.mode === 'entiere' ? `rangée en ${nomEmplacement(p.emplacement)}` : `rangée ${un} par ${un}`;
    return p.mode === 'entiere' ? `à poser en ${nomEmplacement(p.emplacement)}` : `à ranger (${this.compte({ ...p, n: p.a_ranger })})`;
  }

  // Ce que porte une palette : « bobines », « cosses » (« colis » tant que rien n'est scanné)
  nomColis(p: { type: TypePalette | null } | null, pluriel = true): string {
    const nom = p?.type ?? 'colis';
    return pluriel && nom !== 'colis' ? nom + 's' : nom;
  }

  // « 3 bobines », « 1 cosse »
  compte(p: { type: TypePalette | null; n: number }): string {
    return `${p.n} ${this.nomColis(p, p.n > 1)}`;
  }

  // « petites bobines », « cosses »
  contenu(p: PaletteReception): string {
    return p.type === 'bobine' && p.taille ? `${TAILLES[p.taille]} bobines` : this.nomColis(p);
  }

  // Niveaux de rangement de la palette (pour le message de la zone tampon)
  niveaux(p: PaletteReception): string {
    return p.type === 'cosse' ? 'aux niveaux 1 et 2' : 'au niveau 0';
  }

  async chargerListe(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      this.imports.set(await this.controles.receptions());
    } catch (e) {
      const err = e as HttpErrorResponse;
      this.erreur.set(err.status === 0 ? 'Pas de réseau : la liste des imports demande le Wi-Fi.' : (err.error?.message ?? 'Chargement impossible'));
    } finally {
      this.chargement.set(false);
    }
  }

  async choisir(i: ImportReception): Promise<void> {
    if (i.bloque) {
      this.erreur.set(`Terminez d'abord la réception de ${i.bloque_par?.numero_livraison ?? "l'import plus ancien"} : les imports se réceptionnent dans leur ordre d'arrivée.`);
      this.retour.signaler('rouge');
      return;
    }
    this.erreur.set('');
    this.choisi.set(i);
    this.modeCosses.set(lireMode(i.id));
    this.scanEnAttente.set(null);
    this.fin.set(null);
    this.termine.set(false);
    this.resultat.set(null);
    this.enAttente.set(null);
    this.ticketDivise.set(null);
    await this.rafraichir();
  }

  // « Retour » et retour du téléphone : d'abord la feuille ouverte ou le scan commencé, puis la liste des imports
  precedent(): void {
    if (this.confirmation()) this.confirmation.set(false);
    else if (this.ticketDivise()) this.ticketDivise.set(null);
    else this.retourListe();
  }

  // Ticket scanné depuis la liste : on ouvre l'import à traiter maintenant (ordre d'arrivée), puis on le reçoit
  async lireDepuisListe(l: Lecture): Promise<void> {
    if (this.envoi()) return;
    const i = this.imports().find((x) => !x.bloque && x.reception !== 'terminee');
    if (!i) {
      this.resultat.set({ ...erreurLocale(new HttpErrorResponse({ status: 409, error: { message: this.imports().length ? "Aucun import n'est ouvert à la réception : terminez d'abord le plus ancien." : 'Aucun import en attente de réception.' } })), titre: 'Aucun import à recevoir' });
      this.retour.signaler('rouge');
      return;
    }
    await this.choisir(i);
    if (this.choisi()) this.lire(l);
  }

  // Ticket scanné après la fin d'une réception : liste à jour, puis l'import suivant s'ouvre
  async lireApresFin(l: Lecture): Promise<void> {
    this.choisi.set(null);
    this.fin.set(null);
    this.resultat.set(null);
    await this.chargerListe();
    await this.lireDepuisListe(l);
  }

  retourListe(): void {
    this.choisi.set(null);
    this.fin.set(null);
    this.resultat.set(null);
    this.enAttente.set(null);
    this.ticketDivise.set(null);
    this.chargerListe();
  }

  private async rafraichir(): Promise<void> {
    const i = this.choisi();
    if (!i) return;
    try {
      this.choisi.set(await this.controles.receptionImport(i.id));
    } catch {
      // hors ligne : on garde le dernier état
    }
  }

  // Une action sur la palette : erreurs affichées comme un résultat rouge, puis état à jour
  private async agir(action: () => Promise<unknown>, titreErreur = 'Action impossible'): Promise<void> {
    if (this.occupe()) return;
    this.occupe.set(true);
    try {
      await action();
    } catch (e) {
      this.resultat.set({ ...erreurLocale(e as HttpErrorResponse), titre: titreErreur });
      this.retour.signaler('rouge');
    } finally {
      this.occupe.set(false);
      await this.rafraichir();
    }
  }

  nouvellePalette(): void {
    const i = this.choisi();
    if (!i) return;
    this.resultat.set(null);
    void this.agir(() => this.controles.ouvrirPalette(i.id), 'Palette non ouverte');
  }

  annulerPalette(): void {
    const p = this.paletteCourante();
    if (p) void this.agir(() => this.controles.annulerPalette(p.id));
  }


  terminerPalette(): void {
    const p = this.paletteCourante();
    if (!p) return;
    void this.agir(() => this.terminee(p.id), 'Palette non terminée');
  }

  // Palette terminée (bouton, ou toute seule quand elle est pleine) : l'application donne où la poser
  private async terminee(id: number): Promise<void> {
    const t = await this.controles.terminerPalette(id);
    this.derniereTerminee.set(t);
    const entiere = t.mode === 'entiere';
    this.resultat.set({
      ...erreurLocale(new HttpErrorResponse({ status: 200 })),
      resultat: 'palette_terminee', couleur: entiere && !t.tampon ? 'vert' : 'orange', titre: `Palette ${t.numero} terminée`,
      message: entiere
        ? `Posez-la en ${nomEmplacement(t.emplacement)}${t.tampon ? ` (zone tampon : plus d’emplacement vide ${this.niveaux(t)})` : ''}, puis scannez l'étiquette.`
        : `Pas d'emplacement vide : rangez ${t.n > 1 ? 'ses ' + this.compte(t) + ' une par une' : 'sa ' + this.nomColis(t, false)} (ticket, puis emplacement).`,
      emplacements_prevus: entiere && t.emplacement ? [{ code: t.emplacement, quantite: t.n }] : [],
    });
    this.retour.signaler(entiere && !t.tampon ? 'vert' : 'orange');
  }


  // Un seul point d'entrée pour la caméra : l'étape en cours décide de ce que veut dire le QR
  lire(l: Lecture): void {
    const pd = this.choisi()?.palette_descendue;
    if (this.etapePalette() === 'place' && !pd) return void this.completer(l);
    if (pd && this.etapePalette() === 'remettre') return void this.remettre(pd, l);
    const p = this.paletteCourante();
    if (p?.statut === 'ouverte') void this.scanner(l, p.id);
    else if (p?.mode === 'entiere') void this.poser(p, l);
    else if (p) {
      if (this.ticketDivise()) void this.rangerDivise(l);
      else this.lireTicketDivise(p, l);
    } else if (!this.separee() && this.estSurPalette(l.texte)) void this.scanner(l, 'nouvelle');
    else void this.scanner(l);
  }

  // Le ticket peut-il être une cosse ? (référence de cosse de l'import, ou référence inconnue : hors import)
  private peutEtreCosse(qr: string): boolean {
    const { reference } = referenceEtLot(qr);
    const ligne = this.attendus().find((x) => x.reference.toUpperCase() === reference);
    return !ligne || ligne.type === 'cosse';
  }

  // Résultat d'une action carton / palette : faite (vert) ou gardée sur le téléphone (orange, pas de réseau)
  private resultatAction(r: { garde: boolean; message?: string }, titreFait: string, titreGarde: string, messageGarde: string, couleur: 'vert' | 'orange' = 'vert'): void {
    const garde = r.garde;
    this.resultat.set({
      ...erreurLocale(new HttpErrorResponse({ status: 200 })), resultat: garde ? 'en_attente' : 'conforme', couleur: garde ? 'orange' : couleur,
      titre: garde ? titreGarde : titreFait, message: garde ? `${messageGarde} ${this.controles.attente().length} opération(s) en attente.` : (r.message ?? ''),
    });
    this.retour.signaler(garde ? 'orange' : couleur);
  }

  // Bande affichée quand le réseau est coupé : ticket gardé sur le téléphone (orange), ou déjà gardé (rouge)
  private resultatGarde(qr: string, deja: boolean): ResultatControle {
    const { reference, lot } = referenceEtLot(qr);
    const colis = qr.split(';').length === 5 ? Number(qr.split(';')[2]) : null;
    const quoi = `${reference}${lot ? ' lot ' + lot : ''}${colis ? ' · colis n° ' + colis : ''}`;
    const n = this.controles.attente().length;
    return {
      ...erreurLocale(new HttpErrorResponse({ status: 200 })),
      resultat: deja ? 'deja_traite' : 'en_attente', couleur: deja ? 'rouge' : 'orange',
      titre: deja ? 'Déjà scanné (gardé sur le téléphone)' : 'Scanné ✓ · gardé sur le téléphone',
      message: deja
        ? `${quoi} est déjà scanné et attend le Wi-Fi : ne le scannez pas deux fois. ${n} scan(s) en attente.`
        : `${quoi} : pas de réseau, le scan est enregistré sur le téléphone et partira tout seul au retour du Wi-Fi. ${n} scan(s) en attente.`,
    };
  }

  // Le ticket est-il celui d'une bobine ou d'une cosse de l'import ? (il se reçoit alors sur une palette)
  private estSurPalette(texte: string): boolean {
    const { reference } = referenceEtLot(texte);
    return this.attendus().some((x) => surPalette(x) && x.reference.toUpperCase() === reference);
  }

  // Scan d'une bobine ou d'une cosse sur une palette (ouverte toute seule si besoin), ou d'un connecteur (sans palette)
  async scanner(l: Lecture, palette?: number | 'nouvelle'): Promise<void> {
    const i = this.choisi();
    if (!i || this.envoi()) return;
    this.envoi.set(true);
    this.retour.lu();
    try {
      if (palette !== undefined) {
        const id = palette === 'nouvelle' ? (await this.controles.ouvrirPalette(i.id)).id : palette;
        const r = await this.controles.receptionPalette(l.texte, l.manuel, i.id, id);
        // palette pleine : elle se termine toute seule, l'emplacement s'affiche (un seul son, celui de la palette)
        if (r.couleur !== 'vert' || !r.palette?.pleine) this.afficher(r);
        else {
          this.enAttente.set(null);
          this.resultat.set(r);
          try {
            await this.terminee(id);
          } catch (e) {
            this.resultat.set({ ...erreurLocale(e as HttpErrorResponse), titre: 'Palette pleine, pas encore terminée' });
            this.retour.signaler('rouge');
          }
        }
      } else {
        // Cosse sans mode choisi : « Cartons ou Séparées ? » posée par le téléphone (marche aussi sans réseau)
        if (this.separee() && this.aDesPlates() && !this.modeCosses() && this.peutEtreCosse(l.texte)) {
          this.scanEnAttente.set(l);
          this.resultat.set(null);
          this.retour.signaler('orange');
          return;
        }
        // Ticket déjà gardé pendant la coupure : on le dit, sans le garder deux fois
        if (this.controles.dejaEnAttente(l.texte, i.id)) {
          this.resultat.set(this.resultatGarde(l.texte, true));
          this.retour.signaler('rouge');
          return;
        }
        const r = await this.controles.reception(l.texte, l.manuel, i.id, this.modeCosses() ?? undefined);
        if (r.etat === 'fait') this.afficher(r.resultat);
        else {
          // Pas de réseau : le ticket est bien scanné et gardé ; la bande orange le dit tout de suite
          this.enAttente.set(r.operation);
          this.resultat.set(this.resultatGarde(l.texte, false));
          this.retour.signaler('orange');
        }
      }
    } catch (e) {
      const err = e as HttpErrorResponse;
      if (err.error?.code === 'emballage_requis') {
        // 1re cosse plate sans mode : « Cartons ou Séparées ? », puis ce scan continue
        this.scanEnAttente.set(l);
        this.resultat.set(null);
        this.retour.signaler('orange');
      } else {
        this.resultat.set(erreurLocale(err));
        this.retour.signaler('rouge');
      }
    } finally {
      this.envoi.set(false);
      await this.rafraichir();
    }
  }

  private afficher(r: ResultatControle): void {
    this.enAttente.set(null);
    this.resultat.set(r);
    this.retour.signaler(r.couleur);
    this.session.update((s) => [...s, r.couleur]);
  }

  // Palette entière : scan de l'emplacement, tous les colis entrent au stock
  async poser(p: PaletteReception, l: Lecture): Promise<void> {
    if (this.envoi()) return;
    this.envoi.set(true);
    this.retour.lu();
    try {
      this.afficher(await this.controles.poserPalette(p.id, codeEmplacement(l.texte)));
    } catch (e) {
      this.resultat.set(erreurLocale(e as HttpErrorResponse));
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
      await this.rafraichir();
    }
  }

  // Palette divisée : 1) ticket du colis, 2) étiquette de son emplacement
  lireTicketDivise(p: PaletteReception, l: Lecture): void {
    this.retour.lu();
    const morceaux = l.texte.split(/[;|]/).map((x) => x.trim());
    const b = p.bobines.find((x) => !x.range && morceaux[0]?.toUpperCase() === x.reference.toUpperCase() && Number(morceaux[2]) === x.colis);
    if (!b) {
      this.resultat.set({ ...erreurLocale(new HttpErrorResponse({ status: 400, error: { message: "Ce colis n'est pas à ranger sur cette palette : scannez le ticket d'un colis de la liste." } })), titre: 'Colis inattendu' });
      this.retour.signaler('rouge');
      return;
    }
    this.resultat.set(null);
    this.ticketDivise.set({ texte: l.texte, manuel: l.manuel, ticket: b.ticket, emplacement: b.emplacement ?? '' });
  }

  async rangerDivise(l: Lecture): Promise<void> {
    const t = this.ticketDivise();
    if (!t || this.envoi()) return;
    this.envoi.set(true);
    this.retour.lu();
    try {
      const r = await this.controles.rangement(codeEmplacement(l.texte), t.texte, t.manuel || l.manuel);
      this.afficher(r);
      if (r.couleur === 'vert') this.ticketDivise.set(null);
    } catch (e) {
      this.resultat.set(erreurLocale(e as HttpErrorResponse));
      this.retour.signaler('rouge');
    } finally {
      this.envoi.set(false);
      await this.rafraichir();
    }
  }

  // Ouvre la feuille de confirmation (avec l'avancement à jour)
  async confirmerFin(): Promise<void> {
    await this.rafraichir();
    if (this.choisi()) this.confirmation.set(true);
  }

  validerFin(): void {
    this.confirmation.set(false);
    void this.terminer();
  }

  manquants(i: ImportReception): number {
    return Math.max(0, i.avancement.attendus - i.avancement.recus);
  }

  // ---------- Cartons de cosses ----------
  // Bouton Cartons / Séparées. En passant en Séparées, le carton ouvert est terminé (il pourra être rouvert).
  async changerMode(mode: 'carton' | 'separe'): Promise<void> {
    const i = this.choisi();
    if (!i) return;
    const ouvert = i.carton_ouvert;
    // sans réseau, des cosses gardées ont peut-être ouvert un carton : il sera terminé au retour du Wi-Fi
    const coupure = !navigator.onLine || this.controles.attente().length > 0;
    if (mode === 'separe' && (ouvert || (coupure && this.modeCosses() === 'carton'))) {
      let fait = false;
      await this.agir(async () => {
        const r = await this.controles.actionReception('/mobile/cartons/terminer-ouvert', i.id, 'Terminer le carton ouvert');
        fait = true;
        this.resultatAction(r, ouvert ? `Carton ${ouvert.numero} terminé` : 'Carton terminé', 'Mode Séparées · carton gardé',
          'Pas de réseau : le carton ouvert sera terminé au retour du Wi-Fi, avant les cosses séparées scannées ensuite.');
      }, 'Carton non terminé');
      if (!fait) return; // le carton n'a pas pu être terminé : on reste en Cartons
    }
    this.modeCosses.set(mode);
    ecrireMode(i.id, mode);
    const attente = this.scanEnAttente();
    this.scanEnAttente.set(null);
    if (attente) void this.scanner(attente); // le scan qui attendait la réponse continue
  }



  terminerCarton(): void {
    const i = this.choisi();
    const k = i?.carton_ouvert;
    if (!i || !k) return;
    void this.agir(async () => {
      const r = await this.controles.actionReception('/mobile/cartons/terminer-ouvert', i.id, 'Terminer le carton ouvert');
      this.resultatAction(r, `Carton ${k.numero} terminé`, 'Fin du carton gardée sur le téléphone',
        'Pas de réseau : le carton sera terminé au retour du Wi-Fi ; la prochaine cosse ouvrira le carton suivant.');
    }, 'Carton non terminé');
  }



  // ---------- Palettes de cosses ----------
  ouvrirPaletteCosses(): void {
    const i = this.choisi();
    if (!i) return;
    void this.agir(async () => {
      const r = await this.controles.ouvrirPaletteCosses(i.id);
      this.resultat.set({ ...erreurLocale(new HttpErrorResponse({ status: 200 })), resultat: 'conforme', couleur: 'vert', titre: 'Palette ouverte', message: r.message });
      this.retour.signaler('vert');
    }, 'Palette non ouverte');
  }

  // Termine la palette (et son carton ouvert) ; la suivante s'ouvre au prochain carton
  terminerPaletteCosses(): void {
    const i = this.choisi();
    const p = i?.palette_ouverte;
    if (!i || !p) return;
    void this.agir(async () => {
      const r = await this.controles.actionReception('/mobile/palettes-cosses/terminer-ouverte', i.id, 'Terminer la palette ouverte');
      this.resultatAction(r, `Palette ${p.numero} terminée`, 'Fin de palette gardée sur le téléphone',
        'Pas de réseau : la palette sera terminée au retour du Wi-Fi ; le prochain carton ouvrira la palette suivante.');
    }, 'Palette non terminée');
  }

  // Palette de connecteurs du magasin : scan de l'étiquette de sa place → elle est descendue pour être complétée
  private completer(l: Lecture): void {
    const i = this.choisi();
    if (!i) return;
    this.retour.lu();
    void this.agir(async () => {
      const r = await this.controles.completerPalette(i.id, codeEmplacement(l.texte));
      this.etapePalette.set(null);
      this.resultat.set({ ...erreurLocale(new HttpErrorResponse({ status: 200 })), resultat: 'conforme', couleur: 'vert', titre: 'Palette descendue', message: r.message });
      this.retour.signaler('vert');
    }, 'Palette non descendue');
  }

  // La palette complétée est remise à sa place : scan de la même étiquette
  private remettre(pd: PaletteCossesReception, l: Lecture): void {
    this.retour.lu();
    void this.agir(async () => {
      const r = await this.controles.remettrePalette(pd.id, codeEmplacement(l.texte));
      this.etapePalette.set(null);
      this.resultat.set({ ...erreurLocale(new HttpErrorResponse({ status: 200 })), resultat: 'bon_emplacement', couleur: 'vert', titre: 'Palette remise à sa place', message: r.message });
      this.retour.signaler('vert');
    }, 'Pas sa place');
  }


  etatPaletteCosses(p: PaletteCossesReception): string {
    if (p.statut === 'ouverte') return p.ouverte_par_moi ? 'en cours' : 'en cours (autre magasinier)';
    if (p.statut === 'rangee') return `rangée en ${nomEmplacement(p.emplacement)}`;
    return p.etiquettes_a_imprimer ? `${p.etiquettes_a_imprimer} étiquette(s) de carton à imprimer (web), puis à ranger` : 'à ranger (étiquette d’un carton, puis emplacement)';
  }

  etatCarton(k: CartonReception): string {
    if (k.statut === 'ouvert') return 'en cours';
    if (k.statut === 'range') return `rangé en ${nomEmplacement(k.emplacement)}`;
    return k.imprime ? 'étiquette imprimée : à ranger' : 'étiquette à imprimer (web)';
  }

  sansEcart(i: ImportReception): boolean {
    if (i.pieces) return !i.pieces.a_reclamer && !i.avancement.hors_import;
    return this.manquants(i) === 0 && !i.avancement.en_trop && !i.avancement.hors_import;
  }

  // Import par référence : références en écart (une réclamation en pièces sera créée)
  horsTolerance(i: ImportReception): ReferenceAttendue[] {
    return (i.pieces?.references ?? []).filter((r) => ['manquant', 'non_recue', 'en_trop'].includes(r.statut));
  }

  // « 202613167 ×8, 202613168 ×1 »
  lotsTexte(r: ReferenceAttendue): string {
    return r.lots.map((l) => `${l.lot} ×${l.colis}`).join(', ');
  }

  private async terminer(): Promise<void> {
    const i = this.choisi();
    if (!i) return;
    this.termine.set(true);
    try {
      const f = await this.controles.terminerReception(i.id);
      this.fin.set(f);
      this.retour.signaler(f.etape === 'a_valider' ? 'orange' : 'vert');
    } catch (e) {
      this.termine.set(false);
      this.resultat.set({ ...erreurLocale(e as HttpErrorResponse), titre: 'Réception non terminée' });
      this.retour.signaler('rouge');
    }
  }
}

// Refus de l'API (ex. 400) affiché comme un résultat rouge
// Mode des cosses plates (Cartons / Séparées), gardé sur le téléphone pour chaque import
const CLE_MODE = (importId: number) => `kablem_mode_cosses_${importId}`;
function lireMode(importId: number): 'carton' | 'separe' | null {
  try {
    const m = localStorage.getItem(CLE_MODE(importId));
    return m === 'carton' || m === 'separe' ? m : null;
  } catch {
    return null;
  }
}
function ecrireMode(importId: number, mode: 'carton' | 'separe'): void {
  try {
    localStorage.setItem(CLE_MODE(importId), mode);
  } catch {
    // stockage indisponible : le mode reste pour cette session
  }
}

export function erreurLocale(err: HttpErrorResponse): ResultatControle {
  return {
    uuid: '', controle: 'reception', resultat: 'erreur', couleur: 'rouge', titre: 'Contrôle impossible',
    message: err.status === 0 ? 'Pas de réseau : réessayez.' : (err.error?.message ?? `Erreur ${err.status}`),
    produit: null, quantite_ticket: null, quantite_attendue: null,
    ecart: null, emplacements_prevus: [], emplacement_scanne: null, saisie_manuelle: false, date: new Date().toISOString(),
  };
}
