import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { api } from './config';
import { ContenuEmplacement, ControleResume, FinReception, ImportReception, LigneProduit, ResultatControle, TypeControle, PaletteReception, EmplacementInventaire, InventaireValide, ProduitARanger, EmplacementARanger, MesDeplacements } from './modeles';

// Opération gardée sur le téléphone quand le réseau est coupé
export interface OperationEnAttente {
  uuid: string;
  controle: TypeControle;
  corps: { uuid: string; qr: string; emplacement?: string; import_id?: number; palette_id?: number; saisie_manuelle: boolean };
  date: string;
  derniereErreur?: string;
}

export type Envoi = { etat: 'fait'; resultat: ResultatControle } | { etat: 'en_attente'; operation: OperationEnAttente };

const CLE_ATTENTE = 'kablem_mobile_attente';
const CLE_RECENTS = 'kablem_mobile_recents';

// Identifiant unique de l'opération, créé par le téléphone : renvoyé tel quel après une coupure,
// l'API reconnaît l'opération et ne la compte pas deux fois
export function nouvelUuid(): string {
  // randomUUID n'existe qu'en HTTPS : sinon on le fabrique
  const c: Crypto & { randomUUID?: () => string } = crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const h = [...c.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0'));
  h[6] = '4' + h[6][1];
  h[8] = ((parseInt(h[8], 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

// Serveur injoignable : pas de réseau (0), ou passerelle / relais sans réponse de l'API
// (502, 503, 504, ou 500 sans message de l'API, renvoyé par le relais quand l'API est arrêtée)
const injoignable = (e: HttpErrorResponse) =>
  e.status === 0 || [502, 503, 504].includes(e.status) || (e.status >= 500 && !e.error?.message);

const lire = <T>(cle: string, defaut: T): T => {
  try {
    return JSON.parse(localStorage.getItem(cle) ?? '') as T;
  } catch {
    return defaut;
  }
};

@Injectable({ providedIn: 'root' })
export class ControlesService {
  private http = inject(HttpClient);
  readonly attente = signal<OperationEnAttente[]>(lire(CLE_ATTENTE, []));
  readonly recents = signal<ResultatControle[]>(lire(CLE_RECENTS, []));
  readonly nbAttente = computed(() => this.attente().length);
  readonly envoiEnCours = signal(false);

  constructor() {
    // Le réseau revient : on envoie les opérations en attente
    window.addEventListener('online', () => this.envoyerAttente());
    setInterval(() => this.attente().length && navigator.onLine && this.envoyerAttente(), 30000);
    // à l'ouverture de l'application aussi
    setTimeout(() => this.attente().length && navigator.onLine && this.envoyerAttente(), 2000);
  }

  // Contrôle 1 : ticket scanné à la réception
  // importId : import en cours de réception (les colis sont rapprochés de cet import)
  reception(qr: string, saisieManuelle: boolean, importId?: number): Promise<Envoi> {
    const uuid = nouvelUuid();
    return this.envoyer({
      uuid, controle: 'reception', corps: { uuid, qr, import_id: importId, saisie_manuelle: saisieManuelle }, date: new Date().toISOString(),
    });
  }

  // ---------- Réception des bobines palette par palette (toujours en ligne) ----------
  // Bobine scannée sur la palette ouverte : contrôlée tout de suite (taille, palette pleine…)
  async receptionPalette(qr: string, saisieManuelle: boolean, importId: number, paletteId: number): Promise<ResultatControle> {
    const uuid = nouvelUuid();
    const r = await this.poster({
      uuid, controle: 'reception', corps: { uuid, qr, import_id: importId, palette_id: paletteId, saisie_manuelle: saisieManuelle }, date: new Date().toISOString(),
    });
    this.memoriser(r);
    return r;
  }

  ouvrirPalette(importId: number): Promise<PaletteReception> {
    return firstValueFrom(this.http.post<PaletteReception>(api('/mobile/palettes'), { import_id: importId }));
  }

  annulerPalette(id: number): Promise<unknown> {
    return firstValueFrom(this.http.delete(api(`/mobile/palettes/${id}`)));
  }

  retirerBobine(paletteId: number, controleId: number): Promise<PaletteReception> {
    return firstValueFrom(this.http.delete<PaletteReception>(api(`/mobile/palettes/${paletteId}/bobines/${controleId}`)));
  }

  // L'application choisit où va la palette (emplacement vide, sinon bobine par bobine, sinon zone tampon)
  terminerPalette(id: number): Promise<PaletteReception> {
    return firstValueFrom(this.http.post<PaletteReception>(api(`/mobile/palettes/${id}/terminer`), {}));
  }

  // Palette entière posée : un scan d'emplacement pour toute la palette
  async poserPalette(id: number, emplacement: string): Promise<ResultatControle> {
    const uuid = nouvelUuid();
    const r = await firstValueFrom(this.http.post<ResultatControle>(api(`/mobile/palettes/${id}/ranger`), { uuid, emplacement }));
    this.memoriser(r);
    return r;
  }

  rouvrirPalette(id: number): Promise<PaletteReception> {
    return firstValueFrom(this.http.post<PaletteReception>(api(`/mobile/palettes/${id}/rouvrir`), {}));
  }

  // ---------- Inventaire initial (chef de magasin, administrateur ; en ligne) ----------
  inventaireEmplacement(code: string): Promise<EmplacementInventaire> {
    return firstValueFrom(this.http.get<EmplacementInventaire>(api(`/mobile/inventaire/emplacements/${encodeURIComponent(code)}`)));
  }

  validerInventaire(code: string, qrs: string[]): Promise<InventaireValide> {
    return firstValueFrom(this.http.post<InventaireValide>(api(`/mobile/inventaire/emplacements/${encodeURIComponent(code)}`), { qrs }));
  }

  // ---------- Ranger le magasin (toujours en ligne) : le magasinier choisit, l'API contrôle et historise ----------
  produitARanger(qr: string): Promise<ProduitARanger> {
    return firstValueFrom(this.http.get<ProduitARanger>(api('/mobile/ranger/produit'), { params: { qr } }));
  }

  emplacementARanger(code: string): Promise<EmplacementARanger> {
    return firstValueFrom(this.http.get<EmplacementARanger>(api(`/mobile/ranger/emplacement/${encodeURIComponent(code)}`)));
  }

  // Un produit (un colis) : ticket, emplacement de départ, emplacement d'arrivée
  deplacer(qr: string, depuis: string, vers: string, manuel: boolean): Promise<ResultatControle> {
    return firstValueFrom(this.http.post<ResultatControle>(api('/mobile/ranger/deplacer'), { uuid: nouvelUuid(), qr, depuis, vers, saisie_manuelle: manuel }));
  }

  // Toute la palette d'un emplacement, sur un emplacement vide
  deplacerPalette(depuis: string, vers: string, manuel: boolean): Promise<ResultatControle> {
    return firstValueFrom(this.http.post<ResultatControle>(api('/mobile/ranger/palette'), { uuid: nouvelUuid(), depuis, vers, saisie_manuelle: manuel }));
  }

  mesDeplacements(): Promise<MesDeplacements> {
    return firstValueFrom(this.http.get<MesDeplacements>(api('/mobile/ranger/mes-deplacements')));
  }

  // ---------- Réception d'un import (lien avec le web) ----------
  receptions(): Promise<ImportReception[]> {
    return firstValueFrom(this.http.get<ImportReception[]>(api('/mobile/receptions')));
  }

  receptionImport(id: number): Promise<ImportReception> {
    return firstValueFrom(this.http.get<ImportReception>(api(`/mobile/receptions/${id}`)));
  }

  terminerReception(id: number): Promise<FinReception> {
    return firstValueFrom(this.http.post<FinReception>(api(`/mobile/receptions/${id}/terminer`), {}));
  }

  // Rangement, 1re étape : ticket scanné → emplacement où aller (rien n'est enregistré)
  suggestionRangement(qr: string): Promise<ResultatControle> {
    return firstValueFrom(this.http.post<ResultatControle>(api('/mobile/rangement/suggestion'), { qr }));
  }

  // Contrôle 2 : ticket du produit puis emplacement scanné.
  // Jamais gardé hors ligne : l'emplacement imposé du colis est vérifié tout de suite par le serveur.
  async rangement(emplacement: string, qr: string, saisieManuelle: boolean): Promise<ResultatControle> {
    const uuid = nouvelUuid();
    const resultat = await this.poster({
      uuid, controle: 'rangement', corps: { uuid, emplacement, qr, saisie_manuelle: saisieManuelle }, date: new Date().toISOString(),
    });
    this.memoriser(resultat);
    return resultat;
  }

  // Les 30 derniers contrôles de l'utilisateur (tous appareils confondus)
  mesControles(): Promise<ControleResume[]> {
    return firstValueFrom(this.http.get<ControleResume[]>(api('/mobile/mes-controles')));
  }

  emplacement(code: string): Promise<ContenuEmplacement> {
    return firstValueFrom(this.http.get<ContenuEmplacement>(api(`/mobile/emplacement/${encodeURIComponent(code)}`)));
  }

  produit(reference: string, lot = ''): Promise<LigneProduit[]> {
    return firstValueFrom(this.http.get<LigneProduit[]>(api('/mobile/produit'), { params: lot ? { reference, lot } : { reference } }));
  }

  // Envoie les opérations en attente, dans l'ordre (même uuid : jamais comptées deux fois)
  async envoyerAttente(): Promise<number> {
    if (this.envoiEnCours()) return 0;
    this.envoiEnCours.set(true);
    let envoyees = 0;
    try {
      for (const op of [...this.attente()]) {
        try {
          const r = await this.poster(op);
          this.retirer(op.uuid);
          this.memoriser(r);
          envoyees++;
        } catch (err) {
          const e = err as HttpErrorResponse;
          if (injoignable(e)) {
            this.majErreur(op.uuid, e.status === 0 ? 'Pas de réseau' : 'Serveur indisponible');
            break; // réseau toujours coupé : on réessaiera plus tard
          }
          // refus définitif (ex. session expirée) : on garde l'opération et on note la raison
          this.majErreur(op.uuid, e.error?.message ?? `Erreur ${e.status}`);
        }
      }
    } finally {
      this.envoiEnCours.set(false);
    }
    return envoyees;
  }

  supprimerAttente(uuid: string): void {
    this.retirer(uuid);
  }

  private async envoyer(op: OperationEnAttente): Promise<Envoi> {
    try {
      const resultat = await this.poster(op);
      this.memoriser(resultat);
      return { etat: 'fait', resultat };
    } catch (err) {
      const e = err as HttpErrorResponse;
      if (injoignable(e)) {
        // pas de réseau : l'opération est gardée et sera envoyée au retour du Wi-Fi
        op.derniereErreur = e.status === 0 ? 'Pas de réseau' : 'Serveur indisponible';
        this.attente.update((l) => [...l, op]);
        this.sauver();
        return { etat: 'en_attente', operation: op };
      }
      throw err;
    }
  }

  private poster(op: OperationEnAttente): Promise<ResultatControle> {
    return firstValueFrom(this.http.post<ResultatControle>(api(`/mobile/${op.controle}`), op.corps));
  }

  private memoriser(r: ResultatControle): void {
    this.recents.update((l) => [r, ...l.filter((x) => x.uuid !== r.uuid)].slice(0, 20));
    localStorage.setItem(CLE_RECENTS, JSON.stringify(this.recents()));
  }

  private retirer(uuid: string): void {
    this.attente.update((l) => l.filter((o) => o.uuid !== uuid));
    this.sauver();
  }

  private majErreur(uuid: string, message: string): void {
    this.attente.update((l) => l.map((o) => (o.uuid === uuid ? { ...o, derniereErreur: message } : o)));
    this.sauver();
  }

  private sauver(): void {
    localStorage.setItem(CLE_ATTENTE, JSON.stringify(this.attente()));
  }
}
