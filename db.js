const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kontekst.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    content TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'app',
    sort_order INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Dokumentasjon for apper/API-er (Docs-seksjonen). content er HTML; h2/h3 blir innholdsfortegnelse.
  CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    product TEXT,
    version TEXT,
    app_url TEXT,
    openapi_url TEXT,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrering: app-sider (/apper/:slug). SQLite mangler ADD COLUMN IF NOT EXISTS, så vi sjekker først.
const linkCols = db.prepare('PRAGMA table_info(links)').all().map((c) => c.name);
const addCol = (name, def) => { if (!linkCols.includes(name)) db.exec(`ALTER TABLE links ADD COLUMN ${name} ${def}`); };
addCol('slug', 'TEXT');            // satt = kortet går til egen app-side i stedet for rett til url
addCol('access', "TEXT DEFAULT 'open'"); // 'open' eller 'request' (krever tilgang)
addCol('docs_slug', 'TEXT');       // lenke til /docs/:slug
addCol('details', 'TEXT');         // utfyllende tekst (HTML) på app-siden
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS links_slug_idx ON links(slug) WHERE slug IS NOT NULL');

// Kontaktskjema (kontekst-201). topic = app-slug eller 'generelt'.
db.exec(`
  CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    company TEXT,
    topic TEXT NOT NULL,
    message TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    verified_by TEXT,
    email_status TEXT,
    email_error TEXT,
    mgmt_task_id INTEGER,
    mgmt_attempts INTEGER NOT NULL DEFAULT 0,
    mgmt_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
