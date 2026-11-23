-- Migration : connecteurs rangés par volume et poids (cartons de dimensions variables).
-- À exécuter une seule fois.
USE magasin_kablem;

-- Un carton de connecteurs = une ligne de réception (quantité 1) avec ses dimensions et son poids
ALTER TABLE receptions
  ADD COLUMN longueur DECIMAL(6,1) NULL AFTER quantite,  -- cm
  ADD COLUMN largeur DECIMAL(6,1) NULL AFTER longueur,   -- cm
  ADD COLUMN hauteur DECIMAL(6,1) NULL AFTER largeur,    -- cm
  ADD COLUMN poids DECIMAL(7,2) NULL AFTER hauteur;      -- kg

-- Limites d'une palette de connecteurs (modifiables par l'administrateur)
INSERT IGNORE INTO parametres (cle, valeur) VALUES
  ('connecteur_longueur', '120'),
  ('connecteur_largeur', '80'),
  ('connecteur_hauteur_n3', '100'),
  ('connecteur_hauteur_n4', '150'),
  ('connecteur_taux', '85'),
  ('connecteur_poids_max', '15');

-- Les anciens connecteurs (sans dimensions ni poids) sont supprimés ;
-- un import qui ne contenait que des connecteurs est supprimé aussi.
CREATE TEMPORARY TABLE imports_connecteurs AS
  SELECT DISTINCT import_id FROM receptions WHERE type = 'connecteur';
DELETE FROM receptions WHERE type = 'connecteur';
DELETE FROM imports
WHERE id IN (SELECT import_id FROM imports_connecteurs)
  AND id NOT IN (SELECT DISTINCT import_id FROM receptions);
DROP TEMPORARY TABLE imports_connecteurs;
