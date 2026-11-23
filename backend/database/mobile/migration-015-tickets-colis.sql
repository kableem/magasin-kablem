-- Migration 015 : tickets verts réels (un ticket = un colis)
-- Le QR du ticket fournisseur contient : référence ; confection ; n° de colis ; lot ; suffixe
-- (ex. F0391;13000;10;202613167;1). Chaque colis a donc un identifiant unique.
-- N'ajoute que des colonnes ; ne modifie aucune table de l'application web.
USE magasin_kablem;

-- Identifiant du colis scanné (« F0391|202613167-1|10 ») : un colis n'est reçu, rangé
-- ou sorti qu'une seule fois. NULL pour un ticket simple (référence;lot;quantité).
ALTER TABLE controles_mobile
  ADD COLUMN ticket VARCHAR(80) NULL AFTER lot,
  ADD INDEX idx_controle_ticket (ticket, controle);

-- Sortie préparée : nombre de colis déjà pris pour ce prélèvement
ALTER TABLE preparation_lignes
  ADD COLUMN preleves INT NOT NULL DEFAULT 0 AFTER quantite;
