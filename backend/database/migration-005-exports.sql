-- Migration : sorties de stock (export vers la production), en FIFO obligatoire.
-- À exécuter une seule fois.
USE magasin_kablem;

-- Une sortie : une quantité d'une référence, prise automatiquement en FIFO
CREATE TABLE IF NOT EXISTS exports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date_export DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reference VARCHAR(50) NOT NULL,
  type ENUM('bobine', 'cosse', 'connecteur') NOT NULL,
  taille_bobine ENUM('grande', 'moyenne', 'petite') NULL,
  quantite INT NOT NULL,
  destination VARCHAR(150) NULL,  -- P1, P2 ou P3 (obligatoire, contrôlé par l'API)
  utilisateur_id INT NULL,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  INDEX (date_export),
  INDEX (reference)
);

-- Détail : d'où viennent les produits sortis (lot, date de réception, emplacement)
CREATE TABLE IF NOT EXISTS export_details (
  id INT AUTO_INCREMENT PRIMARY KEY,
  export_id INT NOT NULL,
  reception_id INT NULL,
  lot VARCHAR(50) NOT NULL,
  date_reception DATETIME NOT NULL,
  emplacement VARCHAR(10) NULL,
  quantite INT NOT NULL,
  FOREIGN KEY (export_id) REFERENCES exports(id) ON DELETE CASCADE,
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE SET NULL
);
