-- Migration : réclamations sur les produits d'un import (anomalies à la réception).
-- À exécuter une seule fois.
USE magasin_kablem;

-- Une réclamation par produit d'import : la quantité réclamée n'entre pas dans le stock
CREATE TABLE IF NOT EXISTS reclamations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reception_id INT NOT NULL UNIQUE,
  quantite INT NOT NULL,
  motif ENUM('manquant', 'non_conforme', 'endommage', 'non_commande', 'autre') NOT NULL,
  commentaire VARCHAR(255) NULL,
  utilisateur_id INT NULL,
  date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  INDEX (date_creation),
  INDEX (motif)
);
