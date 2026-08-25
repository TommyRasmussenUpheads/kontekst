const express = require('express');
const path = require('path');
const db = require('./db');

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
    'SELECT title, url, description, category FROM links WHERE published = 1 ORDER BY sort_order ASC, created_at DESC'
  ).all();
  res.render('index', { posts, links });
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

api.post('/links', (req, res) => {
  const { title, url, description, category, sort_order, published } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title og url er påkrevd' });
  const info = db.prepare(
    'INSERT INTO links (title, url, description, category, sort_order, published) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, url, description || '', category || 'app', sort_order || 0, published ? 1 : 0);
  res.status(201).json({ id: info.lastInsertRowid });
});

api.put('/links/:id', (req, res) => {
  const { title, url, description, category, sort_order, published } = req.body;
  db.prepare(
    `UPDATE links SET title = ?, url = ?, description = ?, category = ?, sort_order = ?, published = ?
     WHERE id = ?`
  ).run(title, url, description || '', category || 'app', sort_order || 0, published ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

api.delete('/links/:id', (req, res) => {
  db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.use('/internal/api', api);

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`kontekst kjører på port ${PORT}`);
});
