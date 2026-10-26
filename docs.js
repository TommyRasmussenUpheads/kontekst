// Hjelpere for Docs-seksjonen: innholdsfortegnelse fra h2/h3 og API-referanse fra OpenAPI.

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'seksjon';
}

// Gir h2/h3 id-er (hvis de mangler) og returnerer { html, toc }
function withToc(html) {
  const toc = [];
  const used = new Set();
  const out = String(html).replace(/<(h2|h3)([^>]*)>([\s\S]*?)<\/\1>/gi, (m, tag, attrs, inner) => {
    let id = (attrs.match(/\sid="([^"]+)"/) || [])[1];
    if (!id) {
      id = slugify(inner);
      let n = 2;
      while (used.has(id)) id = `${slugify(inner)}-${n++}`;
      attrs += ` id="${id}"`;
    }
    used.add(id);
    toc.push({ level: tag.toLowerCase() === 'h2' ? 2 : 3, id, text: inner.replace(/<[^>]+>/g, '').trim() });
    return `<${tag}${attrs}>${inner}</${tag}>`;
  });
  return { html: out, toc };
}

// OpenAPI-spesifikasjoner hentes server-side og caches i 10 min. Feiler stille (siden vises uten referanse).
const cache = new Map();
const TTL = 10 * 60 * 1000;

async function fetchSpec(url) {
  if (!url) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.spec;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const spec = await res.json();
    cache.set(url, { at: Date.now(), spec });
    return spec;
  } catch (e) {
    console.warn(`[docs] Kunne ikke hente OpenAPI fra ${url}: ${e.message}`);
    return hit ? hit.spec : null; // bruk gammel versjon hvis vi har en
  }
}

// Gjør spesifikasjonen om til en enkel struktur for visning, gruppert på tag
function referenceFrom(spec) {
  if (!spec || !spec.paths) return null;
  const groups = new Map();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = (op.tags && op.tags[0]) || 'Annet';
      if (!groups.has(tag)) groups.set(tag, []);
      const body = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
      const schema = body && body.schema;
      groups.get(tag).push({
        method: method.toUpperCase(),
        path,
        summary: op.summary || '',
        params: (op.parameters || []).map((p) => ({ name: p.name, in: p.in, required: Boolean(p.required), type: (p.schema && p.schema.type) || 'string', description: p.description || '' })),
        body: schema && schema.properties
          ? Object.entries(schema.properties).map(([name, s]) => ({ name, type: s.type || 'string', required: (schema.required || []).includes(name), description: s.description || '' }))
          : [],
      });
    }
  }
  return {
    title: spec.info && spec.info.title,
    version: spec.info && spec.info.version,
    server: spec.servers && spec.servers[0] && spec.servers[0].url,
    groups: [...groups.entries()].map(([tag, ops]) => ({ tag, id: `ref-${slugify(tag)}`, ops })),
  };
}

module.exports = { withToc, fetchSpec, referenceFrom, slugify };
