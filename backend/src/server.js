const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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
const mobileCartonsRoutes = require('./routes/mobile-cartons');
const mobilePalettesCossesRoutes = require('./routes/mobile-palettes-cosses');
const mobileUrgenceRoutes = require('./routes/mobile-urgence');
const mobileDescenteRoutes = require('./routes/mobile-descente');
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
app.use('/api/articles', verifierToken, exigerGestionnaire(), articlesRoutes); // administrateur et chef de magasin
app.use('/api/mobile/export', verifierToken, exigerMagasin(), mobileExportRoutes);
app.use('/api/mobile/receptions', verifierToken, exigerMagasin(), mobileReceptionRoutes);
app.use('/api/mobile/palettes', verifierToken, exigerMagasin(), mobilePalettesRoutes);
app.use('/api/mobile/cartons', verifierToken, exigerMagasin(), mobileCartonsRoutes);
app.use('/api/mobile/palettes-cosses', verifierToken, exigerMagasin(), mobilePalettesCossesRoutes);
app.use('/api/mobile/urgence', verifierToken, exigerMagasin(), mobileUrgenceRoutes);
app.use('/api/mobile/descente', verifierToken, exigerMagasin(), mobileDescenteRoutes);
app.use('/api/mobile/ranger', verifierToken, exigerMagasin(), mobileRangerRoutes);
app.use('/api/mobile/inventaire', verifierToken, exigerGestionnaire(), mobileInventaireRoutes);
app.use('/api/journal', verifierToken, exigerGestionnaire(), journalRoutes);
app.use('/api/mobile', verifierToken, exigerMagasin(), mobileRoutes);

// Sur le serveur : le web et le mobile compilés (npm run build) sont servis par l'API elle-même,
// à la même adresse : https://SERVEUR:PORT/ (web) et https://SERVEUR:PORT/mobile/ (téléphones).
// Pas de compilation (sur un PC de développement) : rien n'est servi ici, on utilise npm run dev.
const WEB = path.join(__dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser');
const MOBILE = path.join(__dirname, '..', '..', 'mobile', 'www');
if (fs.existsSync(path.join(MOBILE, 'index.html'))) {
  app.use('/mobile', express.static(MOBILE));
  app.get('/mobile/{*chemin}', (req, res) => res.sendFile(path.join(MOBILE, 'index.html')));
}
if (fs.existsSync(path.join(WEB, 'index.html'))) {
  app.use(express.static(WEB));
  app.get('/{*chemin}', (req, res, next) => (req.path.startsWith('/api') ? next() : res.sendFile(path.join(WEB, 'index.html'))));
}

// Gestion des erreurs
app.use((err, req, res, next) => {
  // refus normal (codeMetier : refus que le téléphone traite à part)
  if (err.status && err.status < 500) return res.status(err.status).json({ message: err.message, ...(err.codeMetier ? { code: err.codeMetier } : {}) });
  console.error(err);
  if (err.status) return res.status(err.status).json({ message: err.message });
  res.status(500).json({ message: 'Erreur serveur', detail: err.message });
});

// Démarrage (pas pendant les tests, qui utilisent directement app).
// HTTPS si un certificat est indiqué dans .env, sinon HTTP :
//   HTTPS_PFX (+ HTTPS_PFX_MDP) : certificat Windows .pfx (serveur) ;
//   HTTPS_CERT et HTTPS_CLE : fichiers .pem.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  // mails automatiques au service logistique (sorties urgentes en retard)
  require('./mails').demarrerSurveillance();
  const options = process.env.HTTPS_PFX
    ? { pfx: fs.readFileSync(process.env.HTTPS_PFX), passphrase: process.env.HTTPS_PFX_MDP || undefined }
    : process.env.HTTPS_CERT && process.env.HTTPS_CLE
      ? { cert: fs.readFileSync(process.env.HTTPS_CERT), key: fs.readFileSync(process.env.HTTPS_CLE) }
      : null;
  if (options) {
    const https = require('https');
    https.createServer(options, app).listen(PORT, () => console.log(`API Magasin Kablem : https://localhost:${PORT}/api`));
  } else {
    app.listen(PORT, () => console.log(`API Magasin Kablem : http://localhost:${PORT}/api`));
  }
}

module.exports = app;
