-- Migration 026 : inventaire initial du magasin (étude n° 2), par le chef de magasin ou l'administrateur.
-- Pour chaque emplacement : scan de son QR, puis du ticket de chaque produit posé dessus. À la validation,
-- le contenu de l'emplacement est remplacé par ce qui a été scanné. Les produits inventoriés sont rattachés
-- à un import « Inventaire » du jour ; le type vient du catalogue Articles.
-- Ajoute une table et une valeur ; aucune donnée existante n'est modifiée.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS inventaire_scans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket VARCHAR(80) NULL,                 -- identifiant du colis (« REF|lot-suffixe|n° ») ; NULL pour un ticket de lot
  qr_brut VARCHAR(500) NOT NULL,
  emplacement VARCHAR(10) NOT NULL,
  reception_id INT NOT NULL,               -- ligne de l'import « Inventaire »
  quantite INT NOT NULL DEFAULT 1,
  utilisateur_id INT NULL,
  date_scan DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  UNIQUE KEY uq_inventaire_ticket (ticket),
  INDEX idx_inventaire_emplacement (emplacement)
);

ALTER TABLE mouvements_emplacement
  MODIFY origine ENUM('deplacement', 'plan_import', 'automatique', 'regroupement', 'inventaire') NOT NULL;
