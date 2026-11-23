-- Migration 029 : « Ranger le magasin » sans suggestion du système (décision du directeur, 2026-10-29).
-- Le magasinier scanne le produit, son emplacement, puis l'emplacement d'arrivée de son choix ;
-- l'application contrôle le déplacement (règles du magasin) et l'enregistre avec son matricule.
--   controles_mobile : chaque tentative est notée (contrôle « ranger » : déplacé ou refusé)
--   mouvements_emplacement.colis          : n° de colis du ticket déplacé
--   mouvements_emplacement.depuis_liberee : l'emplacement de départ est vide après ce déplacement
-- Ajoute des valeurs et deux colonnes ; aucune donnée existante n'est modifiée.
USE magasin_kablem;

ALTER TABLE controles_mobile
  MODIFY controle ENUM('reception', 'rangement', 'export', 'ranger') NOT NULL,
  MODIFY resultat ENUM('conforme','ecart_quantite','inconnu','deja_traite','non_recu','import_en_attente',
    'bon_emplacement','faux_emplacement','emplacement_inconnu','ticket_illisible','prelevement_ok','sortie_terminee',
    'mauvais_produit','stock_modifie','preparation_close','emplacement_complet','deplace','deplacement_refuse') NOT NULL;

ALTER TABLE mouvements_emplacement
  ADD COLUMN colis INT NULL AFTER quantite,
  ADD COLUMN depuis_liberee TINYINT(1) NOT NULL DEFAULT 0 AFTER vers;
