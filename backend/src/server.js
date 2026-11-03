const express = require('express');
const cors = require('cors');
require('dotenv').config();

const db = require('./db');
const produitsRoutes = require('./routes/produits');
const categoriesRoutes = require('./routes/categories');
const authRoutes = require('./routes/auth');
const utilisateursRoutes = require('./routes/utilisateurs');
const emplacementsRoutes = require('./routes/emplacements');
const mouvementsRoutes = require('./routes/mouvements');
const importsRoutes = require('./routes/imports');
const articlesRoutes = require('./routes/articles');
const parametresRoutes = require('./routes/parametres');
const stockRoutes = require('./routes/stock');
const exportsRoutes = require('./routes/exports');
const reclamationsRoutes = require('./routes/reclamations');
const tableauDeBordRoutes = require('./routes/tableau-de-bord');
const mobileRoutes = require('./routes/mobile');
const mobileExportRoutes = require('./routes/mobile-export');
const mobileReceptionRoutes = require('./routes/mobile-reception');
const mobilePalettesRoutes = require('./routes/mobile-palettes');
const mobileRangerRoutes = require('./routes/mobile-ranger');
const rangerRoutes = require('./routes/ranger');
const mobileInventaireRoutes = require('./routes/mobile-inventaire');
const journalRoutes = require('./routes/journal');
const { verifierToken, exigerRole, exigerMagasin, exigerGestionnaire } = require('./middleware/auth');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET manquant dans backend/.env');
  process.exit(1);
}

const app = express();
// Origines autorisées : l'application web, plus celles du mobile (CORS_ORIGINES dans .env,
// séparées par des virgules, ex. https://192.168.1.20:8100). Les origines de l'application
// mobile installée (Capacitor) sont toujours autorisées.
const ORIGINES = [
  'http://localhost:4200',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
  ...String(process.env.CORS_ORIGINES || '').split(',').map((o) => o.trim()).filter(Boolean),
];
app.use(cors({ origin: (origine, ok) => ok(null, !origine || ORIGINES.includes(origine)) }));
app.use(express.json());

app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connectée' });
  } catch (err) {
    res.status(500).json({ status: 'erreur', database: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/produits', verifierToken, exigerMagasin(), produitsRoutes);
app.use('/api/categories', verifierToken, exigerMagasin(), categoriesRoutes);
app.use('/api/emplacements', verifierToken, exigerMagasin(), emplacementsRoutes);
app.use('/api/mouvements', verifierToken, exigerMagasin(), mouvementsRoutes);
app.use('/api/imports', verifierToken, exigerMagasin(), importsRoutes);
app.use('/api/parametres', verifierToken, exigerMagasin(), parametresRoutes);
app.use('/api/stock', verifierToken, exigerMagasin(), stockRoutes);
app.use('/api/ranger', verifierToken, exigerMagasin(), rangerRoutes);
app.use('/api/exports', verifierToken, exigerMagasin(), exportsRoutes);
app.use('/api/reclamations', verifierToken, exigerMagasin(), reclamationsRoutes);
app.use('/api/tableau-de-bord', verifierToken, exigerGestionnaire(), tableauDeBordRoutes);
app.use('/api/utilisateurs', verifierToken, exigerRole('admin'), utilisateursRoutes);
app.use('/api/articles', verifierToken, exigerRole('admin', 'planificateur'), articlesRoutes);
app.use('/api/mobile/export', verifierToken, exigerMagasin(), mobileExportRoutes);
app.use('/api/mobile/receptions', verifierToken, exigerMagasin(), mobileReceptionRoutes);
app.use('/api/mobile/palettes', verifierToken, exigerMagasin(), mobilePalettesRoutes);
app.use('/api/mobile/ranger', verifierToken, exigerMagasin(), mobileRangerRoutes);
app.use('/api/mobile/inventaire', verifierToken, exigerGestionnaire(), mobileInventaireRoutes);
app.use('/api/journal', verifierToken, exigerGestionnaire(), journalRoutes);
app.use('/api/mobile', verifierToken, exigerMagasin(), mobileRoutes);

// Gestion des erreurs
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ message: err.message }); // refus normal
  console.error(err);
  if (err.status) return res.status(err.status).json({ message: err.message });
  res.status(500).json({ message: 'Erreur serveur', detail: err.message });
});

// Démarrage (pas pendant les tests, qui utilisent directement app).
// HTTPS si HTTPS_CERT et HTTPS_CLE (chemins des fichiers .pem) sont indiqués dans .env, sinon HTTP.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  if (process.env.HTTPS_CERT && process.env.HTTPS_CLE) {
    const https = require('https');
    const fs = require('fs');
    const options = { cert: fs.readFileSync(process.env.HTTPS_CERT), key: fs.readFileSync(process.env.HTTPS_CLE) };
    https.createServer(options, app).listen(PORT, () => console.log(`API Magasin Kablem : https://localhost:${PORT}/api`));
  } else {
    app.listen(PORT, () => console.log(`API Magasin Kablem : http://localhost:${PORT}/api`));
  }
}

module.exports = app;
