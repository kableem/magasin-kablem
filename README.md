# Magasin Kablem

Gestion du magasin de matières premières de **Kab-lem Tunisia** : réception, rangement, stock, sorties FIFO, inventaire.

| Partie | Technologie | Port |
|---|---|---|
| `backend/` | API Node.js 20 + Express 5 | 3000 |
| `frontend/` | Application web (Angular 20) | 4200 en développement |
| `mobile/` | Application mobile des magasiniers (Ionic 8 + Angular 20, scan des QR) | 8100 en développement (HTTPS) |
| Base | MySQL 8 : `magasin_kablem` | 3306 |

## Prérequis
- Node.js 20 LTS ou plus
- MySQL Server 8
- Git

## Installation

```
git clone https://github.com/kableem/magasin-kablem.git
cd magasin-kablem
npm run install:all
```

### Configuration
Copier `backend/.env.example` en `backend/.env` et remplir :
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` : accès à MySQL ;
- `JWT_SECRET` : une longue clé secrète aléatoire (40 caractères ou plus) ;
- `CORS_ORIGINES` : adresses autorisées à appeler l'API (ex. `https://serveur:8100`), séparées par des virgules ;
- `HTTPS_CERT` / `HTTPS_CLE` : certificat et clé (.pem) pour servir l'API en HTTPS (facultatif).

Le fichier `.env` ne doit jamais être publié.

### Base de données
La copie complète de la base (stock, historique, catalogue, comptes) est dans `backend/database/donnees/magasin_kablem.sql`.

```
npm run base:restaurer
```

La commande refuse d'écraser une base existante. Pour la remplacer : `node backend/scripts/restaurer-base.js --remplacer`.

## Lancement

| Commande (à la racine) | Rôle |
|---|---|
| `npm start` | démarre l'API (production) |
| `npm run build` | compile le web (`frontend/dist/`) et le mobile (`mobile/www/`) |
| `npm run dev` | API + web en développement |
| `npm run tout` | API + web + mobile en développement |

## Hébergement : points à prévoir
- **API** : à faire tourner en service permanent (par exemple avec PM2 ou un service Windows), port 3000.
- **Web** : les fichiers de `frontend/dist/` sont à servir par un serveur web (IIS ou nginx).
  L'adresse de l'API est actuellement écrite `http://localhost:3000/api` dans `frontend/src/app/services/*.ts` :
  à remplacer par l'adresse du serveur (ou `/api` derrière un proxy inverse) avant `npm run build`.
- **Mobile** : la caméra du téléphone exige le **HTTPS** ; servir `mobile/www/` en HTTPS avec un certificat,
  et faire passer `/api` vers l'API (en développement, c'est fait par `mobile/proxy.conf.json`).
- **MySQL** : sauvegarder régulièrement la base `magasin_kablem` (`mysqldump`).

## Comptes
Les comptes sont ceux de la base restaurée. Rôles : administrateur, chef de magasin, magasinier, planificateur.
Changer les mots de passe faibles dans **Administration → Utilisateurs**.
