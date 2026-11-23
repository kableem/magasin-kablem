-- Migration 033 : l'administrateur peut sortir un autre produit que celui proposé par le FIFO (sortie mobile).
-- Le FIFO reste proposé à tous ; seul l'administrateur peut prendre un autre lot ou un autre emplacement
-- de la même référence. Ces prises sont marquées pour l'historique.
--   preparation_lignes.hors_fifo : prélèvement choisi par l'administrateur à la place du FIFO
--   exports.hors_fifo            : la sortie contient au moins une prise hors FIFO
-- N'ajoute que des colonnes : les sorties déjà enregistrées restent « FIFO ».
USE magasin_kablem;

ALTER TABLE preparation_lignes
  ADD COLUMN hors_fifo TINYINT(1) NOT NULL DEFAULT 0 AFTER valide;

ALTER TABLE exports
  ADD COLUMN hors_fifo TINYINT(1) NOT NULL DEFAULT 0 AFTER motif_force;
