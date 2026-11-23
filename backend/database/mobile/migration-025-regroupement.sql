-- Migration 025 : « Ranger le magasin » (étude n° 2) : les déplacements de regroupement
-- (palette de la zone tampon vers un emplacement vide, bobines d'une palette partielle vers une autre)
-- sont notés dans l'historique des emplacements avec leur propre origine.
-- Ajoute une valeur ; aucune donnée existante n'est modifiée.
USE magasin_kablem;

ALTER TABLE mouvements_emplacement
  MODIFY origine ENUM('deplacement', 'plan_import', 'automatique', 'regroupement') NOT NULL;
