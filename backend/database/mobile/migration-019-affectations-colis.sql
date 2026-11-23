-- Migration 019 : chaque colis a SON emplacement, imposé.
-- À la validation de la réception, chaque colis reçu (ticket fournisseur) est attribué à une place
-- du plan de rangement : colis triés par numéro, places remplies dans l'ordre du plan.
-- Au rangement, seul cet emplacement est accepté. Le chef peut le changer sur le web (motif obligatoire).
-- N'ajoute qu'une table ; ne modifie aucune donnée existante.
USE magasin_kablem;

CREATE TABLE IF NOT EXISTS affectations_colis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reception_id INT NOT NULL,
  ticket VARCHAR(80) NOT NULL,        -- identifiant du colis : « REF|lot-suffixe|n° »
  colis INT NOT NULL,                 -- n° du colis
  emplacement VARCHAR(10) NOT NULL,   -- emplacement imposé
  date_affectation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  range_le DATETIME NULL,             -- rangé à cet emplacement (entré au stock)
  FOREIGN KEY (reception_id) REFERENCES receptions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_affectation_ticket (ticket),
  INDEX idx_affectation_reception (reception_id)
);
