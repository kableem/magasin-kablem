import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { api } from './config';
import { nouvelUuid } from './controles.service';
import { Destination, ResultatControle, TypeProduit } from './modeles';

// Sortie urgente vers la production (pendant la réception de l'import) : tout est vérifié par l'API
export interface SortieUrgente {
  id: number;
  ticket: string;
  colis: number;
  reference: string;
  lot: string;
  destination: Destination;
  statut: 'a_poser' | 'posee' | 'sortie' | 'annulee';
  emplacement_propose: string | null; // vide le plus proche de la porte
  emplacement: string | null; // où le colis est posé
  stock_existant: number;
  autorise_par: string | null; // matricule du chef (même référence déjà en stock : hors FIFO)
  preparation_id: number | null; // sortie mobile à scanner (emplacement puis ticket)
  export_id: number | null;
  import_id: number;
  numero_livraison: string | null;
  type: TypeProduit;
  taille_bobine: string | null;
}

// Accord du chef : son matricule et son mot de passe, ou « moi » (chef ou administrateur connecté)
export type Autorisation = { matricule: string; mot_de_passe: string } | 'moi';

@Injectable({ providedIn: 'root' })
export class UrgenceService {
  private http = inject(HttpClient);

  enCours(): Promise<{ urgence: SortieUrgente | null; message: string | null }> {
    return firstValueFrom(this.http.get<{ urgence: SortieUrgente | null; message: string | null }>(api('/mobile/urgence/en-cours')));
  }

  demander(qr: string, destination: Destination, saisieManuelle: boolean, autorisation?: Autorisation): Promise<{ urgence: SortieUrgente; message: string }> {
    return firstValueFrom(
      this.http.post<{ urgence: SortieUrgente; message: string }>(api('/mobile/urgence'), {
        qr, destination, saisie_manuelle: saisieManuelle,
        ...(autorisation === 'moi' ? { autoriser: true } : autorisation ? { autorisation } : {}),
      })
    );
  }

  poser(id: number, emplacement: string, saisieManuelle: boolean): Promise<ResultatControle & { urgence?: SortieUrgente }> {
    return firstValueFrom(
      this.http.post<ResultatControle & { urgence?: SortieUrgente }>(api(`/mobile/urgence/${id}/poser`), {
        uuid: nouvelUuid(), emplacement, saisie_manuelle: saisieManuelle,
      })
    );
  }

  annuler(id: number): Promise<{ urgence: SortieUrgente; message: string }> {
    return firstValueFrom(this.http.post<{ urgence: SortieUrgente; message: string }>(api(`/mobile/urgence/${id}/annuler`), {}));
  }
}
