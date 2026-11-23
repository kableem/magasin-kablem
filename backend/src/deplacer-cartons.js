// « Ranger le magasin » : déplacer des cartons de cosses (décision du 2026-11-12).
// Le magasinier fait ce qu'il veut avec les cartons neufs du haut : il scanne l'étiquette d'un ou de plusieurs
// cartons (où qu'ils soient), puis UNE fois l'emplacement d'arrivée :
//   - en haut (niveaux 3-4, 4-5 du bloc E) ou en zone tampon, jamais aux niveaux des cosses séparées ;
//   - une palette de cartons déjà posée là : les cartons s'y ajoutent (références, lots, imports mélangés acceptés,
//     sans limite) ; un emplacement vide : les cartons forment une nouvelle palette (n° suivant de l'import) ;
//   - jamais sur des connecteurs, des cosses séparées ou un emplacement réservé (1 emplacement = 1 palette).
// Refusé : un carton ouvert (dès qu'une cosse est sortie, le carton n'existe plus : ses cosses sont séparées),
// et un carton sur le parcours d'une sortie en cours (jusqu'à la fin ou l'annulation de la sortie).
// La palette qui perd son dernier carton disparaît ; son emplacement se libère.
// Connecteurs (migration 041) : un carton de connecteurs = son ticket vert ; il se déplace de la même façon, vers une
// palette de connecteurs (jamais sur une palette de cosses) ; une palette descendue pour être complétée est bloquée.
const R = require('./rangement');
const C = require('./cartons');
const D = require('./descentes');
const { occupation } = require('./routes/stock');
const { enregistrerMouvements } = require('./historique');

const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;
const { lireTicket } = require('./ticket');

// « Le carton n° 3 » (cosses) ; « Le carton F0740 colis n° 3 » (connecteurs)
const nomCarton = (k) => (k.connecteur ? `Le carton ${k.reference} (colis n° ${k.numero})` : `Le carton n° ${k.numero}`);

// Carton d'une étiquette scannée ; null si ce n'est pas une étiquette de carton, { inconnu: true } si on ne la connaît pas
async function cartonDuQr(connexion, qr, verrou = false) {
  const e = C.lireEtiquetteCarton(qr);
  if (!e) return connecteurDuTicket(connexion, qr, verrou);
  const [[k]] = await connexion.query(`${C.SELECT_CARTON} WHERE c.date_etiquette = ? ${verrou ? 'FOR UPDATE' : ''}`, [e.date]);
  if (!k || String(k.reference).toUpperCase() !== e.reference) return { inconnu: true };
  return k;
}

// Carton de connecteurs d'un ticket vert, sur une palette de connecteurs ; null sinon
async function connecteurDuTicket(connexion, qr, verrou = false) {
  const t = lireTicket(qr);
  if (!t?.cle) return null;
  const [[x]] = await connexion.query(
    `SELECT c.ticket, c.reception_id, r.reference, r.lot, r.import_id, pc.id AS palette_id, pc.numero AS palette_numero, pc.statut AS statut_palette,
            pc.emplacement, pc.descendue_par
     FROM controles_mobile c JOIN receptions r ON r.id = c.reception_id JOIN palettes_cosses pc ON pc.id = c.palette_cosses_id
     WHERE c.ticket = ? AND c.controle = 'reception' AND c.resultat IN ('conforme', 'ecart_quantite') AND pc.famille = 'connecteur'
     ORDER BY c.id LIMIT 1 ${verrou ? 'FOR UPDATE' : ''}`,
    [t.cle]
  );
  if (!x) return null;
  return {
    connecteur: true, famille: 'connecteur', id: null, cle: x.ticket, numero: t.colis, reference: x.reference, lot: x.lot, import_id: x.import_id,
    palette_id: x.palette_id, palette_numero: x.palette_numero, emplacement: x.statut_palette === 'rangee' ? x.emplacement : null,
    statut: x.statut_palette === 'rangee' ? 'range' : 'termine', descendue: !!x.descendue_par, reception_id: x.reception_id,
  };
}

// Sortie en cours dont le parcours FIFO passe par ces lignes de stock à cet emplacement (lignes pas encore prises)
async function sortieSurLeParcours(connexion, emplacement, receptionIds) {
  if (!emplacement || !receptionIds.length) return null;
  const [[s]] = await connexion.query(
    `SELECT pe.id, pe.quantite, pe.reference FROM preparation_lignes pl JOIN preparations_export pe ON pe.id = pl.preparation_id
     WHERE pe.statut = 'en_cours' AND pl.valide = 0 AND pl.emplacement = ? AND pl.reception_id IN (?) LIMIT 1`,
    [emplacement, receptionIds]
  );
  return s ?? null;
}

// Un carton peut-il se déplacer ? { refus } (message clair) ou { restantes } (ses cosses en stock, à déplacer)
async function etatCarton(connexion, k) {
  if (k.connecteur) return etatConnecteur(connexion, k);
  if (k.statut !== 'range' || !k.emplacement) {
    return { refus: `Le carton n° ${k.numero} n'est pas encore rangé : rangez d'abord sa palette (Import → Rangement).` };
  }
  const [[descente]] = await connexion.query('SELECT statut FROM descentes_carton WHERE carton_id = ? ORDER BY id DESC LIMIT 1', [k.id]);
  const [[{ sorties }]] = await connexion.query(
    `SELECT COUNT(*) AS sorties FROM controles_mobile c
     WHERE c.carton_id = ? AND c.controle = 'reception' AND c.ticket IS NOT NULL
       AND EXISTS (SELECT 1 FROM controles_mobile x WHERE x.ticket = c.ticket AND x.controle = 'export' AND x.resultat IN ('prelevement_ok', 'sortie_terminee'))`,
    [k.id]
  );
  if (descente || Number(sorties)) {
    return {
      refus: `Le carton n° ${k.numero} (${k.reference}) a été ouvert : il n'existe plus, ses cosses sont des cosses séparées` +
        (descente?.statut === 'en_cours' ? ' — descendez-les d\'abord (écran Export).' : ' : déplacez-les une par une avec leur ticket.'),
    };
  }
  const restantes = await D.cossesRestantes(connexion, k.id);
  if (!restantes.length) return { refus: `Le carton n° ${k.numero} est vide : il n'y a plus rien à déplacer.` };
  const sortie = await sortieSurLeParcours(connexion, k.emplacement, [...new Set(restantes.map((x) => x.reception_id))]);
  if (sortie) {
    return { refus: `Le carton n° ${k.numero} est sur le parcours d'une sortie en cours (${sortie.quantite} × ${sortie.reference}) : attendez la fin ou l'annulation de cette sortie.` };
  }
  return { restantes };
}

async function etatConnecteur(connexion, k) {
  if (k.statut !== 'range' || !k.emplacement) return { refus: `${nomCarton(k)} n'est pas encore rangé : rangez d'abord sa palette (Import → Rangement).` };
  if (k.descendue) return { refus: `La palette de ${k.emplacement} est descendue pour être complétée : attendez qu'elle soit remise à sa place.` };
  const [[sorti]] = await connexion.query(
    "SELECT 1 AS oui FROM controles_mobile WHERE ticket = ? AND controle = 'export' AND resultat IN ('prelevement_ok', 'sortie_terminee') LIMIT 1",
    [k.cle]
  );
  if (sorti) return { refus: `${nomCarton(k)} est déjà sorti vers la production.` };
  const [[range]] = await connexion.query(
    "SELECT 1 AS oui FROM controles_mobile WHERE ticket = ? AND controle = 'rangement' AND resultat = 'bon_emplacement' LIMIT 1",
    [k.cle]
  );
  if (!range) return { refus: `${nomCarton(k)} n'est pas encore au stock : il y entre à la fin de la réception de son import.` };
  const sortie = await sortieSurLeParcours(connexion, k.emplacement, [k.reception_id]);
  if (sortie) return { refus: `${nomCarton(k)} est sur le parcours d'une sortie en cours (${sortie.quantite} × ${sortie.reference}) : attendez la fin ou l'annulation de cette sortie.` };
  return { restantes: [{ ticket: k.cle, reception_id: k.reception_id, reference: k.reference, lot: k.lot }] };
}

// L'arrivée peut-elle recevoir des cartons ? { refus } ou { palette } (palette déjà posée là, ou null : emplacement vide)
async function arriveePourCartons(connexion, vers, famille = 'cosse') {
  if (!R.estTampon(vers) && R.typeEmplacement(vers) !== 'connecteur') {
    const quoi = R.typeEmplacement(vers) === 'cosse' ? 'les niveaux 1 et 2 sont pour les cosses séparées'
      : R.typeEmplacement(vers) === 'bloque' ? `${vers} est bloqué` : 'c\'est un emplacement de bobines';
    return { refus: `Un carton neuf se range en haut (niveaux 3 et 4, 4 et 5 du bloc E) ou en zone tampon, pas en ${vers} : ${quoi}.` };
  }
  const ici = (await occupation(connexion, true)).filter((l) => l.emplacement === vers && Number(l.quantite) > 0);
  if (ici.some((l) => l.reserve)) return { refus: `${vers} est réservé pour un import : posez les cartons ailleurs.` };
  if (ici.some((l) => !l.palette_cosses_id)) {
    const connecteurs = ici.some((l) => l.type === 'connecteur');
    return { refus: `${vers} contient ${connecteurs ? 'des connecteurs' : 'des produits hors palette de cartons'} : un carton ne va que sur une palette de cartons ou un emplacement vide.` };
  }
  if (!ici.length) return { palette: null };
  const [[p]] = await connexion.query('SELECT id, import_id, numero, famille, descendue_par FROM palettes_cosses WHERE id = ? FOR UPDATE', [ici[0].palette_cosses_id]);
  if ((p.famille ?? 'cosse') !== famille) {
    return { refus: `${vers} porte une palette ${p.famille === 'connecteur' ? 'de connecteurs' : 'de cartons de cosses'} : une palette ne mélange jamais cosses et connecteurs.` };
  }
  if (p.descendue_par) return { refus: `La palette de ${vers} est descendue pour être complétée : posez les cartons ailleurs.` };
  return { palette: p };
}

// Nouvelle palette (déjà rangée) dans l'import du carton : n° suivant
async function nouvellePalette(connexion, importId, vers, utilisateurId, famille = 'cosse') {
  const [[{ suivant }]] = await connexion.query('SELECT COALESCE(MAX(numero), 0) + 1 AS suivant FROM palettes_cosses WHERE import_id = ? FOR UPDATE', [importId]);
  const [r] = await connexion.query(
    "INSERT INTO palettes_cosses (import_id, numero, famille, statut, emplacement, ouverte_par, date_terminee, date_rangee) VALUES (?, ?, ?, 'rangee', ?, ?, NOW(), NOW())",
    [importId, suivant, famille, vers, utilisateurId]
  );
  return { id: r.insertId, import_id: importId, numero: suivant, nouvelle: true };
}

// Déplace les cartons (déjà contrôlés par etatCarton) vers l'arrivée. Renvoie le résumé du déplacement.
async function deplacerCartons(connexion, cartons, vers, arrivee, utilisateurId) {
  const famille = cartons[0].k.connecteur ? 'connecteur' : 'cosse';
  const palette = arrivee.palette ?? (await nouvellePalette(connexion, cartons[0].k.import_id, vers, utilisateurId, famille));
  const quittees = new Map(); // palette de départ → emplacement
  const mouvements = [];
  for (const { k, restantes } of cartons) {
    const depuis = k.emplacement;
    const parLigne = new Map();
    for (const x of restantes) parLigne.set(x.reception_id, [...(parLigne.get(x.reception_id) ?? []), x]);
    for (const [receptionId, cosses] of parLigne) {
      const n = cosses.length;
      await connexion.query('UPDATE placements SET quantite = quantite - ? WHERE reception_id = ? AND emplacement = ?', [n, receptionId, depuis]);
      await connexion.query('DELETE FROM placements WHERE reception_id = ? AND emplacement = ? AND quantite <= 0', [receptionId, depuis]);
      // la ligne d'arrivée garde le carton seulement s'il est seul sur cette ligne
      await connexion.query(
        `INSERT INTO placements (reception_id, emplacement, quantite, carton_id, palette_cosses_id) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE carton_id = IF(carton_id <=> VALUES(carton_id), carton_id, NULL), quantite = quantite + VALUES(quantite), palette_cosses_id = VALUES(palette_cosses_id)`,
        [receptionId, vers, n, k.id, palette.id]
      );
      const x = cosses[0];
      mouvements.push({
        origine: 'regroupement', ligne: { reception_id: receptionId, reference: x.reference, lot: x.lot, type: famille, taille_bobine: null },
        quantite: n, depuis, vers, motif: 'regroupement', utilisateurId, colis: k.connecteur ? k.numero : null,
        commentaire: k.connecteur ? `Carton de connecteurs → palette n° ${palette.numero}` : `Carton n° ${k.numero} → palette n° ${palette.numero}`,
      });
    }
    if (k.connecteur) {
      await connexion.query("UPDATE controles_mobile SET palette_cosses_id = ? WHERE ticket = ? AND controle IN ('reception', 'rangement')", [palette.id, k.cle]);
      await connexion.query("UPDATE controles_mobile SET emplacement_scanne = ? WHERE ticket = ? AND controle = 'rangement' AND resultat = 'bon_emplacement'", [vers, k.cle]);
    } else {
      await connexion.query('UPDATE cartons SET palette_id = ?, emplacement = ? WHERE id = ?', [palette.id, vers, k.id]);
      await connexion.query("UPDATE controles_mobile SET palette_cosses_id = ? WHERE carton_id = ? AND controle = 'reception'", [palette.id, k.id]);
    }
    await connexion.query(
      'UPDATE affectations_colis SET emplacement = ? WHERE emplacement = ? AND range_le IS NOT NULL AND ticket IN (?)',
      [vers, depuis, restantes.map((x) => x.ticket)]
    );
    if (k.palette_id && k.palette_id !== palette.id) quittees.set(k.palette_id, depuis);
  }
  // Emplacements de départ libérés ; palettes de départ sans carton : elles disparaissent
  const liberes = [];
  for (const depuis of new Set(cartons.map((c) => c.k.emplacement))) {
    const [[{ reste }]] = await connexion.query('SELECT COUNT(*) AS reste FROM placements WHERE emplacement = ? AND quantite > 0', [depuis]);
    if (!Number(reste)) liberes.push(depuis);
  }
  for (const m of mouvements) m.depuisLiberee = liberes.includes(m.depuis);
  await enregistrerMouvements(connexion, mouvements);
  for (const id of quittees.keys()) {
    const [[{ cartons: n }]] = await connexion.query('SELECT COUNT(*) AS cartons FROM cartons WHERE palette_id = ?', [id]);
    const [[{ cosses }]] = await connexion.query("SELECT COUNT(*) AS cosses FROM controles_mobile WHERE palette_cosses_id = ? AND controle = 'reception'", [id]);
    const [[{ stock }]] = await connexion.query('SELECT COUNT(*) AS stock FROM placements WHERE palette_cosses_id = ? AND quantite > 0', [id]);
    if (!Number(n) && !Number(cosses) && !Number(stock)) await connexion.query('DELETE FROM palettes_cosses WHERE id = ?', [id]);
  }
  const nbCosses = cartons.reduce((t, c) => t + c.restantes.length, 0);
  const texte = famille === 'connecteur'
    ? `${pluriel(cartons.length, 'carton')} de connecteurs`
    : `${pluriel(cartons.length, 'carton')} (${pluriel(nbCosses, 'cosse')})`;
  return { palette, liberes, nbCosses, texte };
}

module.exports = { nomCarton, cartonDuQr, etatCarton, arriveePourCartons, deplacerCartons, sortieSurLeParcours };
