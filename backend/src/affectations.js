// Emplacement imposé de chaque colis (un ticket fournisseur = un colis).
//
// À la validation de la réception, les colis reçus d'une ligne d'import sont attribués aux places
// de son plan de rangement : colis triés par numéro, places remplies dans l'ordre du plan
// (ex. 6 petites bobines, plan C021 ×5 puis C017 ×1 → colis n° 1 à 5 en C021, n° 6 en C017).
// Au rangement, seul l'emplacement attribué est accepté ; le chef peut le changer sur le web.
const { numeroColis } = require('./reception-import');

// Places du plan d'une ligne avec ce qui reste à attribuer
// (prévu - déjà rangé - attribué mais pas encore rangé), dans l'ordre du plan
async function placesLibres(connexion, receptionId) {
  const [plan] = await connexion.query(
    'SELECT id, emplacement, quantite, ranges FROM plans_rangement WHERE reception_id = ? ORDER BY id FOR UPDATE',
    [receptionId]
  );
  const [attribues] = await connexion.query(
    `SELECT emplacement, COUNT(*) AS n FROM affectations_colis
     WHERE reception_id = ? AND range_le IS NULL GROUP BY emplacement`,
    [receptionId]
  );
  const enAttente = new Map(attribues.map((a) => [a.emplacement, Number(a.n)]));
  return plan.map((p) => ({ ...p, libre: p.quantite - p.ranges - (enAttente.get(p.emplacement) ?? 0) }));
}

// Ordre des colis : numéro, puis identifiant (deux suffixes de lot peuvent avoir le même numéro)
const ordreColis = (a, b) => numeroColis(a) - numeroColis(b) || a.localeCompare(b);

// Attribue les colis reçus et pas encore attribués d'une ligne. Renvoie le nombre de colis attribués.
async function attribuerColis(connexion, receptionId) {
  const [recus] = await connexion.query(
    `SELECT DISTINCT c.ticket FROM controles_mobile c
     WHERE c.reception_id = ? AND c.controle = 'reception' AND c.resultat = 'conforme' AND c.ticket IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM affectations_colis a WHERE a.ticket = c.ticket)`,
    [receptionId]
  );
  const tickets = recus.map((r) => r.ticket).sort(ordreColis);
  if (!tickets.length) return 0;
  const places = await placesLibres(connexion, receptionId);
  let n = 0;
  for (const ticket of tickets) {
    const place = places.find((p) => p.libre > 0);
    if (!place) break; // plus de place prévue : le chef attribuera à la main
    await connexion.query(
      'INSERT INTO affectations_colis (reception_id, ticket, colis, emplacement) VALUES (?, ?, ?, ?)',
      [receptionId, ticket, numeroColis(ticket), place.emplacement]
    );
    place.libre--;
    n++;
  }
  return n;
}

// Emplacement attribué à un colis ; s'il n'en a pas encore (import validé avant cette règle),
// il reçoit la première place libre du plan. null si aucune place n'est disponible.
async function affectationDuColis(connexion, receptionId, ticketCle) {
  const lire = async () =>
    (await connexion.query('SELECT * FROM affectations_colis WHERE ticket = ? FOR UPDATE', [ticketCle]))[0][0] ?? null;
  const existante = await lire();
  if (existante) return existante;
  const place = (await placesLibres(connexion, receptionId)).find((p) => p.libre > 0);
  if (!place) return null;
  await connexion.query(
    'INSERT IGNORE INTO affectations_colis (reception_id, ticket, colis, emplacement) VALUES (?, ?, ?, ?)',
    [receptionId, ticketCle, numeroColis(ticketCle), place.emplacement]
  );
  return lire();
}

module.exports = { attribuerColis, affectationDuColis, placesLibres };
