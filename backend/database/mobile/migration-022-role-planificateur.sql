-- Migration 022 : nouveau rôle « planificateur », qui ne gère que le catalogue des articles.
-- N'ajoute qu'une valeur au rôle ; aucun compte existant n'est modifié.
USE magasin_kablem;

ALTER TABLE utilisateurs
  MODIFY role ENUM('admin', 'chef_magasin', 'magasinier', 'planificateur') NOT NULL DEFAULT 'magasinier';
