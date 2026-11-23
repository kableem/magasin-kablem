-- Migration : une ligne de stock de quantité N = N produits identiques,
-- qui peuvent être répartis sur plusieurs emplacements (ex. 10 petites bobines → D000 ×6 + D001 ×4).
-- La colonne receptions.emplacement est remplacée par la table « placements ».
-- Les quantités en stock sont conservées ; elles repassent « non rangées »
-- et seront rangées à nouveau par le moteur (bouton « Ranger automatiquement »).
-- À exécuter une seule fois.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS placements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reception_id INT NOT NULL,
  emplacement VARCHAR(10) NULL,  -- ex. D011, place tampon T05, ou NULL (pas encore rangé)
  quantite INT NOT NULL,         -- nombre de produits de la ligne à cet emplacement
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_placement (reception_id, emplacement),
  INDEX idx_placement_emplacement (emplacement)
);

INSERT INTO placements (reception_id, emplacement, quantite)
SELECT r.id, NULL, r.quantite
FROM receptions r
JOIN imports i ON i.id = r.import_id AND i.statut = 'ajoute'
WHERE NOT EXISTS (SELECT 1 FROM placements p WHERE p.reception_id = r.id);

ALTER TABLE receptions DROP INDEX idx_emplacement, DROP COLUMN emplacement;
