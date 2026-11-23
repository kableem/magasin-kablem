-- Migration 027 : taille des bobines au catalogue des articles, et historique de ses changements.
--   bobines_par_palette : nombre de bobines de cette référence sur une palette
--                         (1 grande, 2 moyennes, 6 petites) : taille donnée aux prochains imports
-- Ajoute une colonne facultative et une table ; ne modifie aucune donnée existante.
USE magasin_kablem;

ALTER TABLE articles_mp
  ADD COLUMN bobines_par_palette TINYINT UNSIGNED NULL AFTER categorie;

-- Changement de taille d'une référence de bobine (qui, quand, avant → après)
CREATE TABLE IF NOT EXISTS articles_changements_taille (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(50) NOT NULL,
  avant TINYINT UNSIGNED NULL,                  -- bobines par palette avant
  apres TINYINT UNSIGNED NOT NULL,              -- bobines par palette après
  utilisateur_id INT NULL,
  date_changement DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_changement_reference (reference, date_changement),
  INDEX idx_changement_date (date_changement),
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL
);
