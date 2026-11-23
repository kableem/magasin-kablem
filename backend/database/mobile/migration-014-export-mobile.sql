-- Migration 014 : sortie vers la production préparée sur le mobile (export contrôlé)
-- À RELIRE avant de l'exécuter sur la base réelle (après la migration 013).
-- Ne modifie aucune table de l'application web : ajoute 2 tables et complète controles_mobile.
--
-- Déroulement : le magasinier demande « 3 × F0411 vers P1 ». L'API calcule les prélèvements
-- en FIFO (mêmes règles que le web) et les réserve. Il scanne chaque emplacement puis le ticket
-- du produit : bon emplacement + bon produit = prélèvement validé ; sinon alerte, journalisée.
-- Quand tout est validé, la sortie est enregistrée comme sur le web (exports + export_details)
-- et les produits quittent le stock.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS preparations_export (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid CHAR(36) NOT NULL,                        -- généré par le téléphone (pas de double préparation)
  reference VARCHAR(50) NOT NULL,
  quantite INT NOT NULL,
  destination VARCHAR(10) NOT NULL,              -- P1, P2, P3, CET, MCW
  statut ENUM('en_cours', 'terminee', 'annulee') NOT NULL DEFAULT 'en_cours',
  motif_fin VARCHAR(255) NULL,                   -- raison d'une annulation
  export_id INT NULL,                            -- sortie enregistrée à la fin
  utilisateur_id INT NULL,
  date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_fin DATETIME NULL,
  UNIQUE KEY uq_preparation_uuid (uuid),
  INDEX idx_preparation_statut (statut, date_creation),
  FOREIGN KEY (export_id) REFERENCES exports(id) ON DELETE SET NULL,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL
);

-- Un prélèvement imposé par le FIFO : tel lot, à tel emplacement, telle quantité
CREATE TABLE IF NOT EXISTS preparation_lignes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  preparation_id INT NOT NULL,
  ordre INT NOT NULL,                            -- ordre FIFO (1 = le plus ancien)
  placement_id INT NOT NULL,                     -- placement réservé (pas de clé étrangère : il disparaît à la sortie)
  reception_id INT NULL,
  lot VARCHAR(50) NOT NULL,
  date_reception DATETIME NOT NULL,
  emplacement VARCHAR(10) NULL,                  -- NULL = produit pas encore rangé
  quantite INT NOT NULL,
  valide TINYINT(1) NOT NULL DEFAULT 0,
  date_validation DATETIME NULL,
  FOREIGN KEY (preparation_id) REFERENCES preparations_export(id) ON DELETE CASCADE,
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE SET NULL,
  INDEX idx_ligne_placement (placement_id)
);

-- Les scans de la sortie sont journalisés avec les autres contrôles du mobile
ALTER TABLE controles_mobile
  MODIFY controle ENUM('reception', 'rangement', 'export') NOT NULL,
  MODIFY resultat ENUM(
    'conforme', 'ecart_quantite', 'inconnu', 'deja_traite', 'non_recu', 'import_en_attente',
    'bon_emplacement', 'faux_emplacement', 'emplacement_inconnu', 'ticket_illisible',
    'prelevement_ok',      -- export : bon emplacement + bon produit (lot imposé par le FIFO)
    'sortie_terminee',     -- export : dernier prélèvement validé, sortie enregistrée
    'mauvais_produit',     -- export : bon emplacement mais pas le produit / le lot attendu
    'stock_modifie',       -- export : le stock a changé pendant la préparation, sortie refusée
    'preparation_close'    -- export : préparation déjà terminée ou annulée
  ) NOT NULL,
  ADD COLUMN preparation_id INT NULL AFTER import_id,
  ADD CONSTRAINT fk_controle_preparation FOREIGN KEY (preparation_id) REFERENCES preparations_export(id) ON DELETE SET NULL;
