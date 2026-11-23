import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { api } from './config';
import { nouvelUuid } from './controles.service';
import { Descente, ResultatControle } from './modeles';

// Descente des cosses restantes d'un carton ouvert à l'export : l'emplacement imposé, puis le ticket de chaque cosse
@Injectable({ providedIn: 'root' })
export class DescenteService {
  private http = inject(HttpClient);

  async enCours(): Promise<Descente | null> {
    return (await firstValueFrom(this.http.get<{ descente: Descente | null }>(api('/mobile/descente/en-cours')))).descente;
  }

  scanner(id: number, emplacement: string, qr: string): Promise<ResultatControle> {
    return firstValueFrom(this.http.post<ResultatControle>(api(`/mobile/descente/${id}/scan`), { uuid: nouvelUuid(), emplacement, qr }));
  }
}
