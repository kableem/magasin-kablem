-- Migration d'une base créée AVANT l'ajout des modules stock / import / export / emplacements.
-- (Une nouvelle installation n'en a pas besoin : schema.sql contient déjà tout.)
-- Ne supprime aucune donnée. À exécuter une seule fois.
USE magasin_kablem;

ALTER TABLE produits
  ADD COLUMN reference VARCHAR(50) NULL UNIQUE AFTER id,
  ADD COLUMN unite VARCHAR(20) NOT NULL DEFAULT 'pièce' AFTER description,
  ADD COLUMN seuil_min INT NOT NULL DEFAULT 0 AFTER unite;

CREATE TABLE IF NOT EXISTS emplacements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  zone VARCHAR(50) NOT NULL DEFAULT '',
  description VARCHAR(255) NULL,
  capacite INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock (
  produit_id INT NOT NULL,
  emplacement_id INT NOT NULL,
  quantite INT NOT NULL DEFAULT 0,
  PRIMARY KEY (produit_id, emplacement_id),
  FOREIGN KEY (produit_id) REFERENCES produits(id) ON DELETE CASCADE,
  FOREIGN KEY (emplacement_id) REFERENCES emplacements(id)
);

CREATE TABLE IF NOT EXISTS mouvements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('import', 'export') NOT NULL,
  produit_id INT NOT NULL,
  emplacement_id INT NOT NULL,
  quantite INT NOT NULL,
  document VARCHAR(100) NULL,
  tiers VARCHAR(150) NULL,
  lot VARCHAR(50) NULL,
  commentaire VARCHAR(255) NULL,
  utilisateur_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (produit_id) REFERENCES produits(id),
  FOREIGN KEY (emplacement_id) REFERENCES emplacements(id),
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  INDEX (type, created_at)
);

INSERT IGNORE INTO emplacements (code, zone, description) VALUES
  ('A-01', 'Rayonnage A', 'Niveau haut'), ('A-02', 'Rayonnage A', 'Niveau haut'), ('A-03', 'Rayonnage A', 'Niveau haut'),
  ('B-01', 'Rayonnage B', 'Niveau milieu'), ('B-02', 'Rayonnage B', 'Niveau milieu'), ('B-03', 'Rayonnage B', 'Niveau milieu'),
  ('C-01', 'Rayonnage C', 'Niveau bas'), ('C-02', 'Rayonnage C', 'Niveau bas'), ('C-03', 'Rayonnage C', 'Niveau bas'),
  ('QUAI-01', 'Réception', 'Zone de déchargement');

-- Les quantités déjà saisies sont rangées sur QUAI-01, avec un mouvement "Stock initial"
INSERT IGNORE INTO stock (produit_id, emplacement_id, quantite)
SELECT p.id, e.id, p.quantite FROM produits p JOIN emplacements e ON e.code = 'QUAI-01'
WHERE p.quantite > 0;

INSERT INTO mouvements (type, produit_id, emplacement_id, quantite, document, commentaire, utilisateur_id)
SELECT 'import', s.produit_id, s.emplacement_id, s.quantite, 'INIT', 'Stock initial', NULL
FROM stock s
WHERE NOT EXISTS (SELECT 1 FROM mouvements);
