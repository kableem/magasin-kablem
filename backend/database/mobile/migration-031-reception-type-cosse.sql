-- Migration 031 : type de cosse (axiale / plat) sur chaque ligne d'import, comme la taille d'une bobine.
-- Les cosses plates : 10 au maximum par palette, reçues palette par palette ;
-- les cosses axiales (petites) : 4 au maximum, sur la même palette que les plates, reçues une par une.
-- Ajoute une colonne ; les lignes de cosses existantes prennent le type du catalogue Articles.
USE magasin_kablem;

ALTER TABLE receptions
  ADD COLUMN type_cosse ENUM('axiale', 'plat') NULL AFTER taille_bobine;

UPDATE receptions r JOIN articles_mp a ON a.reference = r.reference AND a.famille = 'cosse'
SET r.type_cosse = COALESCE(a.type_cosse, 'plat')
WHERE r.type = 'cosse' AND r.type_cosse IS NULL;
