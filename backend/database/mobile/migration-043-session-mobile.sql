-- Migration 043 : un seul téléphone à la fois par compte (décision du 2026-11-19).
-- Quand un compte est connecté sur un téléphone, une 2e connexion mobile est toujours refusée, jusqu'à
-- « Se déconnecter » sur ce téléphone, « Libérer » par l'administrateur (web), ou 30 minutes sans action.
-- Le web n'est pas concerné.
--   utilisateurs.session_mobile    : numéro de la session mobile en cours (NULL : aucune)
--   utilisateurs.session_mobile_vu : dernière action du téléphone
USE magasin_kablem;

ALTER TABLE utilisateurs
  ADD COLUMN session_mobile VARCHAR(64) NULL,
  ADD COLUMN session_mobile_vu DATETIME NULL;
