-- Migration 013 : contrôles faits depuis l'application mobile (scan du ticket vert)
-- À RELIRE avant de l'exécuter sur la base réelle. Elle ne modifie aucune table existante :
-- elle ajoute seulement la table controles_mobile.
--
-- Une ligne = un scan et son résultat :
--   contrôle 1 « reception » : le ticket scanné correspond-il à une ligne d'import ?
--   contrôle 2 « rangement » : le produit est-il posé sur l'emplacement prévu ?
-- Les fausses tentatives de rangement (resultat = 'faux_emplacement') forment le journal des alertes.
-- Rien n'est écrit dans le stock (placements) par ces contrôles : avec l'option (a), le stock
-- reste alimenté par « Ajouter au stock » dans l'application web.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS controles_mobile (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid CHAR(36) NOT NULL,                       -- généré par le téléphone : un renvoi n'est pas compté deux fois
  controle ENUM('reception', 'rangement') NOT NULL,
  resultat ENUM(
    'conforme',            -- contrôle 1 : quantité identique à l'import
    'ecart_quantite',      -- contrôle 1 : quantité différente (écart enregistré)
    'inconnu',             -- contrôle 1 ou 2 : référence + lot absents des imports
    'deja_traite',         -- ticket déjà reçu (contrôle 1) ou déjà rangé (contrôle 2)
    'non_recu',            -- contrôle 2 : le ticket n'est pas passé par le contrôle 1
    'import_en_attente',   -- contrôle 2 : l'import n'est pas encore ajouté au stock (web)
    'bon_emplacement',     -- contrôle 2 : emplacement correct
    'faux_emplacement',    -- contrôle 2 : « Ce n'est pas son emplacement »
    'emplacement_inconnu', -- contrôle 2 : le QR d'emplacement ne correspond à aucun emplacement
    'ticket_illisible'     -- le QR ne contient pas référence + lot + quantité
  ) NOT NULL,
  reference VARCHAR(50) NULL,
  lot VARCHAR(50) NULL,
  quantite_ticket INT NULL,
  quantite_attendue INT NULL,                   -- quantité de la ligne d'import, moins la quantité réclamée
  ecart INT NULL,                               -- quantite_ticket - quantite_attendue
  reception_id INT NULL,                        -- ligne d'import concernée
  import_id INT NULL,
  emplacement_prevu VARCHAR(120) NULL,          -- ex. "D000" ou "D000, D001"
  emplacement_scanne VARCHAR(20) NULL,
  saisie_manuelle TINYINT(1) NOT NULL DEFAULT 0,
  qr_brut VARCHAR(500) NULL,                    -- texte lu dans le QR (ou saisi à la main)
  message VARCHAR(255) NOT NULL,
  reponse TEXT NULL,                            -- réponse renvoyée au téléphone (rejouée si le même uuid revient)
  utilisateur_id INT NULL,
  date_controle DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_controle_uuid (uuid),
  INDEX idx_controle_reception (reception_id, controle, resultat),
  INDEX idx_controle_date (date_controle),
  INDEX idx_controle_utilisateur (utilisateur_id, date_controle),
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE SET NULL,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE SET NULL,
  FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id) ON DELETE SET NULL
);
