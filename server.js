const express = require('express');
const path = require('path');
const db = require('./db');
const { withToc, fetchSpec, referenceFrom } = require('./docs');

const app = express();
const PORT = process.env.PORT || 3016;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- Offentlige sider ----------

app.get('/', (req, res) => {
  const posts = db.prepare(
    'SELECT slug, title, summary, created_at FROM posts WHERE published = 1 ORDER BY created_at DESC'
  ).all();
  const links = db.prepare(
    'SELECT title, url, description, category, slug, access FROM links WHERE published = 1 ORDER BY sort_order ASC, created_at DESC'
  ).all();
  const docs = db.prepare(
    'SELECT slug, title, summary, product, version, updated_at FROM docs WHERE published = 1 ORDER BY sort_order ASC, title ASC'
  ).all();
  res.render('index', { posts, links, docs });
});

// ---------- App-sider ----------

const CONTACT_URL = process.env.CONTACT_URL || ''; // settes når kontaktskjemaet finnes (kontekst-oppgave #201)

app.get('/apper/:slug', (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!link) return res.status(404).render('404');
  const doc = link.docs_slug
    ? db.prepare('SELECT slug, title, summary, version, updated_at FROM docs WHERE slug = ? AND published = 1').get(link.docs_slug)
    : null;
  const contactUrl = CONTACT_URL ? `${CONTACT_URL}${CONTACT_URL.includes('?') ? '&' : '?'}app=${encodeURIComponent(link.slug)}` : '';
  res.render('app', { link, doc, contactUrl });
});

// ---------- Docs ----------

app.get('/docs', (req, res) => {
  const docs = db.prepare(
    'SELECT slug, title, summary, product, version, updated_at FROM docs WHERE published = 1 ORDER BY sort_order ASC, title ASC'
  ).all();
  res.render('docs-index', { docs });
});

app.get('/docs/:slug', async (req, res) => {
  const doc = db.prepare('SELECT * FROM docs WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!doc) return res.status(404).render('404');
  const { html, toc } = withToc(doc.content);
  const reference = referenceFrom(await fetchSpec(doc.openapi_url));
  if (reference) {
    toc.push({ level: 2, id: 'api-referanse', text: 'API-referanse' });
    reference.groups.forEach((g) => toc.push({ level: 3, id: g.id, text: g.tag }));
  }
  res.render('doc', { doc, html, toc, reference });
});

app.get('/post/:slug', (req, res) => {
  const post = db.prepare(
    'SELECT * FROM posts WHERE slug = ? AND published = 1'
  ).get(req.params.slug);
  if (!post) return res.status(404).render('404');
  res.render('post', { post });
});

// ---------- Internal admin API (kalles kun fra skydotten-mgmt-backend) ----------

function requireInternalToken(req, res, next) {
  if (!INTERNAL_TOKEN || req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

const api = express.Router();
api.use(requireInternalToken);

// Posts
api.get('/posts', (req, res) => {
  res.json(db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all());
});

api.post('/posts', (req, res) => {
  const { slug, title, summary, content, published } = req.body;
  if (!slug || !title || !content) return res.status(400).json({ error: 'slug, title og content er påkrevd' });
  const stmt = db.prepare(
    'INSERT INTO posts (slug, title, summary, content, published) VALUES (?, ?, ?, ?, ?)'
  );
  const info = stmt.run(slug, title, summary || '', content, published ? 1 : 0);
  res.status(201).json({ id: info.lastInsertRowid });
});

api.put('/posts/:id', (req, res) => {
  const { slug, title, summary, content, published } = req.body;
  db.prepare(
    `UPDATE posts SET slug = ?, title = ?, summary = ?, content = ?, published = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(slug, title, summary || '', content, published ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

api.delete('/posts/:id', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Links
api.get('/links', (req, res) => {
  res.json(db.prepare('SELECT * FROM links ORDER BY sort_order ASC, created_at DESC').all());
});

// slug/access/docs_slug/details er valgfrie (app-sider). access: 'open' | 'request'
const linkExtras = (b) => [b.slug || null, b.access === 'request' ? 'request' : 'open', b.docs_slug || null, b.details || null];

api.post('/links', (req, res) => {
  const { title, url, description, category, sort_order, published } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title og url er påkrevd' });
  try {
    const info = db.prepare(
      'INSERT INTO links (title, url, description, category, sort_order, published, slug, access, docs_slug, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(title, url, description || '', category || 'app', sort_order || 0, published ? 1 : 0, ...linkExtras(req.body));
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

api.put('/links/:id', (req, res) => {
  const { title, url, description, category, sort_order, published } = req.body;
  try {
    db.prepare(
      `UPDATE links SET title = ?, url = ?, description = ?, category = ?, sort_order = ?, published = ?,
         slug = ?, access = ?, docs_slug = ?, details = ?
       WHERE id = ?`
    ).run(title, url, description || '', category || 'app', sort_order || 0, published ? 1 : 0, ...linkExtras(req.body), req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

api.delete('/links/:id', (req, res) => {
  db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Docs (samme mønster som posts; content er HTML)
const DOC_FIELDS = ['slug', 'title', 'summary', 'product', 'version', 'app_url', 'openapi_url', 'content', 'sort_order', 'published'];
function docValues(b) {
  return [b.slug, b.title, b.summary || '', b.product || '', b.version || '', b.app_url || '', b.openapi_url || '', b.content,
    Number(b.sort_order) || 0, b.published ? 1 : 0];
}

api.get('/docs', (req, res) => {
  res.json(db.prepare('SELECT * FROM docs ORDER BY sort_order ASC, title ASC').all());
});

api.post('/docs', (req, res) => {
  const b = req.body || {};
  if (!b.slug || !b.title || !b.content) return res.status(400).json({ error: 'slug, title og content er påkrevd' });
  try {
    const info = db.prepare(`INSERT INTO docs (${DOC_FIELDS.join(', ')}) VALUES (${DOC_FIELDS.map(() => '?').join(', ')})`).run(...docValues(b));
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

api.put('/docs/:id', (req, res) => {
  const b = req.body || {};
  if (!b.slug || !b.title || !b.content) return res.status(400).json({ error: 'slug, title og content er påkrevd' });
  db.prepare(`UPDATE docs SET ${DOC_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...docValues(b), req.params.id);
  res.json({ ok: true });
});

api.delete('/docs/:id', (req, res) => {
  db.prepare('DELETE FROM docs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.use('/internal/api', api);

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`kontekst kjører på port ${PORT}`);
});
