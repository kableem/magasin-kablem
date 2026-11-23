-- Migration : commentaire facultatif sur un produit d'import.
-- À exécuter une seule fois.
USE magasin_kablem;

ALTER TABLE receptions ADD COLUMN commentaire VARCHAR(255) NULL AFTER poids;
