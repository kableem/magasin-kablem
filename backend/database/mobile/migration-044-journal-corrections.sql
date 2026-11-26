-- Migration 044 : les corrections de la réception mobile vont dans le Journal des alertes (décision du 2026-11-25).
-- Chaque correction d'un magasinier (cosse mise dans un carton ou sortie du carton, cosse retirée, carton ou palette
-- rouvert, colis retiré d'une palette) est notée : qui, quand, quelle référence, quel lot, quel colis, quel carton.
--   controles_mobile.controle : nouvelle valeur 'correction'
--   controles_mobile.resultat : nouvelle valeur 'correction'
-- Les lignes de correction ne portent ni ligne d'import, ni carton, ni palette, ni ticket : elles ne changent aucun compte.
USE magasin_kablem;

ALTER TABLE controles_mobile
  MODIFY controle ENUM('reception', 'rangement', 'export', 'ranger', 'correction') NOT NULL,
  MODIFY resultat ENUM(
    'conforme','ecart_quantite','inconnu','deja_traite','non_recu','import_en_attente',
    'bon_emplacement','faux_emplacement','emplacement_inconnu','ticket_illisible','prelevement_ok','sortie_terminee',
    'mauvais_produit','stock_modifie','preparation_close','emplacement_complet','deplace','deplacement_refuse',
    'correction'
  ) NOT NULL;
