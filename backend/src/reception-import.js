// Lien entre la réception physique (scans du mobile) et l'import (web).
// Calcule, pour des imports, ce qui a été reçu, ce qui manque, ce qui est en trop ou hors import,
// et ce qui est rangé. Un ticket de colis compte pour 1 produit ; un ticket par lot compte sa quantité.

// Numéro du colis dans l'identifiant du ticket « F0391|202613167-1|10 » -> 10
const numeroColis = (ticket) => (ticket ? Number(String(ticket).split('|').pop()) : null);
const trier = (liste) => [...new Set(liste)].filter((n) => Number.isFinite(n)).sort((x, y) => x - y);

// Quantité attendue d'une ligne = annoncée par l'Italie - déjà réclamée (elle n'entre pas au stock)
async function avancement(connexion, importIds) {
  const resultat = new Map(importIds.map((id) => [id, {
    attendus: 0, recus: 0, en_trop: 0, manquants: 0, ranges: 0, hors_import: 0, lignes: new Map(), anomalies: [],
  }]));
  if (!importIds.length) return resultat;

  const [lignes] = await connexion.query(
    `SELECT r.id, r.import_id, r.reference, r.lot, r.type, r.taille_bobine, r.type_cosse, r.quantite AS annoncee,
            r.quantite - COALESCE(rc.quantite, 0) AS attendue
     FROM receptions r LEFT JOIN reclamations rc ON rc.reception_id = r.id
     WHERE r.import_id IN (?) ORDER BY r.id`,
    [importIds]
  );
  const [scans] = lignes.length
    ? await connexion.query(
        `SELECT reception_id, controle, resultat, ticket, quantite_ticket FROM controles_mobile
         WHERE reception_id IN (?)
           AND ((controle = 'reception' AND resultat IN ('conforme', 'ecart_quantite'))
             OR (controle = 'rangement' AND resultat = 'bon_emplacement'))`,
        [lignes.map((l) => l.id)]
      )
    : [[]];
  const brut = new Map();
  const ranges = new Map();
  const numeros = new Map(); // reception_id -> { recus: [n°], en_trop: [n°], ranges: [n°] }
  const noter = (id, champ, n) => {
    if (n === null) return;
    if (!numeros.has(id)) numeros.set(id, { recus: [], en_trop: [], ranges: [] });
    numeros.get(id)[champ].push(n);
  };
  for (const s of scans) {
    if (s.controle === 'reception') noter(s.reception_id, s.resultat === 'conforme' ? 'recus' : 'en_trop', numeroColis(s.ticket));
    else noter(s.reception_id, 'ranges', numeroColis(s.ticket));
    if (s.controle === 'reception') {
      // colis : 1 produit ; ticket par lot : la quantité du ticket
      brut.set(s.reception_id, (brut.get(s.reception_id) ?? 0) + (s.ticket ? 1 : Number(s.quantite_ticket ?? 0)));
    } else {
      // colis : 1 produit rangé ; ticket par lot : toute la ligne est rangée
      ranges.set(s.reception_id, (ranges.get(s.reception_id) ?? 0) + (s.ticket ? 1 : Infinity));
    }
  }
  for (const l of lignes) {
    const a = resultat.get(l.import_id);
    const attendue = Math.max(0, Number(l.attendue));
    const recuBrut = brut.get(l.id) ?? 0;
    const recus = Math.min(attendue, recuBrut);
    const ligne = {
      id: l.id, reference: l.reference, lot: l.lot, type: l.type, taille_bobine: l.taille_bobine, type_cosse: l.type_cosse,
      annoncee: Number(l.annoncee), attendue, recus,
      en_trop: Math.max(0, recuBrut - attendue),
      manquants: attendue - recus,
      ranges: Math.min(recus, ranges.get(l.id) ?? 0),
      // numéros des colis (tickets fournisseur) : distinguent les produits de même référence et même lot
      colis_recus: trier(numeros.get(l.id)?.recus ?? []),
      colis_en_trop: trier(numeros.get(l.id)?.en_trop ?? []),
      colis_ranges: trier(numeros.get(l.id)?.ranges ?? []),
    };
    a.lignes.set(l.id, ligne);
    a.attendus += attendue;
    a.recus += recus;
    a.en_trop += ligne.en_trop;
    a.manquants += ligne.manquants;
    a.ranges += ligne.ranges;
  }
  // Produits scannés pendant la réception de l'import mais absents de l'import
  const [hors] = await connexion.query(
    `SELECT import_id, reference, lot, COUNT(*) AS n FROM controles_mobile
     WHERE import_id IN (?) AND controle = 'reception' AND resultat = 'inconnu' AND reference IS NOT NULL
     GROUP BY import_id, reference, lot`,
    [importIds]
  );
  for (const h of hors) {
    const a = resultat.get(h.import_id);
    a.hors_import += Number(h.n);
    a.anomalies.push({ type: 'hors_import', reference: h.reference, lot: h.lot, quantite: Number(h.n) });
  }
  for (const a of resultat.values()) {
    for (const l of a.lignes.values()) {
      if (l.manquants) a.anomalies.push({ type: 'manquant', reception_id: l.id, reference: l.reference, lot: l.lot, quantite: l.manquants });
      if (l.en_trop) a.anomalies.push({ type: 'en_trop', reception_id: l.id, reference: l.reference, lot: l.lot, quantite: l.en_trop });
    }
  }
  return resultat;
}

// Étape affichée d'un import (web et mobile)
function etape(imp, av) {
  if (imp.statut === 'ajoute') return av && av.recus > 0 && av.ranges >= av.recus ? 'range' : 'ajoute';
  if (imp.reception === 'terminee') return imp.reception_ecarts > 0 ? 'a_valider' : 'receptionne';
  if (imp.reception === 'en_cours') return 'reception_en_cours';
  return 'en_attente';
}

// Pour le JSON : les lignes en tableau
const versJson = (av) => av && { ...av, lignes: [...av.lignes.values()] };

module.exports = { avancement, etape, versJson, numeroColis };
