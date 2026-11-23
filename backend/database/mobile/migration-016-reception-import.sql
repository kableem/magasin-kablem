-- Migration 016 : relier la réception physique (mobile) à l'import (web)
-- N'ajoute que des colonnes ; les imports et réclamations existants ne changent pas.
--
-- Parcours d'un import :
--   en attente -> réception en cours (1er colis scanné) -> réception terminée (mobile)
--     - sans écart : ajouté au stock automatiquement (dans l'ordre d'arrivée)
--     - avec écart : réclamations créées automatiquement, « à valider » par le chef sur le web
--   -> ajouté au stock -> rangé (tous les colis reçus scannés à leur emplacement)
-- Secours : l'admin ou le chef peut ajouter au stock sans réception mobile, avec un motif.
USE magasin_kablem;

ALTER TABLE imports
  ADD COLUMN reception ENUM('non_commencee', 'en_cours', 'terminee') NOT NULL DEFAULT 'non_commencee' AFTER statut,
  ADD COLUMN reception_debut DATETIME NULL AFTER reception,
  ADD COLUMN reception_fin DATETIME NULL AFTER reception_debut,
  ADD COLUMN reception_par INT NULL AFTER reception_fin,
  ADD COLUMN reception_ecarts INT NOT NULL DEFAULT 0 AFTER reception_par,  -- nombre d'écarts à la fin de la réception
  ADD COLUMN ajout_force TINYINT(1) NOT NULL DEFAULT 0 AFTER ajoute_par,    -- ajouté au stock sans réception mobile
  ADD COLUMN motif_force VARCHAR(255) NULL AFTER ajout_force,
  ADD CONSTRAINT fk_imports_reception_par FOREIGN KEY (reception_par) REFERENCES utilisateurs(id) ON DELETE SET NULL;

-- Réclamations créées par le mobile pour un produit sans ligne d'import (colis en trop, produit hors import) :
-- reception_id vide, l'import et le produit sont notés directement. Elles ne sont pas déduites du stock.
ALTER TABLE reclamations
  MODIFY reception_id INT NULL,
  ADD COLUMN import_id INT NULL AFTER reception_id,
  ADD COLUMN reference VARCHAR(50) NULL AFTER import_id,
  ADD COLUMN lot VARCHAR(50) NULL AFTER reference,
  ADD COLUMN origine ENUM('manuelle', 'reception_mobile') NOT NULL DEFAULT 'manuelle' AFTER lot,
  ADD CONSTRAINT fk_reclamations_import FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE;

UPDATE reclamations rc JOIN receptions r ON r.id = rc.reception_id SET rc.import_id = r.import_id WHERE rc.import_id IS NULL;
