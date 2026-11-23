import { Pipe, PipeTransform } from '@angular/core';
import { nomEmplacement } from './plan-magasin';

// Affiche un emplacement comme sur son étiquette : « D100 » → « 0342 » ; sans numéro (bobines, connecteurs,
// zone tampon), le code reste affiché. Vide si pas d'emplacement.
@Pipe({ name: 'empl', standalone: true })
export class EmplPipe implements PipeTransform {
  transform(code: string | null | undefined): string {
    return nomEmplacement(code);
  }
}
