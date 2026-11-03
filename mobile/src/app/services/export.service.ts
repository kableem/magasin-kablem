import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { api } from './config';
import { nouvelUuid } from './controles.service';
import { Destination, PreparationExport, ResultatControle } from './modeles';

// Sortie vers la production : le FIFO et toutes les vérifications sont faits par l'API.
// Chaque scan doit être validé tout de suite (produit pris ou non) : la sortie demande le réseau.
@Injectable({ providedIn: 'root' })
export class ExportService {
  private http = inject(HttpClient);

  preparer(reference: string, quantite: number, destination: Destination): Promise<PreparationExport> {
    return firstValueFrom(
      this.http.post<PreparationExport>(api('/mobile/export/preparer'), { uuid: nouvelUuid(), reference, quantite, destination })
    );
  }

  enCours(): Promise<PreparationExport | null> {
    return firstValueFrom(this.http.get<PreparationExport | null>(api('/mobile/export/en-cours')));
  }

  annuler(id: number): Promise<PreparationExport> {
    return firstValueFrom(this.http.post<PreparationExport>(api(`/mobile/export/${id}/annuler`), {}));
  }

  // emplacement null = produit pas encore rangé (aucune étiquette à scanner)
  scanner(id: number, emplacement: string | null, qr: string, saisieManuelle: boolean): Promise<ResultatControle> {
    return firstValueFrom(
      this.http.post<ResultatControle>(api(`/mobile/export/${id}/scan`), {
        uuid: nouvelUuid(),
        emplacement,
        sans_emplacement: emplacement === null,
        qr,
        saisie_manuelle: saisieManuelle,
      })
    );
  }
}
