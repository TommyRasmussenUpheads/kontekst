// Kontaktskjema (kontekst-201): /kontakt
// Flyt: skjema -> botsjekk -> lagres i SQLite -> e-post til Tommy (SMTP2Go) + oppgave i MGMT -> takk-side.
// Botsjekk i lag:
//   1. Cloudflare Turnstile, verifisert server-side (aktiv når TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY er satt)
//   2. Honeypot-felt som mennesker ikke ser
//   3. Signert tidsstempel: skjemaet må ha vært åpent i minst MIN_FILL_MS og maks MAX_AGE_MS
//   4. Rate limit per IP
// Avsender får bare en takk-side, ingen e-post: en åpen skjema-til-e-post-funksjon kan misbrukes til å sende spam til andre.
const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const turnstileOn = () => Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);

const NOTIFY_TO = process.env.CONTACT_NOTIFY_TO || 'tommy@skydotten.no';
const SMTP2GO_API_KEY = process.env.SMTP2GO_API_KEY || '';
const SENDER = process.env.SMTP2GO_SENDER || 'kontekst <no-reply@skydotten.no>';

const MGMT_API = (process.env.MGMT_API_URL || '').replace(/\/$/, '');
const MGMT_TOKEN = process.env.MGMT_CONTACT_TOKEN || '';
const MGMT_PROJECT_ID = Number(process.env.MGMT_PROJECT_ID) || 15;
const mgmtOn = () => Boolean(MGMT_API && MGMT_TOKEN);

// Signerer tidsstempelet i skjemaet. Uten fast nøkkel lages en ny ved oppstart (skjemaer åpnet før en
// omstart må da sendes på nytt, og brukeren får beskjed om det).
const FORM_SECRET = process.env.CONTACT_FORM_SECRET || crypto.randomBytes(32).toString('hex');
const MIN_FILL_MS = 3000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5; // innsendinger per IP per time

const MGMT_RETRY_MS = 10 * 60 * 1000;
const MGMT_MAX_ATTEMPTS = 50;

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const LIMITS = { name: 100, email: 200, company: 120, message: 5000 };
const GENERAL = { value: 'generelt', label: 'Generell henvendelse' };

// ---------- Hjelpere ----------

function clientIp(req) {
  // Bak Cloudflare -> NPM: ekte IP kommer i CF-Connecting-IP
  return req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'ukjent';
}

function sign(ts) {
  return crypto.createHmac('sha256', FORM_SECRET).update(String(ts)).digest('hex').slice(0, 32);
}

function newFormToken() {
  const ts = Date.now();
  return `${ts}.${sign(ts)}`;
}

function checkFormToken(token) {
  const [tsStr, sig] = String(token || '').split('.');
  const ts = Number(tsStr);
  if (!ts || !sig) return 'invalid';
  const expected = sign(ts);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return 'invalid';
  const age = Date.now() - ts;
  if (age < MIN_FILL_MS) return 'too-fast';
  if (age > MAX_AGE_MS) return 'expired';
  return 'ok';
}

function topics() {
  const apps = db.prepare(
    'SELECT slug, title FROM links WHERE published = 1 AND slug IS NOT NULL ORDER BY sort_order ASC, title ASC'
  ).all();
  return [...apps.map((a) => ({ value: a.slug, label: `Tilgang til ${a.title}` })), GENERAL];
}

const hits = new Map(); // ip -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (e.resetAt <= now) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

function rateLimited(ip) {
  const now = Date.now();
  let e = hits.get(ip);
  if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + RATE_WINDOW_MS }; hits.set(ip, e); }
  e.count += 1;
  return e.count > RATE_MAX;
}

async function verifyTurnstile(token, ip) {
  if (!token) return { ok: false, reason: 'missing-input-response' };
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.success) return { ok: false, reason: (data['error-codes'] || []).join(',') || `HTTP ${res.status}` };
    if (data.action && data.action !== 'kontakt') return { ok: false, reason: `feil action: ${data.action}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' ? 'tidsavbrudd mot Cloudflare' : e.message };
  }
}

// ---------- Varsling ----------

function whenOslo(sqliteTs) {
  return new Date(`${sqliteTs.replace(' ', 'T')}Z`).toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' });
}

async function sendNotification(msg, topicLabel) {
  if (!SMTP2GO_API_KEY) return { ok: false, error: 'SMTP2GO_API_KEY mangler' };
  const text = [
    `Ny henvendelse via kontaktskjemaet på kontekst.skydotten.no`,
    '',
    `Gjelder: ${topicLabel}`,
    `Fra:     ${msg.name} <${msg.email}>`,
    `Firma:   ${msg.company || '-'}`,
    `Tid:     ${whenOslo(msg.created_at)}`,
    '',
    '-'.repeat(60),
    msg.message,
    '-'.repeat(60),
    '',
    `Svar på denne e-posten for å svare avsenderen direkte. (kontakt-ID ${msg.id})`,
  ].join('\n');
  try {
    const res = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': SMTP2GO_API_KEY },
      body: JSON.stringify({
        sender: SENDER,
        to: [NOTIFY_TO],
        subject: `[kontekst] ${topicLabel}: ${msg.name}`,
        text_body: text,
        custom_headers: [{ header: 'Reply-To', value: msg.email }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    const data = body.data || {};
    return res.ok && data.succeeded >= 1
      ? { ok: true }
      : { ok: false, error: (data.failures && data.failures.join('; ')) || data.error || `SMTP2Go svarte ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function topicLabelFor(value) {
  return (topics().find((t) => t.value === value) || { label: value }).label;
}

async function sendToMgmt(msg) {
  if (!mgmtOn()) return null;
  const label = topicLabelFor(msg.topic);
  const description = [
    '**Henvendelse fra kontaktskjemaet på kontekst.skydotten.no** (opprettet automatisk, pri 5 = ikke prioritert ennå)',
    '',
    msg.message.split('\n').map((l) => `> ${l}`).join('\n'),
    '',
    `- **Gjelder:** ${label}`,
    `- **Fra:** ${msg.name} (${msg.email})`,
    `- **Firma:** ${msg.company || '-'}`,
    `- **Tid:** ${whenOslo(msg.created_at)}`,
    `- **Botsjekk:** ${msg.verified_by}`,
    `- **kontekst kontakt-ID:** ${msg.id}`,
  ].join('\n');
  try {
    const res = await fetch(`${MGMT_API}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MGMT_TOKEN}` },
      body: JSON.stringify({
        project_id: MGMT_PROJECT_ID,
        priority: 5,
        type: 'kontakt',
        source: 'kontekst',
        title: `[Kontakt] ${label}: ${msg.name}`.slice(0, 200),
        description,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const taskId = body.task ? body.task.id : body.id;
    if (!taskId) throw new Error('MGMT svarte uten oppgave-ID');
    db.prepare('UPDATE contact_messages SET mgmt_task_id = ?, mgmt_attempts = mgmt_attempts + 1, mgmt_error = NULL WHERE id = ?')
      .run(taskId, msg.id);
    console.log(`[kontakt] #${msg.id} sendt til MGMT som oppgave #${taskId}`);
    return taskId;
  } catch (e) {
    const cause = e.cause && (e.cause.code || e.cause.message);
    const err = cause ? `${e.message} (${cause})` : e.message;
    db.prepare('UPDATE contact_messages SET mgmt_attempts = mgmt_attempts + 1, mgmt_error = ? WHERE id = ?').run(err, msg.id);
    console.error(`[kontakt] #${msg.id} kunne ikke sendes til MGMT: ${err}`);
    return null;
  }
}

async function retryPending() {
  if (!mgmtOn()) return;
  const rows = db.prepare(
    'SELECT * FROM contact_messages WHERE mgmt_task_id IS NULL AND mgmt_attempts < ? ORDER BY id LIMIT 20'
  ).all(MGMT_MAX_ATTEMPTS);
  for (const m of rows) await sendToMgmt(m);
}

function startRetryLoop() {
  if (!turnstileOn()) console.warn('[kontakt] TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY mangler – skjemaet har bare honeypot, tidssjekk og rate limit');
  if (!SMTP2GO_API_KEY) console.warn('[kontakt] SMTP2GO_API_KEY mangler – ingen e-postvarsel ved nye henvendelser');
  if (!mgmtOn()) { console.warn('[kontakt] MGMT_API_URL/MGMT_CONTACT_TOKEN mangler – henvendelser blir ikke oppgaver i MGMT'); return; }
  retryPending().catch((e) => console.error('[kontakt] retry feilet', e));
  setInterval(() => retryPending().catch((e) => console.error('[kontakt] retry feilet', e)), MGMT_RETRY_MS).unref();
}

// ---------- Ruter ----------

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '20kb' }));

function renderForm(res, { values = {}, errors = [], status = 200 } = {}) {
  res.status(status).render('contact', {
    values,
    errors,
    topics: topics(),
    formToken: newFormToken(),
    turnstileSiteKey: turnstileOn() ? TURNSTILE_SITE_KEY : '',
    limits: LIMITS,
  });
}

router.get('/', (req, res) => {
  const all = topics();
  const wanted = String(req.query.app || '');
  const topic = all.some((t) => t.value === wanted) ? wanted : '';
  renderForm(res, { values: { topic } });
});

router.post('/', async (req, res) => {
  const ip = clientIp(req);
  const b = req.body || {};
  const values = {
    name: String(b.name || '').trim(),
    email: String(b.email || '').trim(),
    company: String(b.company || '').trim(),
    topic: String(b.topic || '').trim(),
    message: String(b.message || '').replace(/\r\n/g, '\n').trim(),
  };

  // Honeypot fylt ut: late som alt gikk fint, så boten ikke lærer noe
  if (b.website) {
    console.warn(`[kontakt] honeypot utløst fra ${ip}`);
    return res.redirect(303, '/kontakt/takk');
  }

  if (rateLimited(ip)) {
    res.set('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
    return renderForm(res, { values, status: 429, errors: ['Du har sendt mange meldinger på kort tid. Prøv igjen om en time.'] });
  }

  const errors = [];
  if (!values.name) errors.push('Skriv inn navnet ditt.');
  if (values.name.length > LIMITS.name) errors.push(`Navnet kan være maks ${LIMITS.name} tegn.`);
  if (!EMAIL_RE.test(values.email) || values.email.length > LIMITS.email) errors.push('Skriv inn en gyldig e-postadresse.');
  if (values.company.length > LIMITS.company) errors.push(`Firmanavnet kan være maks ${LIMITS.company} tegn.`);
  if (!topics().some((t) => t.value === values.topic)) errors.push('Velg hva henvendelsen gjelder.');
  if (values.message.length < 10) errors.push('Meldingen må være minst 10 tegn.');
  if (values.message.length > LIMITS.message) errors.push(`Meldingen kan være maks ${LIMITS.message} tegn.`);

  const tokenState = checkFormToken(b.form_token);
  if (tokenState === 'too-fast') errors.push('Det gikk litt fort. Vent et par sekunder og send på nytt.');
  else if (tokenState !== 'ok') errors.push('Skjemaet var utløpt. Sjekk feltene og send på nytt.');

  if (errors.length) return renderForm(res, { values, errors, status: 400 });

  let verifiedBy = 'honeypot+tid+rate-limit';
  if (turnstileOn()) {
    const v = await verifyTurnstile(b['cf-turnstile-response'], ip);
    if (!v.ok) {
      console.warn(`[kontakt] Turnstile avviste ${ip}: ${v.reason}`);
      return renderForm(res, { values, status: 400, errors: ['Vi klarte ikke å bekrefte at du er et menneske. Fullfør sjekken nederst og prøv igjen.'] });
    }
    verifiedBy = 'turnstile';
  }

  const info = db.prepare(
    `INSERT INTO contact_messages (name, email, company, topic, message, ip, user_agent, verified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(values.name, values.email, values.company || null, values.topic, values.message, ip,
    String(req.headers['user-agent'] || '').slice(0, 300), verifiedBy);
  const msg = db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(info.lastInsertRowid);

  const mail = await sendNotification(msg, topicLabelFor(msg.topic));
  db.prepare('UPDATE contact_messages SET email_status = ?, email_error = ? WHERE id = ?')
    .run(mail.ok ? 'sendt' : 'feilet', mail.ok ? null : mail.error, msg.id);
  if (!mail.ok) console.error(`[kontakt] #${msg.id} e-postvarsel feilet: ${mail.error}`);
  sendToMgmt(msg).catch(() => {}); // fire-and-forget, retry-løkka tar resten

  res.redirect(303, '/kontakt/takk');
});

router.get('/takk', (req, res) => res.render('contact-thanks'));

module.exports = { router, startRetryLoop };
