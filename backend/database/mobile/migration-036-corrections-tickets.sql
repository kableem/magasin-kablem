-- Migration 036 : correction de la quantité d'un ticket faux à la réception (import par référence).
-- Le ticket vert annonce par exemple 5000 pièces alors que le colis en contient 3000 (ou plus que prévu) :
-- le magasinier corrige la quantité, l'application imprime une étiquette 115 × 75 mm avec le même QR
-- (seule la quantité change), collée sur l'ancien ticket. La correction n'est validée qu'au scan de
-- l'étiquette imprimée ; tant qu'elle ne l'est pas, la réception ne peut pas être terminée.
-- N'ajoute qu'une table : aucune donnée existante ne change.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS corrections_colis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_id INT NOT NULL,
  reception_id INT NULL,                         -- ligne référence + lot du colis
  ticket VARCHAR(120) NOT NULL,                  -- identifiant du colis : référence|lot-suffixe|n° de colis
  reference VARCHAR(50) NOT NULL,
  lot VARCHAR(60) NOT NULL,                      -- lot avec son suffixe (« 202614653-2 »)
  colis INT NOT NULL,
  pieces_ticket INT NOT NULL,                    -- quantité écrite sur le ticket d'origine
  pieces_reelles INT NOT NULL,                   -- quantité réelle du colis
  qr_origine VARCHAR(255) NOT NULL,
  qr_corrige VARCHAR(255) NOT NULL,              -- même QR, seule la quantité change
  statut ENUM('a_imprimer', 'validee') NOT NULL DEFAULT 'a_imprimer',
  utilisateur_id INT NULL,
  date_correction DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valide_par INT NULL,
  date_validation DATETIME NULL,
  UNIQUE KEY uq_correction_ticket (import_id, ticket),
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE SET NULL,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  FOREIGN KEY (valide_par) REFERENCES utilisateurs(id) ON DELETE SET NULL
);
