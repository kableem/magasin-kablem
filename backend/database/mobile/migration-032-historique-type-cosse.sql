-- Migration 032 : l'historique des changements du catalogue garde aussi le type des cosses (axiale / plat).
--   famille          : bobine (taille, en bobines par palette) ou cosse (type axiale / plat)
--   type_cosse_avant / type_cosse_apres : cosses seulement ; avant / apres restent pour les bobines
-- Ajoute des colonnes et rend « apres » facultatif ; les lignes existantes (bobines) ne changent pas.
USE magasin_kablem;

ALTER TABLE articles_changements_taille
  ADD COLUMN famille ENUM('bobine', 'cosse') NOT NULL DEFAULT 'bobine' AFTER reference,
  MODIFY apres TINYINT UNSIGNED NULL,
  ADD COLUMN type_cosse_avant ENUM('axiale', 'plat') NULL AFTER apres,
  ADD COLUMN type_cosse_apres ENUM('axiale', 'plat') NULL AFTER type_cosse_avant;
