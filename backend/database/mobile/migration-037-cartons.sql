-- Migration 037 : cosses plates reçues en cartons.
-- Un import arrive soit en cosses séparées (comme avant), soit en cartons (question posée au 1er scan).
-- Un carton contient des cosses d'une seule référence et d'un seul lot, chacune avec son ticket vert.
-- À la réception, on scanne les tickets du carton puis « Terminer le carton » ; sur le web, on imprime
-- l'étiquette du carton (référence ; lot ; pièces ; date système à la milliseconde, qui rend le QR unique).
-- Au rangement, l'étiquette du carton puis l'emplacement : tout le carton entre au stock, seul sur cet
-- emplacement. À l'export, on scanne le ticket vert de chaque cosse prise.
--   imports.emballage          : 'separe' ou 'carton' (NULL tant que la question n'est pas posée)
--   cartons                    : un carton d'un import
--   controles_mobile.carton_id : cosse scannée dans ce carton
--   placements.carton_id       : stock rangé dans ce carton (le carton est seul sur son emplacement)
-- N'ajoute que des colonnes et une table : aucune donnée existante ne change.
USE magasin_kablem;

ALTER TABLE imports
  ADD COLUMN emballage ENUM('separe', 'carton') NULL AFTER mode;

CREATE TABLE IF NOT EXISTS cartons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_id INT NOT NULL,
  numero INT NOT NULL,                          -- n° du carton dans l'import
  reference VARCHAR(50) NULL,                   -- fixés par la 1re cosse scannée
  lot VARCHAR(60) NULL,
  statut ENUM('ouvert', 'termine', 'range') NOT NULL DEFAULT 'ouvert',
  date_etiquette DATETIME(3) NULL,              -- date système de la 1re impression : rend le QR unique
  emplacement VARCHAR(10) NULL,                 -- emplacement où il a été rangé
  ouvert_par INT NULL,
  date_ouverture DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_termine DATETIME NULL,
  date_rangement DATETIME NULL,
  UNIQUE KEY uq_carton_numero (import_id, numero),
  UNIQUE KEY uq_carton_etiquette (date_etiquette),
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  FOREIGN KEY (ouvert_par) REFERENCES utilisateurs(id) ON DELETE SET NULL
);

ALTER TABLE controles_mobile
  ADD COLUMN carton_id INT NULL AFTER palette_id,
  ADD INDEX idx_controle_carton (carton_id),
  ADD CONSTRAINT fk_controle_carton FOREIGN KEY (carton_id) REFERENCES cartons(id) ON DELETE SET NULL;

ALTER TABLE placements
  ADD COLUMN carton_id INT NULL AFTER quantite,
  ADD INDEX idx_placement_carton (carton_id),
  ADD CONSTRAINT fk_placement_carton FOREIGN KEY (carton_id) REFERENCES cartons(id) ON DELETE SET NULL;
