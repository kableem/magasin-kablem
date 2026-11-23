-- Migration : historique des changements d'emplacement (qui, quand, quoi, d'où, vers où, pourquoi).
-- À exécuter une seule fois.
USE magasin_kablem;

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
