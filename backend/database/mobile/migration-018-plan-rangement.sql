-- Migration 018 : le stock s'alimente au rangement, colis par colis.
-- À la fin de la réception, l'application calcule le plan de rangement et réserve ces places
-- (plans_rangement) ; un produit n'entre dans le stock (placements) qu'au scan de son emplacement
-- sur le mobile. ranges = nombre de produits déjà posés sur cette place prévue.
-- N'ajoute qu'une table ; ne modifie aucune donnée existante.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS plans_rangement (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reception_id INT NOT NULL,
  emplacement VARCHAR(10) NOT NULL,
  quantite INT NOT NULL,           -- produits prévus à cette place
  ranges INT NOT NULL DEFAULT 0,   -- produits déjà rangés (donc au stock)
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_plan_rangement (reception_id, emplacement)
);

-- Imports déjà au stock avant cette règle : leur plan est entièrement rangé
INSERT IGNORE INTO plans_rangement (reception_id, emplacement, quantite, ranges)
SELECT reception_id, emplacement, quantite, quantite FROM placements WHERE emplacement IS NOT NULL;

-- Nouveau résultat de rangement : place prévue déjà remplie pour ce lot
ALTER TABLE controles_mobile
  MODIFY resultat ENUM('conforme','ecart_quantite','inconnu','deja_traite','non_recu','import_en_attente',
    'bon_emplacement','faux_emplacement','emplacement_inconnu','ticket_illisible','prelevement_ok','sortie_terminee',
    'mauvais_produit','stock_modifie','preparation_close','emplacement_complet') NOT NULL;
