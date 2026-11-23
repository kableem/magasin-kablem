-- Migration 021 : la base de l'Italie ne donne pas le type du produit (bobine, cosse, connecteur).
-- À la synchronisation, le type vient du catalogue Articles (articles_mp) d'après la référence.
-- Le type devient facultatif dans la copie des imports italiens. Aucune donnée n'est modifiée.
USE magasin_kablem;

ALTER TABLE italie_produits MODIFY type ENUM('bobine', 'cosse', 'connecteur') NULL;
