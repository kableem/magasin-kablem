-- Migration 028 : les cosses se reçoivent aussi palette par palette (10 cosses au maximum par palette).
-- Une palette porte soit des bobines (une seule taille), soit des cosses : jamais les deux.
--   type : bobine ou cosse, fixé par le 1er colis scanné sur la palette
-- Ajoute une colonne ; les palettes déjà reçues (toutes des palettes de bobines) sont marquées « bobine ».
USE magasin_kablem;

ALTER TABLE palettes_reception
  ADD COLUMN type ENUM('bobine', 'cosse') NULL AFTER numero;

UPDATE palettes_reception SET type = 'bobine' WHERE type IS NULL AND taille IS NOT NULL;
