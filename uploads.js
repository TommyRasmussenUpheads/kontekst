// Bildeopplasting (MGMT-211). Filene ligger på volumet (data/uploads), så de overlever rebuild.
// Metadata ligger i tabellen uploads. Opplasting skjer bare via det interne API-et fra MGMT.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'data', 'uploads');
const MAX_BYTES = 8 * 1024 * 1024;
const PUBLIC_PREFIX = '/uploads/';

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE NOT NULL,
    original_name TEXT,
    alt TEXT,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Bestem bildetype ut fra innholdet (magic bytes), ikke filnavn eller oppgitt mime-type.
function detectType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6))) return { mime: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

// Les bredde/høyde fra bildeheaderen, så <img> kan få width/height og siden ikke hopper ved lasting.
function dimensions(buf, ext) {
  try {
    if (ext === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (ext === 'webp') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (_) { /* ukjent/avkortet header: lagre uten mål */ }
  return { width: null, height: null };
}

function slugify(name) {
  const base = String(name || 'bilde').replace(/\.[^.]*$/, '');
  return base.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/æ/gi, 'ae').replace(/ø/gi, 'o').replace(/å/gi, 'a')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'bilde';
}

const withUrl = (row) => ({ ...row, url: PUBLIC_PREFIX + row.filename });

// Offentlig servering av filene. Bare rasterbilder slippes inn, men nosniff for sikkerhets skyld.
const publicStatic = express.static(UPLOADS_DIR, {
  maxAge: '365d',
  immutable: true,
  index: false,
  dotfiles: 'deny',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
});

// Interne ruter (monteres bak requireInternalToken).
const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM uploads ORDER BY id DESC').all().map(withUrl));
});

// Body: { filename, alt?, data } der data er base64 (data:-URL-prefiks tillates).
router.post('/', (req, res) => {
  const { filename, alt } = req.body || {};
  let { data } = req.body || {};
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'data (base64) er påkrevd' });
  data = data.replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'tom fil' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'bildet er større enn 8 MB' });
  const type = detectType(buf);
  if (!type) return res.status(415).json({ error: 'bare png, jpg, webp og gif er tillatt' });

  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const name = `${slugify(filename)}-${hash}.${type.ext}`;

  // Samme bilde lastet opp før: gi tilbake den eksisterende raden.
  const existing = db.prepare('SELECT * FROM uploads WHERE filename = ?').get(name);
  if (existing) return res.json({ ...withUrl(existing), duplicate: true });

  const { width, height } = dimensions(buf, type.ext);
  // Filnavnet inneholder innholdshashen, så en fil som allerede ligger der er identisk
  const file = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  const info = db.prepare(
    'INSERT INTO uploads (filename, original_name, alt, mime_type, size, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, filename || null, alt || '', type.mime, buf.length, width, height);
  res.status(201).json(withUrl(db.prepare('SELECT * FROM uploads WHERE id = ?').get(info.lastInsertRowid)));
});

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'fant ikke bildet' });
  db.prepare('UPDATE uploads SET alt = ? WHERE id = ?').run(String((req.body || {}).alt || ''), row.id);
  res.json(withUrl(db.prepare('SELECT * FROM uploads WHERE id = ?').get(row.id)));
});

// Sletting nektes hvis bildet brukes i en post, side eller app-side, med mindre ?force=1.
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'fant ikke bildet' });
  const like = `%${row.filename}%`;
  const usedIn = [
    ...db.prepare('SELECT title FROM posts WHERE content LIKE ?').all(like).map((r) => `post «${r.title}»`),
    ...db.prepare('SELECT title FROM docs WHERE content LIKE ?').all(like).map((r) => `docs «${r.title}»`),
    ...db.prepare('SELECT title FROM links WHERE details LIKE ?').all(like).map((r) => `app-side «${r.title}»`),
  ];
  if (usedIn.length && req.query.force !== '1') {
    return res.status(409).json({ error: `bildet brukes i ${usedIn.join(', ')}`, used_in: usedIn });
  }
  fs.rmSync(path.join(UPLOADS_DIR, row.filename), { force: true });
  db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = { router, publicStatic, UPLOADS_DIR };
