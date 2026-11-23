-- Migration 030 : type des cosses au catalogue des articles (fichier « Copie de cosses » du magasin).
--   type_cosse : axiale ou plat (cosses seulement)
-- Ajoute une colonne facultative ; ne modifie aucune donnée existante.
USE magasin_kablem;

ALTER TABLE articles_mp
  ADD COLUMN type_cosse ENUM('axiale', 'plat') NULL AFTER bobines_par_palette;
