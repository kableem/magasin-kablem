-- Migration : troisième rôle « chef de magasin » (mêmes droits que l'administrateur,
-- sauf la gestion des utilisateurs). À exécuter une seule fois.
USE magasin_kablem;

ALTER TABLE utilisateurs MODIFY role ENUM('admin', 'chef_magasin', 'magasinier') NOT NULL DEFAULT 'magasinier';
