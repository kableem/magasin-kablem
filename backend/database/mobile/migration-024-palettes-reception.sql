-- Migration 024 : réception des bobines par palette (étude n° 2, version 1.2).
-- Le magasinier déclare chaque palette reçue : il scanne les bobines qu'elle porte, la termine,
-- et l'application lui donne un emplacement pour la palette entière (emplacement entièrement vide),
-- sinon range les bobines une par une (palettes commencées), sinon en zone tampon.
-- Ajoute une table et deux colonnes ; aucune donnée existante n'est modifiée.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS palettes_reception (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_id INT NOT NULL,
  numero INT NOT NULL,                                   -- palette 1, 2, 3… de l'import
  taille ENUM('grande', 'moyenne', 'petite') NULL,       -- taille des bobines (jamais mélangées)
  statut ENUM('ouverte', 'terminee', 'rangee') NOT NULL DEFAULT 'ouverte',
  mode ENUM('entiere', 'divisee') NULL,                  -- entière : un emplacement ; divisée : bobine par bobine
  emplacement VARCHAR(10) NULL,                          -- emplacement de la palette entière
  ouverte_par INT NULL,
  date_ouverture DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_terminee DATETIME NULL,
  date_rangee DATETIME NULL,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  FOREIGN KEY (ouverte_par) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  UNIQUE KEY uq_palette_numero (import_id, numero)
);

-- Bobine reçue sur une palette (scan de réception)
ALTER TABLE controles_mobile
  ADD COLUMN palette_id INT NULL AFTER preparation_id,
  ADD CONSTRAINT fk_controle_palette FOREIGN KEY (palette_id) REFERENCES palettes_reception(id) ON DELETE SET NULL;

-- Emplacement attribué à une bobine par sa palette
ALTER TABLE affectations_colis
  ADD COLUMN palette_id INT NULL AFTER reception_id,
  ADD CONSTRAINT fk_affectation_palette FOREIGN KEY (palette_id) REFERENCES palettes_reception(id) ON DELETE SET NULL;
