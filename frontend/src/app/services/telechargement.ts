import { HttpResponse } from '@angular/common/http';

// Enregistre un fichier reçu du serveur (nom tiré de l'en-tête Content-Disposition)
export function enregistrerFichier(reponse: HttpResponse<Blob>, nomParDefaut: string): void {
  const entete = reponse.headers.get('Content-Disposition') ?? '';
  const nom = /filename="?([^";]+)"?/.exec(entete)?.[1] ?? nomParDefaut;
  const url = URL.createObjectURL(reponse.body!);
  const lien = document.createElement('a');
  lien.href = url;
  lien.download = nom;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
