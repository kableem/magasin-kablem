const express = require('express');
const db = require('../db');
const R = require('../rangement');
const { lignesEnStock, placesReservees } = require('./stock');
const { parametresRangement, delaiReclamation } = require('../parametres');
const { avecNumeros } = require('../plan');
const { DUREE_MAX_MINUTES } = require('../reservations');

// « 35 min », « 2 h 05 »
const duree = (minutes) => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`);

const router = express.Router();

// Seuils des alertes
const SEUIL_ALERTE = 0.8; // 80 % : attention
const SEUIL_CRITIQUE = 0.9; // 90 % : critique

const ZONES = [
  { cle: 'bobines', type: 'bobine', libelle: 'Bobines', detail: 'Niveau 0, blocs A à D', niveaux: [0] },
  { cle: 'cosses', type: 'cosse', libelle: 'Cosses séparées', detail: 'Niveaux 1 et 2 (1 à 3 du bloc E)', niveaux: [1, 2, 3] },
  { cle: 'connecteurs', type: 'connecteur', libelle: 'Connecteurs et cartons de cosses', detail: 'Niveaux 3 et 4 (4 et 5 du bloc E)', niveaux: [3, 4, 5] },
];

// Taux de remplissage d'une palette (0 à 1) : nombre de produits / capacité ;
// connecteurs (provisoire, sans volume ni poids) : un emplacement occupé est plein
function tauxPalette(code, lignes) {
  if (!lignes.length) return 0;
  if (lignes.some((l) => l.palette_cosses_id)) return 1; // une palette de cosses occupe tout l'emplacement
  const premiere = lignes[0];
  if (premiere.type === 'connecteur') return 1;
  const n = lignes.reduce((s, l) => s + l.quantite, 0);
  return Math.min(n / R.capacite(premiere), 1);
}

// Résumé d'un ensemble d'emplacements : libres, partiels, pleins, taux d'utilisation de la capacité
function resumer(codes, parPlace) {
  const r = { total: codes.length, libres: 0, partiels: 0, pleins: 0, produits: 0, taux: 0 };
  let somme = 0;
  for (const code of codes) {
    const lignes = parPlace.get(code) ?? [];
    const taux = tauxPalette(code, lignes);
    somme += taux;
    r.produits += lignes.reduce((s, l) => s + l.quantite, 0);
    if (!lignes.length) r.libres++;
    else if (taux >= 1) r.pleins++;
    else r.partiels++;
  }
  r.taux = codes.length ? Math.round((1000 * somme) / codes.length) / 10 : 0; // % avec une décimale
  r.places_occupees = r.partiels + r.pleins;
  return r;
}

// GET /api/tableau-de-bord : remplissage, alertes, activité, réclamations
router.get('/', async (req, res, next) => {
  try {
    const { capaciteTampon } = await parametresRangement();
    const stock = await lignesEnStock();
    const parPlace = new Map();
    for (const l of stock) if (l.emplacement) parPlace.set(l.emplacement, [...(parPlace.get(l.emplacement) ?? []), l]);

    // ---------- Remplissage ----------
    const remplissage = ZONES.map((z) => ({
      ...z,
      // par type de place : bobines = blocs A à D (le niveau 0 des blocs E à H = bobines WIP, non géré), places bloquées exclues,
      // bloc E : le niveau 3 compte avec les cosses séparées
      ...resumer(R.emplacementsDuType(z.type), parPlace),
    }));
    const tampon = {
      cle: 'tampon', libelle: 'Zone tampon', detail: `${capaciteTampon} places au sol`,
      ...resumer(R.placesTampon(capaciteTampon), parPlace),
    };
    // Pour la zone tampon, ce qui compte est le nombre de places occupées
    tampon.taux = capaciteTampon ? Math.round((1000 * tampon.places_occupees) / capaciteTampon) / 10 : 0;
    remplissage.push(tampon);
    const sansEmplacement = stock.filter((l) => !l.emplacement).reduce((s, l) => s + l.quantite, 0);

    // ---------- Imports en attente : bloqués faute de place ? ----------
    const [enAttente] = await db.query(
      `SELECT i.id, DATE_FORMAT(i.date_creation, '%Y-%m-%dT%H:%i:%s') AS date_creation, COUNT(r.id) AS nb_produits
       FROM imports i LEFT JOIN receptions r ON r.import_id = i.id
       WHERE i.statut = 'en_attente' GROUP BY i.id ORDER BY i.date_creation`
    );
    const [produitsAttente] = await db.query(
      `SELECT r.id, r.import_id, r.type, r.taille_bobine, r.type_cosse, r.reference, r.lot, r.quantite - COALESCE(rc.quantite, 0) AS quantite,
              r.longueur, r.largeur, r.hauteur, r.poids
       FROM receptions r
       JOIN imports i ON i.id = r.import_id AND i.statut = 'en_attente'
       LEFT JOIN reclamations rc ON rc.reception_id = r.id`
    );
    const enPlace = [...stock.filter((l) => l.emplacement), ...(await placesReservees())];
    const importsAttente = enAttente.map((i) => {
      const produits = produitsAttente
        .filter((p) => p.import_id === i.id && p.quantite > 0)
        .map((p) => ({ ...p, longueur: p.longueur && Number(p.longueur), largeur: p.largeur && Number(p.largeur), hauteur: p.hauteur && Number(p.hauteur), poids: p.poids && Number(p.poids) }));
      const plan = produits.length ? R.proposerPlan(produits, enPlace, { capaciteTampon }) : [];
      return {
        ...i,
        sans_place: plan.filter((p) => !p.emplacement).reduce((s, p) => s + p.quantite, 0),
        vers_tampon: plan.filter((p) => R.estTampon(p.emplacement)).reduce((s, p) => s + p.quantite, 0),
      };
    });

    // ---------- Alertes ----------
    const alertes = [];
    for (const z of remplissage) {
      const t = z.taux / 100;
      const nom = z.cle === 'tampon' ? 'La zone tampon' : `Le stockage des ${z.libelle.toLowerCase()} (${z.detail.toLowerCase()})`;
      if (t >= SEUIL_CRITIQUE) alertes.push({ niveau: 'critique', message: `${nom} est rempli à ${z.taux} %`, lien: '/emplacements' });
      else if (t >= SEUIL_ALERTE) alertes.push({ niveau: 'attention', message: `${nom} est rempli à ${z.taux} %`, lien: '/emplacements' });
    }
    for (const i of importsAttente) {
      if (i.sans_place) {
        alertes.push({ niveau: 'critique', message: `Import n° ${i.id} bloqué : ${i.sans_place} produit(s) sans place, même en zone tampon`, lien: '/import' });
      } else if (i.vers_tampon) {
        alertes.push({ niveau: 'attention', message: `Import n° ${i.id} : ${i.vers_tampon} produit(s) iront en zone tampon (plus de place à leur niveau)`, lien: '/import' });
      }
    }
    if (tampon.produits) {
      alertes.push({ niveau: 'info', message: `${tampon.produits} produit(s) en zone tampon : « Ranger automatiquement » dès qu'une place se libère`, lien: '/stock' });
    }
    // Sorties urgentes : colis posé près de la porte mais pas encore sorti vers la production (en tête des alertes).
    // Après la durée d'une sortie préparée (2 h), le colis n'est plus réservé : il est devenu du stock normal.
    const [urgences] = await db.query(
      `SELECT u.colis, u.reference, u.destination, u.emplacement, m.matricule AS par, TIMESTAMPDIFF(MINUTE, u.date_posee, NOW()) AS minutes
       FROM sorties_urgentes u LEFT JOIN utilisateurs m ON m.id = u.utilisateur_id
       WHERE u.statut = 'posee' ORDER BY u.date_posee`
    );
    alertes.unshift(...urgences.map((u) => {
      const minutes = Math.max(0, Number(u.minutes));
      const vieux = minutes >= DUREE_MAX_MINUTES;
      return {
        niveau: vieux ? 'critique' : 'attention',
        message: avecNumeros(
          `Sortie urgente pas terminée : ${u.reference} colis n° ${u.colis} posé en ${u.emplacement} depuis ${duree(minutes)}, pas encore sorti vers ${u.destination}` +
          ` (magasinier ${u.par ?? '?'}).${vieux ? ' Il n’est plus réservé : sortez-le ou rangez-le.' : ''}`
        ),
        lien: '/import',
      };
    }));
    // Réclamations non réglées depuis plus de N jours
    const delai = await delaiReclamation();
    const [[suivi]] = await db.query(
      `SELECT SUM(statut = 'ouverte') AS ouvertes, SUM(statut = 'envoyee') AS envoyees, SUM(statut = 'reglee') AS reglees,
              SUM(statut <> 'reglee' AND DATEDIFF(CURDATE(), DATE(date_creation)) > ?) AS en_retard
       FROM reclamations`,
      [delai]
    );
    const enRetard = Number(suivi.en_retard ?? 0);
    if (enRetard) {
      alertes.push({ niveau: 'attention', message: `${enRetard} réclamation(s) non réglée(s) depuis plus de ${delai} jours`, lien: '/reclamations' });
    }
    if (sansEmplacement) {
      alertes.push({ niveau: 'attention', message: `${sansEmplacement} produit(s) en stock sans emplacement`, lien: '/stock' });
    }

    // ---------- Activité : aujourd'hui et 7 derniers jours ----------
    const [[aujourdhui]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM imports WHERE statut = 'ajoute' AND DATE(date_ajout_stock) = CURDATE()) AS imports,
         (SELECT COALESCE(SUM(r.quantite - COALESCE(rc.quantite, 0)), 0) FROM receptions r
            JOIN imports i ON i.id = r.import_id AND i.statut = 'ajoute' AND DATE(i.date_ajout_stock) = CURDATE()
            LEFT JOIN reclamations rc ON rc.reception_id = r.id) AS entres,
         (SELECT COUNT(*) FROM exports WHERE DATE(date_export) = CURDATE()) AS sorties,
         (SELECT COALESCE(SUM(quantite), 0) FROM exports WHERE DATE(date_export) = CURDATE()) AS sortis`
    );
    const [[semaine]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM imports WHERE statut = 'ajoute' AND date_ajout_stock >= CURDATE() - INTERVAL 6 DAY) AS imports,
         (SELECT COALESCE(SUM(r.quantite - COALESCE(rc.quantite, 0)), 0) FROM receptions r
            JOIN imports i ON i.id = r.import_id AND i.statut = 'ajoute' AND i.date_ajout_stock >= CURDATE() - INTERVAL 6 DAY
            LEFT JOIN reclamations rc ON rc.reception_id = r.id) AS entres,
         (SELECT COUNT(*) FROM exports WHERE date_export >= CURDATE() - INTERVAL 6 DAY) AS sorties,
         (SELECT COALESCE(SUM(quantite), 0) FROM exports WHERE date_export >= CURDATE() - INTERVAL 6 DAY) AS sortis`
    );
    // Par jour (7 derniers jours) : produits entrés et sortis
    const [entreesJour] = await db.query(
      `SELECT DATE_FORMAT(i.date_ajout_stock, '%Y-%m-%d') AS jour, SUM(r.quantite - COALESCE(rc.quantite, 0)) AS q
       FROM receptions r JOIN imports i ON i.id = r.import_id AND i.statut = 'ajoute'
       LEFT JOIN reclamations rc ON rc.reception_id = r.id
       WHERE i.date_ajout_stock >= CURDATE() - INTERVAL 6 DAY GROUP BY jour`
    );
    const [sortiesJour] = await db.query(
      `SELECT DATE_FORMAT(date_export, '%Y-%m-%d') AS jour, SUM(quantite) AS q
       FROM exports WHERE date_export >= CURDATE() - INTERVAL 6 DAY GROUP BY jour`
    );
    const [[{ auj }]] = await db.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS auj");
    const jours = [];
    for (let k = 6; k >= 0; k--) {
      const d = new Date(auj + 'T12:00:00');
      d.setDate(d.getDate() - k);
      const jour = d.toISOString().slice(0, 10);
      jours.push({
        jour,
        entres: Number(entreesJour.find((x) => x.jour === jour)?.q ?? 0),
        sortis: Number(sortiesJour.find((x) => x.jour === jour)?.q ?? 0),
      });
    }
    // Sorties par destination (7 derniers jours)
    const [destinations] = await db.query(
      `SELECT COALESCE(destination, 'Sans destination') AS destination, COUNT(*) AS sorties, SUM(quantite) AS quantite
       FROM exports WHERE date_export >= CURDATE() - INTERVAL 6 DAY
       GROUP BY destination ORDER BY destination`
    );

    // ---------- Réclamations (30 derniers jours) ----------
    const [parMotif] = await db.query(
      `SELECT motif, COUNT(*) AS produits, SUM(quantite) AS quantite
       FROM reclamations WHERE date_creation >= CURDATE() - INTERVAL 29 DAY GROUP BY motif`
    );
    const [dernieres] = await db.query(
      `SELECT rc.id, COALESCE(r.import_id, rc.import_id) AS import_id, COALESCE(r.reference, rc.reference) AS reference,
              COALESCE(r.lot, rc.lot) AS lot, r.type, rc.quantite, rc.motif,
              DATE_FORMAT(rc.date_creation, '%Y-%m-%dT%H:%i:%s') AS date
       FROM reclamations rc LEFT JOIN receptions r ON r.id = rc.reception_id
       ORDER BY rc.date_creation DESC, rc.id DESC LIMIT 5`
    );

    res.json({
      remplissage,
      alertes,
      imports_en_attente: importsAttente.length,
      activite: {
        aujourdhui: Object.fromEntries(Object.entries(aujourdhui).map(([k, v]) => [k, Number(v)])),
        semaine: Object.fromEntries(Object.entries(semaine).map(([k, v]) => [k, Number(v)])),
        jours,
        destinations: destinations.map((d) => ({ ...d, quantite: Number(d.quantite) })),
      },
      reclamations: {
        par_motif: parMotif.map((m) => ({ ...m, quantite: Number(m.quantite) })),
        suivi: {
          ouvertes: Number(suivi.ouvertes ?? 0),
          envoyees: Number(suivi.envoyees ?? 0),
          reglees: Number(suivi.reglees ?? 0),
          en_retard: enRetard,
          delai_jours: delai,
        },
        dernieres,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
