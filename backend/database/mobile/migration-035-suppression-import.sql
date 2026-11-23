-- Migration 035 : l'administrateur peut supprimer n'importe quel import (en attente ou déjà au stock).
-- La suppression efface l'import, ses lignes, ses produits encore en stock, ses réclamations et ses palettes ;
-- l'historique des sorties et des déplacements est gardé. Pour la traçabilité :
--   imports_supprimes : qui, quand, pourquoi, et une copie (JSON) de l'import tel qu'il était ;
--                       un import venu de l'Italie (source_id) n'est plus recopié par « Synchroniser »
--   mouvements_emplacement.origine 'suppression_import' : produits retirés du stock par la suppression
-- N'ajoute qu'une table et une valeur : aucune donnée existante ne change.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS imports_supprimes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_id INT NOT NULL,                       -- n° de l'import supprimé
  source_id INT NULL,                           -- import italien d'origine
  numero_livraison VARCHAR(50) NULL,
  statut VARCHAR(20) NOT NULL,                  -- en_attente ou ajoute, au moment de la suppression
  produits_retires INT NOT NULL DEFAULT 0,      -- produits retirés du stock
  motif VARCHAR(255) NOT NULL,
  contenu LONGTEXT NOT NULL,                    -- copie JSON : import, lignes, stock, réclamations
  utilisateur_id INT NULL,
  date_suppression DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_supprime_source (source_id),
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL
);

ALTER TABLE mouvements_emplacement
  MODIFY origine ENUM('deplacement', 'plan_import', 'automatique', 'regroupement', 'inventaire', 'suppression_import') NOT NULL;
