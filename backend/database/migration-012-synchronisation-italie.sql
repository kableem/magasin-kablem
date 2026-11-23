-- Migration : les imports viennent de la base de l'Italie (synchronisation).
-- En attendant l'accès à la vraie base italienne, on la simule avec deux tables « italie_* »
-- dans la même base : on y insère les imports et leurs produits, puis « Synchroniser »
-- dans l'application les copie dans les imports en attente.
-- À exécuter une seule fois.
USE magasin_kablem;

-- Imports envoyés par l'Italie (un envoi = un import)
CREATE TABLE IF NOT EXISTS italie_imports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  numero VARCHAR(50) NOT NULL UNIQUE,          -- n° de livraison (ex. LIV-2026-0457)
  date_envoi DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  commentaire VARCHAR(255) NULL
);

-- Produits de chaque import italien (même format que les produits d'un import)
-- Connecteur : une ligne par carton (quantite = 1) avec ses dimensions (cm) et son poids (kg) ;
-- une ligne de quantite N donne N cartons identiques.
CREATE TABLE IF NOT EXISTS italie_produits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  italie_import_id INT NOT NULL,
  type ENUM('bobine', 'cosse', 'connecteur') NOT NULL,
  taille_bobine ENUM('grande', 'moyenne', 'petite') NULL,  -- obligatoire pour une bobine
  reference VARCHAR(50) NOT NULL,
  lot VARCHAR(50) NOT NULL,
  quantite INT NOT NULL,
  longueur DECIMAL(6,1) NULL,
  largeur DECIMAL(6,1) NULL,
  hauteur DECIMAL(6,1) NULL,
  poids DECIMAL(7,2) NULL,
  FOREIGN KEY (italie_import_id) REFERENCES italie_imports(id) ON DELETE CASCADE
);

-- Lien : un import de l'application vient d'un import italien (jamais copié deux fois)
ALTER TABLE imports
  ADD COLUMN source_id INT NULL UNIQUE AFTER id,
  ADD COLUMN numero_livraison VARCHAR(50) NULL AFTER source_id,
  ADD COLUMN date_envoi DATETIME NULL AFTER numero_livraison;
