-- Migration : un import (arrivage) regroupe plusieurs produits.
-- Avant : chaque ligne de "receptions" était un import isolé.
-- Après : table "imports" (en attente / ajouté au stock) + receptions.import_id.
-- Les lignes existantes sont regroupées en un import par jour, déjà ajouté au stock.
-- À exécuter une seule fois. Ne supprime aucune donnée.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS imports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  statut ENUM('en_attente', 'ajoute') NOT NULL DEFAULT 'en_attente',
  date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_ajout_stock DATETIME NULL,
  cree_par INT NULL,
  ajoute_par INT NULL,
  FOREIGN KEY (cree_par) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  FOREIGN KEY (ajoute_par) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  INDEX (date_creation)
);

ALTER TABLE receptions ADD COLUMN import_id INT NULL AFTER id;

-- Un import par jour de réception existant
INSERT INTO imports (statut, date_creation, date_ajout_stock, cree_par, ajoute_par)
SELECT 'ajoute', MIN(date_reception), MIN(date_reception), MIN(utilisateur_id), MIN(utilisateur_id)
FROM receptions
GROUP BY DATE(date_reception);

UPDATE receptions r
JOIN imports i ON DATE(i.date_creation) = DATE(r.date_reception)
SET r.import_id = i.id;

ALTER TABLE receptions
  MODIFY import_id INT NOT NULL,
  ADD CONSTRAINT fk_receptions_import FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE;
