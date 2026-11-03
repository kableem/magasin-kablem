// Adresse de l'API, lue au démarrage dans assets/config.json (modifiable sans recompiler).
// Jamais « localhost » en dur : sur le téléphone, localhost désigne le téléphone lui-même.
//   - en test (npm start) : "/api", relayé vers le backend par le serveur de développement (proxy.conf.json) ;
//   - en production : l'adresse HTTPS du serveur, ex. "https://magasin.kablem.tn/api".
let apiUrl = '/api';

export async function chargerConfig(): Promise<void> {
  try {
    const r = await fetch('assets/config.json', { cache: 'no-store' });
    const config = await r.json();
    if (typeof config.apiUrl === 'string' && config.apiUrl.trim()) apiUrl = config.apiUrl.trim().replace(/\/$/, '');
  } catch {
    // fichier absent : on garde "/api"
  }
}

export const api = (chemin: string) => `${apiUrl}${chemin}`;
