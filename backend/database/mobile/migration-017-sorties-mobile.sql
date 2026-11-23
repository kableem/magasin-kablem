-- Migration 017 : les sorties vers la production se font par le mobile (FIFO contrôlé au scan)
-- Une sortie faite depuis le web est un secours (administrateur, chef) avec un motif obligatoire.
-- N'ajoute que des colonnes : les sorties déjà enregistrées sont marquées « web ».
USE magasin_kablem;

ALTER TABLE exports
  ADD COLUMN origine ENUM('web', 'mobile', 'web_secours') NOT NULL DEFAULT 'web' AFTER destination,
  ADD COLUMN motif_force VARCHAR(255) NULL AFTER origine;
