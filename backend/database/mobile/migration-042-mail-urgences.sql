-- Migration 042 : mail automatique au service logistique (décision du 2026-11-16).
-- Une sortie urgente posée près de la porte et pas encore sortie depuis plus de 2 h devient critique :
-- l'application envoie un seul mail au service logistique (adresses réglées sur le web, compte d'envoi dans .env).
--   sorties_urgentes.mail_envoye_le : date du mail envoyé pour cette sortie (NULL : pas encore envoyé)
USE magasin_kablem;

ALTER TABLE sorties_urgentes
  ADD COLUMN mail_envoye_le DATETIME NULL;
