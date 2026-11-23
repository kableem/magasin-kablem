-- Migration 039 : sortie urgente vers la production (décision de la direction, 2026-11-11).
-- La production a besoin d'une pièce tout de suite : le magasinier ne termine pas la réception ni le rangement.
--   1. il scanne le ticket du colis et choisit la destination : le colis est contrôlé comme à la réception
--      (dans l'import, sans doublon). Si la même référence est déjà en stock, il faut l'accord du chef de
--      magasin ou de l'administrateur (FIFO) ;
--   2. l'application indique l'emplacement vide le plus proche de la porte : il y pose le colis et scanne
--      l'emplacement (le colis entre au stock, rangé) ;
--   3. il scanne l'emplacement puis le ticket : le colis sort vers la production (sortie mobile normale).
-- Le reste de l'import continue normalement ; à l'ajout au stock, ce colis n'est plus à ranger.
-- N'ajoute qu'une table : aucune donnée existante n'est modifiée.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS sorties_urgentes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket VARCHAR(80) NOT NULL,                     -- identifiant du colis : « REF|lot-suffixe|n° »
  colis INT NOT NULL,                              -- n° du colis
  reference VARCHAR(50) NOT NULL,
  lot VARCHAR(50) NOT NULL,
  reception_id INT NOT NULL,                       -- ligne d'import du colis
  import_id INT NOT NULL,
  destination VARCHAR(10) NOT NULL,                -- P1, P2, P3, CET, MCW
  statut ENUM('a_poser', 'posee', 'sortie', 'annulee') NOT NULL DEFAULT 'a_poser',
  emplacement_propose VARCHAR(10) NULL,            -- le plus proche de la porte, au moment de la demande
  emplacement VARCHAR(10) NULL,                    -- où le colis a été posé (scanné)
  stock_existant INT NOT NULL DEFAULT 0,           -- produits de la même référence déjà en stock à la demande
  autorise_par INT NULL,                           -- chef de magasin ou administrateur (stock existant : hors FIFO)
  preparation_id INT NULL,                         -- sortie mobile créée quand le colis est posé
  export_id INT NULL,                              -- sortie enregistrée
  utilisateur_id INT NULL,                         -- magasinier
  date_demande DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_posee DATETIME NULL,
  date_sortie DATETIME NULL,
  UNIQUE KEY uq_urgence_ticket (ticket),
  INDEX idx_urgence_statut (statut, utilisateur_id),
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  FOREIGN KEY (autorise_par) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  FOREIGN KEY (preparation_id) REFERENCES preparations_export(id) ON DELETE SET NULL,
  FOREIGN KEY (export_id) REFERENCES exports(id) ON DELETE SET NULL,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL
);
