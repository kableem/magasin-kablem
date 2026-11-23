-- Migration 041 : palettes de connecteurs (décision du 2026-11-13).
-- Les connecteurs arrivent chacun dans un carton (ticket vert de l'Italie), les cartons sur une palette, comme les
-- cartons de cosses : on réutilise les palettes de cosses, avec leur famille (cosse ou connecteur, jamais mélangées).
-- Pendant une réception, un magasinier peut descendre une palette de connecteurs du magasin pour la compléter avec
-- les cartons de l'import, puis la remettre à sa place (une seule palette descendue à la fois).
--   palettes_cosses.famille            : 'cosse' ou 'connecteur' (NULL : palette ouverte encore vide)
--   palettes_cosses.descendue_par      : magasinier qui a descendu la palette pour la compléter (NULL : à sa place)
--   palettes_cosses.descendue_import   : import dont les cartons s'ajoutent à cette palette
--   palettes_cosses.descendue_le       : depuis quand
-- Le stock de connecteurs déjà rangé devient des palettes : une palette par emplacement (rien n'est supprimé).
USE magasin_kablem;

ALTER TABLE palettes_cosses
  ADD COLUMN famille ENUM('cosse', 'connecteur') NULL AFTER numero,
  ADD COLUMN descendue_par INT NULL,
  ADD COLUMN descendue_import INT NULL,
  ADD COLUMN descendue_le DATETIME NULL,
  ADD CONSTRAINT fk_palette_descendue_par FOREIGN KEY (descendue_par) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_palette_descendue_import FOREIGN KEY (descendue_import) REFERENCES imports(id) ON DELETE SET NULL;

UPDATE palettes_cosses SET famille = 'cosse' WHERE famille IS NULL;

-- Connecteurs déjà rangés : une palette par emplacement, rattachée à l'import le plus ancien de cet emplacement
INSERT INTO palettes_cosses (import_id, numero, famille, statut, emplacement, date_terminee, date_rangee)
SELECT x.import_id,
       COALESCE(m.dernier, 0) + ROW_NUMBER() OVER (PARTITION BY x.import_id ORDER BY x.emplacement),
       'connecteur', 'rangee', x.emplacement, NOW(), NOW()
FROM (
  SELECT p.emplacement, MIN(r.import_id) AS import_id
  FROM placements p JOIN receptions r ON r.id = p.reception_id
  WHERE r.type = 'connecteur' AND p.palette_cosses_id IS NULL AND p.quantite > 0 AND p.emplacement IS NOT NULL
  GROUP BY p.emplacement
) x
LEFT JOIN (SELECT import_id, MAX(numero) AS dernier FROM palettes_cosses GROUP BY import_id) m ON m.import_id = x.import_id;

UPDATE placements p
JOIN receptions r ON r.id = p.reception_id
JOIN palettes_cosses pc ON pc.emplacement = p.emplacement AND pc.famille = 'connecteur' AND pc.statut = 'rangee'
SET p.palette_cosses_id = pc.id
WHERE r.type = 'connecteur' AND p.palette_cosses_id IS NULL AND p.quantite > 0;
