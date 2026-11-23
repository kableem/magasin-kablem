-- Migration : suivi des réclamations avec le fournisseur (Italie).
-- Ouverte -> Envoyée à l'Italie -> Réglée (avoir, renvoi, remplacement, autre).
-- À exécuter une seule fois.
USE magasin_kablem;

ALTER TABLE reclamations
  ADD COLUMN statut ENUM('ouverte', 'envoyee', 'reglee') NOT NULL DEFAULT 'ouverte' AFTER commentaire,
  ADD COLUMN date_envoi DATETIME NULL AFTER statut,
  ADD COLUMN date_reglement DATETIME NULL AFTER date_envoi,
  ADD COLUMN solution ENUM('avoir', 'renvoi', 'remplacement', 'autre') NULL AFTER date_reglement,
  ADD COLUMN note_suivi VARCHAR(255) NULL AFTER solution,
  ADD COLUMN suivi_par INT NULL AFTER note_suivi,
  ADD COLUMN date_suivi DATETIME NULL AFTER suivi_par,
  ADD CONSTRAINT fk_reclamations_suivi_par FOREIGN KEY (suivi_par) REFERENCES utilisateurs(id) ON DELETE SET NULL,
  ADD INDEX (statut);

-- Délai au-delà duquel une réclamation non réglée est « en retard » (jours, réglable)
INSERT IGNORE INTO parametres (cle, valeur) VALUES ('reclamation_delai_jours', '7');
