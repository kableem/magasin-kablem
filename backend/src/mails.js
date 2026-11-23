// Mails automatiques au service logistique (décision du 2026-11-16).
// Une sortie urgente posée près de la porte et pas encore sortie depuis plus de 2 h (réglable) devient critique :
// un seul mail part au service logistique. Les adresses se règlent sur le web (Tableau de bord → Mails d'alerte,
// administrateur) ; le compte qui envoie est dans backend/.env (SMTP_*), jamais dans le code.
const nodemailer = require('nodemailer');
const db = require('./db');
const { avecNumeros } = require('./plan');

const MINUTES_DEFAUT = 120;
const VERIFICATION_MS = 60 * 1000; // chaque minute
const ADRESSE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// « a@x.tn, b@x.tn ; c@x.tn » -> { adresses: [...] } ; { erreur } si une adresse est fausse
function lireAdresses(texte) {
  const adresses = [...new Set(String(texte ?? '').split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const fausse = adresses.find((a) => !ADRESSE.test(a));
  return fausse ? { erreur: `Adresse mail incorrecte : « ${fausse} »` } : { adresses };
}

async function reglages(connexion = db) {
  const [lignes] = await connexion.query("SELECT cle, valeur FROM parametres WHERE cle IN ('mail_logistique', 'mail_urgence_minutes')");
  const v = Object.fromEntries(lignes.map((l) => [l.cle, l.valeur]));
  const minutes = Number(v.mail_urgence_minutes);
  return {
    destinataires: lireAdresses(v.mail_logistique).adresses ?? [],
    minutes: Number.isInteger(minutes) && minutes >= 1 ? minutes : MINUTES_DEFAUT,
  };
}

// Deux façons d'envoyer (MAIL_MODE dans .env) :
//   'outlook' : par Outlook classique ouvert sur ce PC (Windows), avec le compte qui y est connecté ;
//               aucun mot de passe dans .env (utile quand Microsoft 365 bloque le SMTP pour l'entreprise) ;
//   'smtp' (par défaut) : par un serveur SMTP (SMTP_HOST, SMTP_USER, SMTP_PASSWORD).
const modeOutlook = () => String(process.env.MAIL_MODE ?? '').trim().toLowerCase() === 'outlook';

// Le compte d'envoi est-il réglé dans .env ?
const compteConfigure = () => modeOutlook() || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
// Ce qui s'affiche sur le web : « Outlook de ce PC » ou l'adresse SMTP
const nomCompte = () => (modeOutlook() ? 'Outlook ouvert sur le PC du serveur' : compteConfigure() ? process.env.SMTP_USER : null);

// Outlook classique, piloté par PowerShell. Le message passe par un fichier JSON temporaire (UTF-8), dont le chemin
// est dans une variable d'environnement : aucun texte du message n'est interprété comme commande.
// (Pas de base64 : l'antivirus du PC coupe un programme dont PowerShell décode du base64.)
const SCRIPT_OUTLOOK = [
  '$ErrorActionPreference = "Stop"',
  '$m = Get-Content -LiteralPath $env:MAIL_FICHIER -Raw -Encoding UTF8 | ConvertFrom-Json',
  'try { $o = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application") } catch { $o = New-Object -ComObject Outlook.Application }',
  '$mail = $o.CreateItem(0)',
  '$mail.To = $m.to',
  '$mail.Subject = $m.subject',
  '$mail.HTMLBody = $m.html',
  '$mail.Send()',
  '"ok"',
].join('; ');
const transportOutlook = {
  sendMail: (m) => new Promise((ok, ko) => {
    const { execFile } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const fichier = path.join(os.tmpdir(), `magasin-kablem-mail-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(fichier, JSON.stringify({ to: m.to, subject: m.subject, html: m.html }), 'utf8');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT_OUTLOOK], { timeout: 60000, windowsHide: true, env: { ...process.env, MAIL_FICHIER: fichier } }, (err, sortie, erreurs) => {
      fs.rm(fichier, { force: true }, () => {});
      if (err || !String(sortie).includes('ok')) {
        const detail = String(erreurs || err?.message || '').split(/\r?\n/).find((l) => l.trim()) ?? 'erreur inconnue';
        return ko(new Error(`Outlook n'a pas envoyé le mail (Outlook classique est-il ouvert sur ce PC ?) : ${detail.trim()}`));
      }
      ok({ messageId: 'outlook' });
    });
  }),
};

// Transport réel (Outlook ou SMTP) ; les tests le remplacent par un faux (remplacerTransport)
let transport = null;
function transportSmtp() {
  if (modeOutlook()) return transportOutlook;
  if (!compteConfigure()) {
    throw Object.assign(new Error("Le compte d'envoi des mails n'est pas réglé : ajoutez SMTP_HOST, SMTP_USER et SMTP_PASSWORD dans backend/.env, puis redémarrez le serveur."), { status: 409 });
  }
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 : SSL (Gmail) ; 587 : STARTTLS (Outlook / Microsoft 365)
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
}
const remplacerTransport = (t) => { transport = t; };
async function envoyer(message) {
  const t = transport ?? transportSmtp();
  return t.sendMail({ from: process.env.SMTP_FROM || `Magasin Kablem <${process.env.SMTP_USER}>`, ...message });
}

// « 2 h 05 »
const duree = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`);
const dateHeure = (d) => new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Tunis', dateStyle: 'short', timeStyle: 'short' });
const echapper = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function messageUrgence(u, destinataires) {
  const empl = avecNumeros(u.emplacement ?? '?');
  const lignes = [
    ['Référence', u.reference], ['Lot', u.lot], ['Colis n°', u.colis], ['Posé en', empl], ['Destination', u.destination],
    ['Magasinier', u.matricule ? `${u.prenom ?? ''} ${u.nom ?? ''} (${u.matricule})`.trim() : '?'],
    ['Posé le', dateHeure(u.date_posee)], ['Attente', duree(u.minutes)],
  ];
  const sujet = `Sortie urgente en retard : ${u.reference} colis n° ${u.colis} en ${empl} depuis ${duree(u.minutes)}`;
  const texte = [
    'Bonjour,', '',
    `Une sortie urgente vers ${u.destination} n'est pas terminée depuis ${duree(u.minutes)} : le colis est posé près de la porte mais n'est pas encore sorti.`, '',
    ...lignes.map(([k, v]) => `${k} : ${v}`), '',
    'Merci de faire le nécessaire.', '', 'Magasin Kablem (mail automatique, ne pas répondre)',
  ].join('\n');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1c2340;max-width:560px">
  <div style="background:#d12b2b;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:17px;font-weight:700">Sortie urgente en retard · ${echapper(duree(u.minutes))}</div>
  <div style="border:1px solid #e3e7ef;border-top:0;padding:16px 18px;border-radius:0 0 10px 10px">
    <p style="margin:0 0 12px">Une sortie urgente vers <b>${echapper(u.destination)}</b> n'est pas terminée : le colis est posé près de la porte mais n'est pas encore sorti.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${lignes.map(([k, v]) => `<tr><td style="padding:6px 0;color:#667085;width:130px">${echapper(k)}</td><td style="padding:6px 0;font-weight:700">${echapper(v)}</td></tr>`).join('')}</table>
    <p style="margin:14px 0 0;font-size:12px;color:#667085">Magasin Kablem · mail automatique, ne pas répondre.</p>
  </div></div>`;
  return { to: destinataires.join(', '), subject: sujet, text: texte, html };
}

// Envoie un seul mail pour chaque sortie urgente posée depuis plus de N minutes. Renvoie le nombre de mails envoyés.
async function verifierUrgences(connexion = db) {
  const { destinataires, minutes } = await reglages(connexion);
  if (!destinataires.length) return 0;
  const [urgences] = await connexion.query(
    `SELECT u.id, u.reference, u.lot, u.colis, u.destination, u.emplacement, u.date_posee,
            m.matricule, m.nom, m.prenom, TIMESTAMPDIFF(MINUTE, u.date_posee, NOW()) AS minutes
     FROM sorties_urgentes u LEFT JOIN utilisateurs m ON m.id = u.utilisateur_id
     WHERE u.statut = 'posee' AND u.mail_envoye_le IS NULL AND u.date_posee <= NOW() - INTERVAL ? MINUTE
     ORDER BY u.date_posee`,
    [minutes]
  );
  let n = 0;
  for (const u of urgences) {
    // réservée d'abord : deux vérifications en même temps n'envoient jamais deux mails
    const [r] = await connexion.query('UPDATE sorties_urgentes SET mail_envoye_le = NOW() WHERE id = ? AND mail_envoye_le IS NULL', [u.id]);
    if (!r.affectedRows) continue;
    try {
      await envoyer(messageUrgence({ ...u, minutes: Number(u.minutes) }, destinataires));
      n++;
    } catch (err) {
      // pas envoyé (messagerie injoignable, compte pas réglé…) : on réessaiera à la prochaine vérification
      await connexion.query('UPDATE sorties_urgentes SET mail_envoye_le = NULL WHERE id = ?', [u.id]);
      console.error(`Mail de la sortie urgente ${u.id} non envoyé : ${err.message}`);
    }
  }
  return n;
}

// Vérification automatique : 20 s après le démarrage du serveur, puis chaque minute
function demarrerSurveillance() {
  const tour = () => verifierUrgences().catch((err) => console.error(`Vérification des sorties urgentes : ${err.message}`));
  setTimeout(tour, 20 * 1000);
  return setInterval(tour, VERIFICATION_MS);
}

function envoyerEssai(destinataires) {
  return envoyer({
    to: destinataires.join(', '),
    subject: "Magasin Kablem : mail d'essai",
    text: "Ceci est un mail d'essai du Magasin Kablem. Si vous le recevez, les mails d'alerte des sorties urgentes arriveront à cette adresse.",
    html: '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1c2340">Ceci est un mail d\'essai du <b>Magasin Kablem</b>.<br>Si vous le recevez, les mails d\'alerte des sorties urgentes arriveront à cette adresse.</div>',
  });
}

module.exports = { lireAdresses, reglages, compteConfigure, nomCompte, verifierUrgences, demarrerSurveillance, envoyerEssai, remplacerTransport, messageUrgence, MINUTES_DEFAUT };
