-- Migration 020 : catalogue des articles (matières premières) utilisés au magasin.
-- Rempli depuis le fichier « DESCRIPTION MP.xlsx » (scripts/importer-description-mp.js).
--   famille   : bobine, cosse ou connecteur (toutes les autres catégories du fichier)
--   categorie : libellé d'origine du fichier (BOBINE, COSSE, COMPOSANT PLASTIQUE, GCOR, NASTRO…)
-- N'ajoute qu'une table ; ne modifie aucune donnée existante.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS articles_mp (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(50) NOT NULL,
  famille ENUM('bobine', 'cosse', 'connecteur') NOT NULL,
  categorie VARCHAR(50) NOT NULL,
  date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_modification DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_article_reference (reference),
  INDEX idx_article_famille (famille, categorie)
);
