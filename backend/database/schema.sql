-- Base de données du projet Magasin Kablem
CREATE DATABASE IF NOT EXISTS magasin_kablem CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nom VARCHAR(100) NOT NULL UNIQUE
);

-- Articles du magasin (la quantité est le total de tous les emplacements,
-- elle n'est modifiée que par les mouvements d'import / export)
CREATE TABLE IF NOT EXISTS produits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(50) NULL UNIQUE,
  nom VARCHAR(150) NOT NULL,
  description TEXT,
  unite VARCHAR(20) NOT NULL DEFAULT 'pièce',
  seuil_min INT NOT NULL DEFAULT 0,
  prix DECIMAL(10,2) NOT NULL DEFAULT 0,
  quantite INT NOT NULL DEFAULT 0,
  categorie_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (categorie_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- Utilisateurs (connexion à l'application)
CREATE TABLE IF NOT EXISTS utilisateurs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  matricule VARCHAR(50) NOT NULL UNIQUE,
  nom VARCHAR(100) NOT NULL,
  prenom VARCHAR(100) NOT NULL,
  mot_de_passe VARCHAR(255) NOT NULL,
  role ENUM('admin', 'chef_magasin', 'magasinier') NOT NULL DEFAULT 'magasinier',
  actif TINYINT(1) NOT NULL DEFAULT 1,
  derniere_connexion TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Emplacements physiques du magasin (rayonnage-niveau-colonne, quai…)
CREATE TABLE IF NOT EXISTS emplacements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  zone VARCHAR(50) NOT NULL DEFAULT '',
  description VARCHAR(255) NULL,
  capacite INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Quantité de chaque article par emplacement
CREATE TABLE IF NOT EXISTS stock (
  produit_id INT NOT NULL,
  emplacement_id INT NOT NULL,
  quantite INT NOT NULL DEFAULT 0,
  PRIMARY KEY (produit_id, emplacement_id),
  FOREIGN KEY (produit_id) REFERENCES produits(id) ON DELETE CASCADE,
  FOREIGN KEY (emplacement_id) REFERENCES emplacements(id)
);

-- Historique des entrées (import) et sorties (export)
CREATE TABLE IF NOT EXISTS mouvements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('import', 'export') NOT NULL,
  produit_id INT NOT NULL,
  emplacement_id INT NOT NULL,
  quantite INT NOT NULL,
  document VARCHAR(100) NULL,   -- N° bon de livraison / bon de sortie
  tiers VARCHAR(150) NULL,      -- fournisseur (import) ou destination (export)
  lot VARCHAR(50) NULL,
  commentaire VARCHAR(255) NULL,
  utilisateur_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (produit_id) REFERENCES produits(id),
  FOREIGN KEY (emplacement_id) REFERENCES emplacements(id),
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  INDEX (type, created_at)
);

-- ---------- Données de départ ----------

-- Compte administrateur par défaut : admin / admin
INSERT IGNORE INTO utilisateurs (id, matricule, nom, prenom, mot_de_passe, role) VALUES
  (1, 'admin', 'Administrateur', 'Magasin', '$2b$10$cMR/liSl1.OYKZ9F/IL9Ges4pNaJg8iiCfe.nFM/xgoIsmxkZwF6y', 'admin');

INSERT IGNORE INTO categories (id, nom) VALUES
  (1, 'Fils & câbles'), (2, 'Connecteurs'), (3, 'Terminaux'), (4, 'Gaines & protections'), (5, 'Rubans & adhésifs');

INSERT IGNORE INTO emplacements (id, code, zone, description) VALUES
  (1, 'A-01', 'Rayonnage A', 'Niveau haut'), (2, 'A-02', 'Rayonnage A', 'Niveau haut'), (3, 'A-03', 'Rayonnage A', 'Niveau haut'),
  (4, 'B-01', 'Rayonnage B', 'Niveau milieu'), (5, 'B-02', 'Rayonnage B', 'Niveau milieu'), (6, 'B-03', 'Rayonnage B', 'Niveau milieu'),
  (7, 'C-01', 'Rayonnage C', 'Niveau bas'), (8, 'C-02', 'Rayonnage C', 'Niveau bas'), (9, 'C-03', 'Rayonnage C', 'Niveau bas'),
  (10, 'QUAI-01', 'Réception', 'Zone de déchargement');

INSERT IGNORE INTO produits (id, reference, nom, description, unite, seuil_min, prix, quantite, categorie_id) VALUES
  (1, 'FLRY-035-RD', 'Fil FLRY-B 0,35 mm² rouge', 'Fil automobile basse tension', 'm', 500, 0.08, 2500, 1),
  (2, 'FLRY-050-BK', 'Fil FLRY-B 0,50 mm² noir', 'Fil automobile basse tension', 'm', 500, 0.10, 1800, 1),
  (3, 'CON-2V-ETA', 'Connecteur 2 voies étanche', 'Boîtier femelle avec joint', 'pièce', 200, 0.45, 640, 2),
  (4, 'TRM-F-28', 'Cosse femelle 2,8 mm', 'Terminal à sertir', 'pièce', 1000, 0.03, 5200, 3),
  (5, 'GAI-ANN-10', 'Gaine annelée Ø10', 'Protection de faisceau', 'm', 100, 0.25, 80, 4),
  (6, 'RUB-PVC-19', 'Ruban adhésif PVC 19 mm', 'Rouleau 20 m', 'rouleau', 50, 1.20, 0, 5);

INSERT IGNORE INTO stock (produit_id, emplacement_id, quantite) VALUES
  (1, 1, 2500), (2, 1, 1000), (2, 4, 800), (3, 3, 640), (4, 5, 5200), (5, 7, 80);

INSERT INTO mouvements (type, produit_id, emplacement_id, quantite, document, tiers, commentaire, utilisateur_id)
SELECT 'import', s.produit_id, s.emplacement_id, s.quantite, 'INIT', NULL, 'Stock initial', 1
FROM stock s
WHERE NOT EXISTS (SELECT 1 FROM mouvements);

-- Imports (arrivages) : un import regroupe plusieurs produits.
-- En attente : on peut encore ajouter / retirer des produits.
-- Ajouté au stock : verrouillé, ses produits sont dans Gestion de stock (historique).
CREATE TABLE IF NOT EXISTS imports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source_id INT NULL UNIQUE,              -- import italien d'origine (synchronisation)
  numero_livraison VARCHAR(50) NULL,     -- n° de livraison de l'Italie
  date_envoi DATETIME NULL,              -- date d'envoi par l'Italie
  statut ENUM('en_attente', 'ajoute') NOT NULL DEFAULT 'en_attente',
  date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_ajout_stock DATETIME NULL,
  cree_par INT NULL,
  ajoute_par INT NULL,
  FOREIGN KEY (cree_par) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  FOREIGN KEY (ajoute_par) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  INDEX (date_creation)
);

-- Produits d'un import ; une fois l'import ajouté au stock, chaque ligne est une palette du stock
CREATE TABLE IF NOT EXISTS receptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_id INT NOT NULL,
  type ENUM('bobine', 'cosse', 'connecteur') NOT NULL,
  taille_bobine ENUM('grande', 'moyenne', 'petite') NULL,  -- obligatoire pour une bobine
  reference VARCHAR(50) NOT NULL,
  lot VARCHAR(50) NOT NULL,
  date_reception DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- date système de l'ajout au stock
  quantite INT NOT NULL,
  -- Connecteurs : une ligne = un carton (quantité 1), avec ses dimensions et son poids
  longueur DECIMAL(6,1) NULL,  -- cm
  largeur DECIMAL(6,1) NULL,   -- cm
  hauteur DECIMAL(6,1) NULL,   -- cm
  poids DECIMAL(7,2) NULL,     -- kg
  commentaire VARCHAR(255) NULL,  -- facultatif, saisi à l'import
  utilisateur_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  INDEX (date_reception),
  INDEX (reference)
);

-- Emplacements des produits en stock : une ligne de quantité N (N produits identiques)
-- peut être répartie sur plusieurs emplacements (ex. 10 petites bobines → D000 ×6 + D001 ×4).
-- 1 emplacement = 1 palette : 1 grande bobine, 2 moyennes ou 6 petites ; 1 palette de cosses / connecteurs.
CREATE TABLE IF NOT EXISTS placements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reception_id INT NOT NULL,
  emplacement VARCHAR(10) NULL,  -- ex. D011, place tampon T05, ou NULL (pas encore rangé)
  quantite INT NOT NULL,
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_placement (reception_id, emplacement),
  INDEX idx_placement_emplacement (emplacement)
);

-- ---------- Base de l'Italie (simulée) : source des imports ----------
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

-- ---------- Historique des changements d'emplacement ----------
CREATE TABLE IF NOT EXISTS mouvements_emplacement (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date_mouvement DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- deplacement : changé à la main dans Gestion de stock ; plan_import : plan de rangement modifié à l'import ;
  -- automatique : « Ranger automatiquement » (zone tampon -> rayonnage)
  origine ENUM('deplacement', 'plan_import', 'automatique') NOT NULL,
  reception_id INT NULL,
  reference VARCHAR(50) NOT NULL,
  lot VARCHAR(50) NOT NULL,
  type ENUM('bobine', 'cosse', 'connecteur') NOT NULL,
  taille_bobine ENUM('grande', 'moyenne', 'petite') NULL,
  quantite INT NOT NULL,
  depuis VARCHAR(10) NULL,  -- ancien emplacement (ou emplacement proposé pour un plan d'import)
  vers VARCHAR(10) NULL,    -- nouvel emplacement (NULL = retiré)
  motif ENUM('palette_abimee', 'regroupement', 'rapprocher_porte', 'erreur_rangement', 'emplacement_bloque', 'autre') NULL,
  commentaire VARCHAR(255) NULL,
  utilisateur_id INT NULL,
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE SET NULL,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  INDEX (date_mouvement),
  INDEX (reference),
  INDEX (depuis),
  INDEX (vers)
);

-- ---------- Réclamations (anomalies à la réception d'un import) ----------
-- Une réclamation par produit d'import : la quantité réclamée n'entre pas dans le stock
CREATE TABLE IF NOT EXISTS reclamations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reception_id INT NOT NULL UNIQUE,
  quantite INT NOT NULL,
  motif ENUM('manquant', 'non_conforme', 'endommage', 'non_commande', 'autre') NOT NULL,
  commentaire VARCHAR(255) NULL,
  -- Suivi avec le fournisseur : ouverte -> envoyée à l'Italie -> réglée
  statut ENUM('ouverte', 'envoyee', 'reglee') NOT NULL DEFAULT 'ouverte',
  date_envoi DATETIME NULL,
  date_reglement DATETIME NULL,
  solution ENUM('avoir', 'renvoi', 'remplacement', 'autre') NULL,
  note_suivi VARCHAR(255) NULL,
  suivi_par INT NULL,
  date_suivi DATETIME NULL,
  utilisateur_id INT NULL,
  date_creation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  FOREIGN KEY (suivi_par) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  INDEX (date_creation),
  INDEX (motif),
  INDEX (statut)
);

-- ---------- Sorties de stock (export vers la production, FIFO obligatoire) ----------
-- Une sortie : une quantité d'une référence, prise automatiquement en FIFO
CREATE TABLE IF NOT EXISTS exports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date_export DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reference VARCHAR(50) NOT NULL,
  type ENUM('bobine', 'cosse', 'connecteur') NOT NULL,
  taille_bobine ENUM('grande', 'moyenne', 'petite') NULL,
  quantite INT NOT NULL,
  destination VARCHAR(150) NULL,  -- P1, P2, P3, CET ou MCW (obligatoire, contrôlé par l'API)
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

-- Paramètres de l'application (modifiables par l'administrateur)
CREATE TABLE IF NOT EXISTS parametres (
  cle VARCHAR(50) PRIMARY KEY,
  valeur VARCHAR(255) NOT NULL
);

-- Zone tampon : nombre de places (T01, T02…), au sol devant les blocs A et B
INSERT IGNORE INTO parametres (cle, valeur) VALUES
  ('tampon_capacite', '20'),
  -- Limites d'une palette de connecteurs (cm, %, kg), modifiables par l'administrateur
  ('connecteur_longueur', '120'),
  ('connecteur_largeur', '80'),
  ('connecteur_hauteur_n3', '100'),
  ('connecteur_hauteur_n4', '150'),
  ('connecteur_taux', '85'),
  ('connecteur_poids_max', '15'),
  -- Réclamation non réglée depuis plus de N jours : en retard
  ('reclamation_delai_jours', '7');
