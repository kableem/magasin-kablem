// Recrée la base à partir de la copie complète backend/database/donnees/magasin_kablem.sql
// (faite sur l'ancien PC par npm run base:exporter) : mêmes données, mêmes comptes.
// Refuse d'écraser une base qui contient déjà des tables, sauf avec --remplacer.
//   node scripts/restaurer-base.js [--remplacer]      (npm run base:restaurer à la racine)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const BASE = process.env.DB_NAME || 'magasin_kablem';
const fichier = path.join(__dirname, '..', 'database', 'donnees', 'magasin_kablem.sql');

(async () => {
  if (!fs.existsSync(fichier)) throw new Error(`Copie introuvable : ${fichier}`);
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, multipleStatements: true,
  });
  try {
    const [[{ n }]] = await c.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [BASE]);
    if (n && !process.argv.includes('--remplacer')) {
      throw new Error(`La base ${BASE} existe déjà (${n} tables) : rien n'est fait. Pour l'écraser : node scripts/restaurer-base.js --remplacer`);
    }
    if (n) await c.query(`DROP DATABASE \`${BASE}\``);
    // la copie s'appelle magasin_kablem : elle prend le nom de .env
    await c.query(fs.readFileSync(fichier, 'utf8').replace(/`magasin_kablem`/g, `\`${BASE}\``));
    const [[{ articles }]] = await c.query(`SELECT COUNT(*) AS articles FROM \`${BASE}\`.articles_mp`);
    const [[{ comptes }]] = await c.query(`SELECT COUNT(*) AS comptes FROM \`${BASE}\`.utilisateurs`);
    console.log(`Base ${BASE} restaurée : ${articles} articles, ${comptes} comptes, avec tout le stock et l'historique.`);
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error('Erreur :', e.message);
  process.exitCode = 1;
});
