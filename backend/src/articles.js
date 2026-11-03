// Catalogue des articles du magasin : chaque référence appartient à une famille
// (bobine, cosse, connecteur) et à une catégorie (libellé du fichier « DESCRIPTION MP »).
// Toutes les catégories autres que BOBINE et COSSE sont des familles de connecteurs.

const FAMILLES = ['bobine', 'cosse', 'connecteur'];
const CATEGORIE_FIXE = { bobine: 'BOBINE', cosse: 'COSSE' };

// Famille d'une catégorie du fichier (BOBINE → bobine, COSSE → cosse, le reste → connecteur)
function familleDe(categorie) {
  const c = String(categorie ?? '').trim().toUpperCase();
  if (c === 'BOBINE') return 'bobine';
  if (c === 'COSSE') return 'cosse';
  return 'connecteur';
}

// Taille d'une bobine d'après le nombre de bobines par palette (1 grande, 2 moyennes, 6 petites)
const TAILLE_PAR_PALETTE = { 1: 'grande', 2: 'moyenne', 6: 'petite' };
const tailleDeBobine = (parPalette) => TAILLE_PAR_PALETTE[parPalette] ?? 'petite';

// Type d'une cosse (fichier « Copie de cosses » du magasin)
const TYPES_COSSE = ['axiale', 'plat'];

// Contrôle et normalise un article ; renvoie { article } ou { erreur }
function lireArticle(corps) {
  const reference = String(corps?.reference ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  const famille = String(corps?.famille ?? '').trim();
  if (!reference) return { erreur: 'La référence est obligatoire' };
  if (reference.length > 50) return { erreur: 'La référence ne doit pas dépasser 50 caractères' };
  if (!FAMILLES.includes(famille)) return { erreur: 'Choisissez la famille : bobine, cosse ou connecteur' };
  if (famille === 'bobine') {
    const parPalette = Number(corps?.bobines_par_palette ?? 6);
    if (!TAILLE_PAR_PALETTE[parPalette]) return { erreur: 'Choisissez la taille : petite (6 par palette), moyenne (2) ou grande (1)' };
    return { article: { reference, famille, categorie: 'BOBINE', bobines_par_palette: parPalette, type_cosse: null } };
  }
  if (famille === 'cosse') {
    const typeCosse = corps?.type_cosse || null;
    if (typeCosse && !TYPES_COSSE.includes(typeCosse)) return { erreur: 'Choisissez le type de la cosse : axiale ou plat' };
    return { article: { reference, famille, categorie: 'COSSE', bobines_par_palette: null, type_cosse: typeCosse } };
  }
  let categorie = CATEGORIE_FIXE[famille];
  if (!categorie) {
    categorie = String(corps?.categorie ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (!categorie) return { erreur: 'Indiquez la famille de connecteur (ex. GCOR, NASTRO, COMPOSANT PLASTIQUE)' };
    if (categorie.length > 50) return { erreur: 'La famille de connecteur ne doit pas dépasser 50 caractères' };
    if (categorie === 'BOBINE' || categorie === 'COSSE') return { erreur: `${categorie} est une famille à part, pas un connecteur` };
  }
  return { article: { reference, famille, categorie, bobines_par_palette: null, type_cosse: null } };
}

// Référence telle qu'enregistrée au catalogue (majuscules, espaces simples)
const normaliserReference = (r) => String(r ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

// Type de produit d'après le catalogue, pour chaque référence connue.
// La taille d'une bobine vient du nombre de bobines par palette (petite si inconnu) ;
// le type d'une cosse (axiale ou plat) vient du catalogue (plat si inconnu).
async function typesDuCatalogue(connexion, references) {
  const refs = [...new Set(references.map(normaliserReference).filter(Boolean))];
  const types = new Map();
  if (!refs.length) return types;
  const [lignes] = await connexion.query('SELECT reference, famille, bobines_par_palette, type_cosse FROM articles_mp WHERE reference IN (?)', [refs]);
  for (const l of lignes) {
    types.set(normaliserReference(l.reference), {
      type: l.famille,
      taille_bobine: l.famille === 'bobine' ? tailleDeBobine(l.bobines_par_palette) : null,
      type_cosse: l.famille === 'cosse' ? (l.type_cosse ?? 'plat') : null,
    });
  }
  return types;
}

module.exports = { FAMILLES, TAILLE_PAR_PALETTE, TYPES_COSSE, familleDe, lireArticle, normaliserReference, tailleDeBobine, typesDuCatalogue };
