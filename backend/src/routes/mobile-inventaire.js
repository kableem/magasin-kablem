// Inventaire initial du magasin (étude n° 2), sur le mobile : chef de magasin et administrateur.
//
//   GET  /api/mobile/inventaire/emplacements/:code   ce que l'application croit être à cet emplacement
//   POST /api/mobile/inventaire/emplacements/:code   { qrs: [...] }  contenu réel scanné : remplace celui de l'application
//
// Les produits inventoriés sont rattachés à l'import « INVENTAIRE-AAAA-MM-JJ » du jour (validé, au stock) ;
// leur type vient du catalogue Articles (bobine = petite bobine pour le moment). Chaque produit retiré ou
// ajouté par l'inventaire est noté dans l'historique des emplacements (origine « inventaire »).
const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { verrouillerStock, libererStock } = require('../verrou-stock');
const { lignesEnStock, poserQuantite } = require('./stock');
const { capaciteTampon } = require('../parametres');
const { enregistrerMouvements } = require('../historique');
const { typesDuCatalogue, normaliserReference } = require('../articles');
const { lireTicket, lireEmplacement } = require('../ticket');

const router = express.Router();
const refus = (status, message) => Object.assign(new Error(message), { status });

async function codeValide(connexion, brut) {
  const code = lireEmplacement(brut);
  if (!code || !R.emplacementValide(code, await capaciteTampon(connexion))) throw refus(400, `« ${brut} » n'est pas un emplacement du magasin.`);
  return code;
}

// Contenu actuel d'un emplacement (stock de l'application)
async function contenu(connexion, code) {
  return (await lignesEnStock(connexion)).filter((l) => l.emplacement === code)
    .map((l) => ({ reception_id: l.reception_id, reference: l.reference, lot: l.lot, type: l.type, taille_bobine: l.taille_bobine, type_cosse: l.type_cosse, quantite: Number(l.quantite) }));
}

// GET /emplacements/:code
router.get('/emplacements/:code', async (req, res, next) => {
  try {
    const code = await codeValide(db, req.params.code);
    const [[dernier]] = await db.query(
      "SELECT DATE_FORMAT(MAX(date_scan), '%Y-%m-%dT%H:%i:%s') AS date FROM inventaire_scans WHERE emplacement = ?",
      [code]
    );
    res.json({ code, niveau: R.lireCode(code)?.niveau ?? null, tampon: R.estTampon(code), contenu: await contenu(db, code), inventorie_le: dernier?.date ?? null });
  } catch (err) { next(err); }
});

// Import « Inventaire » du jour (créé au premier emplacement inventorié)
async function importInventaire(connexion, utilisateurId) {
  const jour = new Date().toISOString().slice(0, 10);
  const numero = `INVENTAIRE-${jour}`;
  const [[imp]] = await connexion.query('SELECT id FROM imports WHERE numero_livraison = ? FOR UPDATE', [numero]);
  if (imp) return imp.id;
  const [r] = await connexion.query(
    `INSERT INTO imports (numero_livraison, statut, reception, date_envoi, date_creation, date_ajout_stock, cree_par, ajoute_par)
     VALUES (?, 'ajoute', 'terminee', NOW(), NOW(), NOW(), ?, ?)`,
    [numero, utilisateurId, utilisateurId]
  );
  return r.insertId;
}

// POST /emplacements/:code { qrs } : valide le contenu réel de l'emplacement
router.post('/emplacements/:code', async (req, res, next) => {
  const connexion = await db.getConnection();
  try {
    await verrouillerStock(connexion);
    await connexion.beginTransaction();
    const code = await codeValide(connexion, req.params.code);
    const qrs = Array.isArray(req.body?.qrs) ? req.body.qrs.map((q) => String(q ?? '').trim()).filter(Boolean) : null;
    if (!qrs) throw refus(400, 'Liste des tickets scannés manquante');
    if (qrs.length > 200) throw refus(400, '200 tickets au maximum par emplacement');

    // 1. Lecture et contrôle des tickets
    const tickets = [];
    for (const qr of qrs) {
      const t = lireTicket(qr);
      if (!t) throw refus(400, `Ticket illisible : « ${qr.slice(0, 40)} ». Scannez le QR du bas du ticket vert.`);
      tickets.push({ ...t, qr, reference: normaliserReference(t.reference) });
    }
    const cles = tickets.filter((t) => t.cle).map((t) => t.cle);
    const doublon = cles.find((c, k) => cles.indexOf(c) !== k);
    if (doublon) throw refus(409, `Le colis ${doublon.split('|').pop()} de ${doublon.split('|')[0]} est scanné deux fois.`);
    if (cles.length) {
      const [ailleurs] = await connexion.query('SELECT ticket, emplacement FROM inventaire_scans WHERE ticket IN (?) AND emplacement <> ?', [cles, code]);
      if (ailleurs.length) {
        const a = ailleurs[0];
        throw refus(409, `Le colis ${a.ticket.split('|').pop()} de ${a.ticket.split('|')[0]} est déjà inventorié en ${a.emplacement}.`);
      }
    }
    const catalogue = await typesDuCatalogue(connexion, tickets.map((t) => t.reference));
    const inconnues = [...new Set(tickets.filter((t) => !catalogue.has(t.reference)).map((t) => t.reference))];
    if (inconnues.length) {
      throw refus(400, `Référence(s) absente(s) du catalogue Articles : ${inconnues.join(', ')}. Ajoutez-les dans Administration → Articles.`);
    }
    const typePlace = R.typeEmplacement(code);
    const mauvaisNiveau = tickets.find((t) => typePlace && catalogue.get(t.reference).type !== typePlace);
    if (mauvaisNiveau) {
      const type = catalogue.get(mauvaisNiveau.reference).type;
      throw refus(409, `${mauvaisNiveau.reference} (${type}) se range ${R.AU_NIVEAU[type]}, pas en ${code}.`);
    }

    // 2. Ce que l'application avait à cet emplacement : retiré
    const avant = await contenu(connexion, code);
    const [anciensScans] = await connexion.query('SELECT reception_id, quantite FROM inventaire_scans WHERE emplacement = ?', [code]);
    for (const s of anciensScans) await connexion.query('UPDATE receptions SET quantite = quantite - ? WHERE id = ?', [s.quantite, s.reception_id]);
    await connexion.query('DELETE FROM inventaire_scans WHERE emplacement = ?', [code]);
    await connexion.query('DELETE FROM placements WHERE emplacement = ?', [code]);
    const [lignesAvant] = avant.length
      ? await connexion.query('SELECT id, reference, lot, type, taille_bobine, type_cosse FROM receptions WHERE id IN (?)', [avant.map((a) => a.reception_id)])
      : [[]];

    // 3. Ce qui a été scanné : ajouté, sur les lignes de l'import « Inventaire » du jour
    const importId = await importInventaire(connexion, req.utilisateur.id);
    const apres = new Map(); // reception_id -> { ligne, quantite }
    for (const t of tickets) {
      const type = catalogue.get(t.reference);
      const [[ligne]] = await connexion.query(
        'SELECT id, reference, lot, type, taille_bobine, type_cosse FROM receptions WHERE import_id = ? AND reference = ? AND lot = ? FOR UPDATE',
        [importId, t.reference, t.lot]
      );
      let l = ligne;
      if (!l) {
        const [r] = await connexion.query(
          `INSERT INTO receptions (import_id, type, taille_bobine, type_cosse, reference, lot, date_reception, quantite, commentaire, utilisateur_id)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), 0, 'Inventaire initial', ?)`,
          [importId, type.type, type.taille_bobine, type.type_cosse ?? null, t.reference, t.lot, req.utilisateur.id]
        );
        l = { id: r.insertId, reference: t.reference, lot: t.lot, type: type.type, taille_bobine: type.taille_bobine, type_cosse: type.type_cosse ?? null };
      }
      const quantite = t.cle ? 1 : t.quantite;
      await connexion.query('UPDATE receptions SET quantite = quantite + ? WHERE id = ?', [quantite, l.id]);
      await poserQuantite(connexion, l.id, code, quantite);
      await connexion.query(
        'INSERT INTO inventaire_scans (ticket, qr_brut, emplacement, reception_id, quantite, utilisateur_id) VALUES (?, ?, ?, ?, ?, ?)',
        [t.cle, t.qr.slice(0, 500), code, l.id, quantite, req.utilisateur.id]
      );
      const a = apres.get(l.id) ?? { ligne: l, quantite: 0 };
      a.quantite += quantite;
      apres.set(l.id, a);
    }
    await connexion.query('DELETE FROM receptions WHERE import_id = ? AND quantite <= 0', [importId]);

    // 4. Historique : ce qui sort de l'emplacement et ce qui y entre
    const parLigne = new Map(lignesAvant.map((l) => [l.id, l]));
    await enregistrerMouvements(connexion, [
      ...avant.map((a) => ({
        origine: 'inventaire', ligne: { ...parLigne.get(a.reception_id), reception_id: a.reception_id }, quantite: a.quantite, depuis: code, vers: null,
        commentaire: "Inventaire : contenu de l'application remplacé", utilisateurId: req.utilisateur.id,
      })),
      ...[...apres.values()].map((a) => ({
        origine: 'inventaire', ligne: { ...a.ligne, reception_id: a.ligne.id }, quantite: a.quantite, depuis: null, vers: code,
        commentaire: 'Inventaire : compté sur place', utilisateurId: req.utilisateur.id,
      })),
    ]);
    await connexion.commit();

    // Écarts entre l'application et le terrain, par référence et lot
    const cle = (x) => `${x.reference}|${x.lot}`;
    const compter = (liste) => liste.reduce((m, x) => m.set(cle(x), (m.get(cle(x)) ?? 0) + x.quantite), new Map());
    const nAvant = compter(avant);
    const nApres = compter([...apres.values()].map((a) => ({ ...a.ligne, quantite: a.quantite })));
    const ecarts = [...new Set([...nAvant.keys(), ...nApres.keys()])]
      .map((k) => ({ reference: k.split('|')[0], lot: k.split('|')[1], application: nAvant.get(k) ?? 0, compte: nApres.get(k) ?? 0 }))
      .filter((e) => e.application !== e.compte);
    const total = [...apres.values()].reduce((t, a) => t + a.quantite, 0);
    res.json({
      code, total, ecarts,
      message: `${code} inventorié : ${total} produit${total > 1 ? 's' : ''}${ecarts.length ? `, ${ecarts.length} écart${ecarts.length > 1 ? 's' : ''} avec l'application` : ', conforme à l\'application'}.`,
    });
  } catch (err) {
    await connexion.rollback();
    next(err);
  } finally {
    await libererStock(connexion);
    connexion.release();
  }
});

module.exports = router;
