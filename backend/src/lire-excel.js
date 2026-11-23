// Lecture d'un fichier de l'Italie (Excel .xlsx, ancien Excel .xls, ou .csv) pour l'import par référence :
// renvoie les lignes « référence <tab> quantité », lues ensuite comme un texte collé (import-resume.lireTexte).
// Les colonnes sont trouvées par leur en-tête (« Codice », « Somma di quantità »…), sinon la référence est la
// 1re cellule de texte de la ligne et la quantité le dernier nombre.
const ExcelJS = require('exceljs');
const { lirePieces } = require('./import-resume');

// ---------- Ancien Excel .xls (BIFF8 dans un conteneur OLE) : 1re feuille ----------
function lireXls(buf) {
  const tailleSecteur = 1 << buf.readUInt16LE(30);
  const tailleMini = 1 << buf.readUInt16LE(32);
  const secteur = (n) => 512 + n * tailleSecteur;
  const difat = [];
  for (let i = 0; i < 109; i++) difat.push(buf.readInt32LE(76 + i * 4));
  for (let s = buf.readInt32LE(68); s >= 0;) {
    const base = secteur(s);
    for (let i = 0; i < tailleSecteur / 4 - 1; i++) difat.push(buf.readInt32LE(base + i * 4));
    s = buf.readInt32LE(base + tailleSecteur - 4);
  }
  const fat = [];
  for (const s of difat.filter((x) => x >= 0)) {
    for (let i = 0; i < tailleSecteur / 4; i++) fat.push(buf.readInt32LE(secteur(s) + i * 4));
  }
  const chaine = (debut) => {
    const parts = [];
    for (let s = debut, garde = 0; s >= 0 && garde < fat.length; s = fat[s], garde++) parts.push(buf.subarray(secteur(s), secteur(s) + tailleSecteur));
    return Buffer.concat(parts);
  };
  const repertoire = chaine(buf.readInt32LE(48));
  const entrees = [];
  for (let o = 0; o + 128 <= repertoire.length; o += 128) {
    const lg = repertoire.readUInt16LE(o + 64);
    entrees.push({ nom: repertoire.subarray(o, o + Math.max(0, lg - 2)).toString('utf16le'), debut: repertoire.readInt32LE(o + 116), taille: repertoire.readUInt32LE(o + 120) });
  }
  const wb = entrees.find((e) => e.nom === 'Workbook' || e.nom === 'Book');
  if (!wb) throw new Error('classeur introuvable dans le fichier .xls');
  let flux;
  if (wb.taille >= buf.readUInt32LE(56)) {
    flux = chaine(wb.debut).subarray(0, wb.taille);
  } else {
    // petit flux : dans le mini-flux de l'entrée racine
    const racine = chaine(entrees[0].debut);
    const mf = chaine(buf.readInt32LE(60));
    const miniFat = [];
    for (let i = 0; i < mf.length / 4; i++) miniFat.push(mf.readInt32LE(i * 4));
    const parts = [];
    for (let s = wb.debut, garde = 0; s >= 0 && garde < miniFat.length; s = miniFat[s], garde++) parts.push(racine.subarray(s * tailleMini, (s + 1) * tailleMini));
    flux = Buffer.concat(parts).subarray(0, wb.taille);
  }
  const enregistrements = [];
  for (let o = 0; o + 4 <= flux.length;) {
    const lg = flux.readUInt16LE(o + 2);
    enregistrements.push({ type: flux.readUInt16LE(o), data: flux.subarray(o + 4, o + 4 + lg) });
    o += 4 + lg;
  }
  // Table des chaînes partagées (SST + CONTINUE) : une chaîne peut être coupée entre deux enregistrements
  const lireSST = (i) => {
    const blocs = [enregistrements[i].data];
    for (let j = i + 1; enregistrements[j]?.type === 0x003c; j++) blocs.push(enregistrements[j].data);
    let b = 0;
    let o = 8;
    const total = blocs[0].readUInt32LE(4);
    const lire = (n) => {
      if (o + n > blocs[b].length) { b++; o = 0; }
      const v = blocs[b].subarray(o, o + n);
      o += n;
      return v;
    };
    const chaines = [];
    for (let k = 0; k < total; k++) {
      if (o >= blocs[b].length) { b++; o = 0; }
      const cch = lire(2).readUInt16LE(0);
      let options = lire(1)[0];
      const runs = options & 8 ? lire(2).readUInt16LE(0) : 0;
      const ext = options & 4 ? lire(4).readUInt32LE(0) : 0;
      let texte = '';
      for (let reste = cch; reste > 0;) {
        if (o >= blocs[b].length) { b++; o = 0; options = blocs[b][o++]; }
        const large = options & 1;
        const n = Math.min(reste, Math.floor((blocs[b].length - o) / (large ? 2 : 1)));
        const morceau = blocs[b].subarray(o, o + n * (large ? 2 : 1));
        texte += large ? morceau.toString('utf16le') : morceau.toString('latin1');
        o += morceau.length;
        reste -= n;
      }
      for (let saut = runs * 4 + ext; saut > 0;) {
        if (o >= blocs[b].length) { b++; o = 0; }
        const n = Math.min(saut, blocs[b].length - o);
        o += n;
        saut -= n;
      }
      chaines.push(texte);
    }
    return chaines;
  };
  const rk = (v) => {
    let n;
    if (v & 2) n = v >> 2;
    else { const t = Buffer.alloc(8); t.writeInt32LE(v & 0xfffffffc, 4); n = t.readDoubleLE(0); }
    return v & 1 ? n / 100 : n;
  };
  let sst = [];
  let feuille = 0;
  const lignes = [];
  const poser = (l, c, v) => { (lignes[l] ??= [])[c] = v; };
  for (let i = 0; i < enregistrements.length; i++) {
    const { type, data } = enregistrements[i];
    if (type === 0x00fc) sst = lireSST(i);
    if (type === 0x0809) feuille++;
    if (feuille !== 2) continue; // 1 = classeur, 2 = première feuille
    if (type === 0x000a) break; // fin de la première feuille
    if (![0x00fd, 0x0203, 0x027e, 0x00bd, 0x0204, 0x0006].includes(type)) continue; // pas une cellule
    const l = data.readUInt16LE(0);
    const c = data.readUInt16LE(2);
    if (type === 0x00fd) poser(l, c, sst[data.readUInt32LE(6)]);
    else if (type === 0x0203) poser(l, c, data.readDoubleLE(6));
    else if (type === 0x027e) poser(l, c, rk(data.readInt32LE(6)));
    else if (type === 0x0006 && data.readUInt16LE(12) !== 0xffff) poser(l, c, data.readDoubleLE(6)); // formule : son résultat numérique
    else if (type === 0x00bd) {
      for (let k = 0; k < (data.length - 6) / 6; k++) poser(l, c + k, rk(data.readInt32LE(6 + k * 6)));
    } else if (type === 0x0204) {
      const cch = data.readUInt16LE(6);
      poser(l, c, data[8] & 1 ? data.subarray(9, 9 + cch * 2).toString('utf16le') : data.subarray(9, 9 + cch).toString('latin1'));
    }
  }
  return lignes.filter(Boolean).map((l) => Array.from(l, (v) => v ?? ''));
}

// ---------- Excel .xlsx : la 1re feuille qui a des données ----------
async function lireXlsx(buf) {
  const classeur = new ExcelJS.Workbook();
  await classeur.xlsx.load(buf);
  for (const feuille of classeur.worksheets) {
    const lignes = [];
    feuille.eachRow({ includeEmpty: false }, (ligne) => {
      const cellules = [];
      ligne.eachCell({ includeEmpty: true }, (cellule, col) => {
        let v = cellule.value;
        if (v && typeof v === 'object') v = v.result ?? v.text ?? (Array.isArray(v.richText) ? v.richText.map((r) => r.text).join('') : '');
        cellules[col - 1] = v ?? '';
      });
      lignes.push(Array.from(cellules, (v) => v ?? ''));
    });
    if (lignes.length) return lignes;
  }
  return [];
}

// ---------- CSV (séparateur ; , ou tabulation) ----------
function lireCsv(buf) {
  const texte = buf.toString('utf8').replace(/^﻿/, '');
  const sep = [';', '\t', ','].find((s) => texte.split('\n')[0].includes(s)) ?? ';';
  return texte.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, '').trim()));
}

const EN_TETE_REF = /^(codice|cod\.?|code|r[ée]f[ée]rence|r[ée]f\.?|articolo|article)\b/i;
const EN_TETE_QTE = /(somma|quantit|qt[aàé]|qty)/i;
const estNombre = (v) => typeof v === 'number' || /^\d[\d\s.,]*$/.test(String(v).trim());
const texteNombre = (v) => (typeof v === 'number' ? String(Math.round(v)) : String(v).trim());

// Lignes du tableau → texte « référence <tab> quantité » : une ligne par référence ; plusieurs lignes d'une
// même référence (packing détaillé, une ligne par lot) sont additionnées, comme « Somma di quantità »
function texteDesLignes(lignes) {
  let refCol = -1;
  let qteCol = -1;
  let debut = 0;
  for (let i = 0; i < Math.min(lignes.length, 30); i++) {
    const cellules = lignes[i].map((c) => String(c).trim());
    const r = cellules.findIndex((c) => EN_TETE_REF.test(c));
    // la quantité de pièces d'abord (« Somma di quantità »), pas le nombre de colis (« Somma di colli »)
    const q = [/quantit|qt[aàé]|qty/i, EN_TETE_QTE].map((motif) => cellules.findIndex((c, k) => k !== r && motif.test(c))).find((k) => k >= 0) ?? -1;
    if (r >= 0 && q >= 0) {
      [refCol, qteCol, debut] = [r, q, i + 1];
      break;
    }
  }
  const sortie = [];
  const sommes = new Map(); // référence → { pieces } (une seule ligne de sortie par référence)
  for (const l of lignes.slice(debut)) {
    let ref;
    let qte;
    if (refCol >= 0) {
      ref = String(l[refCol] ?? '').trim();
      qte = l[qteCol];
    } else {
      // sans en-tête : 1re cellule de texte contenant un chiffre, puis le dernier nombre après elle
      const k = l.findIndex((c) => typeof c === 'string' && /\d/.test(c) && !estNombre(c));
      if (k < 0) continue;
      ref = l[k].trim();
      qte = l.slice(k + 1).reverse().find((c) => c !== '' && estNombre(c));
    }
    if (!ref || qte === undefined || qte === '' || !estNombre(qte)) continue;
    const n = typeof qte === 'number' ? Math.round(qte) : lirePieces(qte);
    const cle = ref.replace(/\s+/g, ' ').toUpperCase();
    if (n === null || /^tota/i.test(ref)) sortie.push({ ref, texte: texteNombre(qte) }); // tel quel : signalé ou ignoré à la lecture
    else if (sommes.has(cle)) sommes.get(cle).pieces += n;
    else {
      const s = { ref, pieces: n };
      sommes.set(cle, s);
      sortie.push(s);
    }
  }
  return sortie.map((s) => `${s.ref}\t${s.texte ?? s.pieces}`).join('\n');
}

// Fichier (Buffer) → { texte, lignes } ; erreur claire si le format n'est pas lu
async function lireFichierReferences(buf, nom = '') {
  const ext = String(nom).toLowerCase().split('.').pop();
  let lignes;
  if (buf.subarray(0, 4).toString('hex') === 'd0cf11e0' || ext === 'xls') lignes = lireXls(buf); // ancien Excel
  else if (buf.subarray(0, 2).toString() === 'PK' || ext === 'xlsx') lignes = await lireXlsx(buf);
  else if (ext === 'csv' || ext === 'txt') lignes = lireCsv(buf);
  else throw Object.assign(new Error('Format non lu : choisissez un fichier Excel (.xlsx, .xls) ou .csv.'), { status: 400 });
  const texte = texteDesLignes(lignes);
  return { texte, lignes: texte ? texte.split('\n').length : 0 };
}

module.exports = { lireFichierReferences, texteDesLignes, lireXls, lireXlsx };
