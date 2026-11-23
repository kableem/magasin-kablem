-- Migration 040 : cartons de cosses ouverts à l'export (décision du 2026-11-12).
-- Les niveaux du haut (3-4, et 4-5 du bloc E) reçoivent les connecteurs et les palettes de cartons de cosses NEUFS ;
-- les niveaux 1-2 (et 1-3 du bloc E) reçoivent les cosses séparées.
-- Dès qu'une cosse sort d'un carton, les cosses qui restent deviennent des cosses séparées : le magasinier doit
-- tout de suite les descendre sur une place de cosses séparées imposée (même référence et même lot, la plus proche
-- de la porte, sinon la place vide la plus proche de la porte), en scannant l'emplacement puis le ticket de chaque
-- cosse. Sa sortie suivante attend que ce soit fait. En haut, il ne reste donc jamais de carton entamé.
--   descentes_carton        : un carton ouvert à descendre (en cours, puis terminée)
--   descentes_carton_cosses : chaque cosse restante, son emplacement imposé, et quand elle a été posée
-- N'ajoute que deux tables : aucune donnée existante n'est modifiée.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS descentes_carton (
  id INT AUTO_INCREMENT PRIMARY KEY,
  carton_id INT NOT NULL,
  palette_cosses_id INT NULL,
  depuis VARCHAR(10) NULL,                       -- emplacement de la palette (en haut)
  preparation_id INT NULL,                       -- sortie qui a ouvert le carton
  export_id INT NULL,
  statut ENUM('en_cours', 'terminee') NOT NULL DEFAULT 'en_cours',
  utilisateur_id INT NULL,                       -- magasinier qui doit descendre les cosses
  date_debut DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_fin DATETIME NULL,
  INDEX idx_descente_statut (statut, utilisateur_id),
  FOREIGN KEY (carton_id) REFERENCES cartons(id) ON DELETE CASCADE,
  FOREIGN KEY (palette_cosses_id) REFERENCES palettes_cosses(id) ON DELETE SET NULL,
  FOREIGN KEY (preparation_id) REFERENCES preparations_export(id) ON DELETE SET NULL,
  FOREIGN KEY (export_id) REFERENCES exports(id) ON DELETE SET NULL,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS descentes_carton_cosses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  descente_id INT NOT NULL,
  ticket VARCHAR(80) NOT NULL,                   -- identifiant du colis (cosse) : « REF|lot-suffixe|n° »
  colis INT NULL,
  reception_id INT NOT NULL,
  reference VARCHAR(50) NOT NULL,
  lot VARCHAR(50) NOT NULL,
  emplacement VARCHAR(10) NULL,                  -- place de cosses séparées imposée
  pose_le DATETIME NULL,                         -- cosse posée (scannée) à cet emplacement
  UNIQUE KEY uq_descente_ticket (ticket),        -- une cosse ne descend qu'une fois
  FOREIGN KEY (descente_id) REFERENCES descentes_carton(id) ON DELETE CASCADE,
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE
);
