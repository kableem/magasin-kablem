-- Migration 034 : import « résumé » (fichier de l'Italie : référence + total de pièces, sans lot ni colis).
-- Le lot, le n° de colis et les pièces de chaque colis sont lus sur le ticket vert à la réception :
-- chaque ticket scanné crée (ou complète) la ligne référence + lot de l'import ; à la fin de la réception,
-- les pièces reçues de chaque référence sont comparées au total annoncé (tolérance réglable).
--   imports.mode                : 'detail' (lignes référence + lot + colis, comme avant) ou 'resume'
--   imports_attendus            : total de pièces annoncé pour chaque référence d'un import résumé
--   controles_mobile.pieces     : pièces du colis scanné (confection du ticket)
--   reclamations.unite          : la quantité réclamée est en colis (avant) ou en pièces (import résumé)
-- N'ajoute que des colonnes et une table : les imports existants restent en mode « detail ».
USE magasin_kablem;

ALTER TABLE imports
  ADD COLUMN mode ENUM('detail', 'resume') NOT NULL DEFAULT 'detail' AFTER numero_livraison;

CREATE TABLE IF NOT EXISTS imports_attendus (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_id INT NOT NULL,
  reference VARCHAR(50) NOT NULL,
  type ENUM('bobine', 'cosse', 'connecteur') NOT NULL,          -- d'après le catalogue Articles
  taille_bobine ENUM('grande', 'moyenne', 'petite') NULL,
  type_cosse ENUM('axiale', 'plat') NULL,
  pieces INT NOT NULL,                                          -- total annoncé par l'Italie
  UNIQUE KEY uq_import_reference (import_id, reference),
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE
);

ALTER TABLE controles_mobile
  ADD COLUMN pieces INT NULL AFTER quantite_ticket;

ALTER TABLE reclamations
  ADD COLUMN unite ENUM('colis', 'pieces') NOT NULL DEFAULT 'colis' AFTER quantite;
