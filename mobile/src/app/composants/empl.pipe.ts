import { Pipe, PipeTransform } from '@angular/core';
import { nomEmplacement } from '../services/plan';

// Affiche un emplacement comme sur son étiquette : « A110 » → « 0012 » ; sans numéro (bobines, connecteurs,
// zone tampon), le code reste affiché. Vide si pas d'emplacement : {{ (e.code | empl) || 'non rangé' }}
@Pipe({ name: 'empl', standalone: true })
export class EmplPipe implements PipeTransform {
  transform(code: string | null | undefined): string {
    return nomEmplacement(code);
  }
}
