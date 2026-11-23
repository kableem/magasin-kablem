-- Migration 038 : palettes de cosses (décision du 2026-11-10).
-- Une palette porte plusieurs cartons de cosses (références mélangées possibles) et aussi des cosses
-- séparées ; elle se range entière sur un emplacement vide. Pas d'étiquette palette : au rangement, on scanne
-- l'étiquette de n'importe quel carton (ou le ticket d'une cosse) de la palette, puis l'emplacement.
-- Une fois rangée, rien ne s'ajoute sur son emplacement ; les cosses sortent une par une à l'export.
--   palettes_cosses                       : une palette de cosses d'un import (n° 1, 2… dans l'import)
--   cartons.palette_id                    : palette qui porte ce carton (un carton est toujours sur une palette)
--   controles_mobile.palette_cosses_id    : cosse reçue sur cette palette (dans un carton ou séparée)
--   placements.palette_cosses_id          : stock rangé avec cette palette (son emplacement lui est réservé)
-- N'ajoute qu'une table et des colonnes. Chaque carton déjà existant devient une palette d'un seul carton
-- (même numéro, même état) : aucune donnée existante n'est supprimée.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS palettes_cosses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_id INT NOT NULL,
  numero INT NOT NULL,                                     -- palette 1, 2, 3… de l'import
  statut ENUM('ouverte', 'terminee', 'rangee') NOT NULL DEFAULT 'ouverte',
  emplacement VARCHAR(10) NULL,                            -- emplacement où elle est rangée
  ouverte_par INT NULL,
  date_ouverture DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_terminee DATETIME NULL,
  date_rangee DATETIME NULL,
  UNIQUE KEY uq_palette_cosses_numero (import_id, numero),
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  FOREIGN KEY (ouverte_par) REFERENCES utilisateurs(id) ON DELETE SET NULL
);

ALTER TABLE cartons
  ADD COLUMN palette_id INT NULL AFTER import_id,
  ADD INDEX idx_carton_palette (palette_id),
  ADD CONSTRAINT fk_carton_palette FOREIGN KEY (palette_id) REFERENCES palettes_cosses(id) ON DELETE SET NULL;

ALTER TABLE controles_mobile
  ADD COLUMN palette_cosses_id INT NULL AFTER carton_id,
  ADD INDEX idx_controle_palette_cosses (palette_cosses_id),
  ADD CONSTRAINT fk_controle_palette_cosses FOREIGN KEY (palette_cosses_id) REFERENCES palettes_cosses(id) ON DELETE SET NULL;

ALTER TABLE placements
  ADD COLUMN palette_cosses_id INT NULL AFTER carton_id,
  ADD INDEX idx_placement_palette_cosses (palette_cosses_id),
  ADD CONSTRAINT fk_placement_palette_cosses FOREIGN KEY (palette_cosses_id) REFERENCES palettes_cosses(id) ON DELETE SET NULL;

-- Cartons existants : une palette d'un seul carton chacun (palette n° = carton n° dans l'import)
INSERT INTO palettes_cosses (import_id, numero, statut, emplacement, ouverte_par, date_ouverture, date_terminee, date_rangee)
SELECT c.import_id, c.numero,
       CASE c.statut WHEN 'ouvert' THEN 'ouverte' WHEN 'termine' THEN 'terminee' ELSE 'rangee' END,
       c.emplacement, c.ouvert_par, c.date_ouverture, c.date_termine, c.date_rangement
FROM cartons c
WHERE c.palette_id IS NULL;

UPDATE cartons c JOIN palettes_cosses p ON p.import_id = c.import_id AND p.numero = c.numero
SET c.palette_id = p.id
WHERE c.palette_id IS NULL;

UPDATE controles_mobile x JOIN cartons c ON c.id = x.carton_id
SET x.palette_cosses_id = c.palette_id
WHERE x.palette_cosses_id IS NULL AND c.palette_id IS NOT NULL;

UPDATE placements p JOIN cartons c ON c.id = p.carton_id
SET p.palette_cosses_id = c.palette_id
WHERE p.palette_cosses_id IS NULL AND c.palette_id IS NOT NULL;
