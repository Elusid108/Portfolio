// Social sharing output.
//
// The live site is a single index.html with hash routing (#project/<id>), and
// social crawlers ignore fragments, so every shared project would otherwise get
// the same generic preview. Publish therefore writes, under <repo>/share/:
//
//   share/<id>.html        one tiny static page per published project carrying
//                          Open Graph + Twitter meta, which redirects humans to
//                          ../#project/<id>
//   share/cards/<id>.jpg   1200x630 preview card rendered by the CMS browser
//   share/cards/site.jpg   site-wide card (hero board) referenced from index.html
//
// Cards are remade only when their visible inputs change. Fingerprints live in
// CMS/data/share-manifest.json (not served on the live site).
//
// og:url and canonical point at the share page itself: Facebook re-scrapes
// og:url, so pointing it at the hash URL would lose the per-project tags.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const SHARE_DIR = path.join(PORTFOLIO_ROOT, 'share');
const CARDS_DIR = path.join(SHARE_DIR, 'cards');
const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'share-manifest.json');
const CARD_W = 1200;
const CARD_H = 630;
// Bump when the canvas layout in public/js/share-cards.js changes so every
// card remakes once. Independent of the CMS package version.
const RENDERER_VERSION = 1;

// Same order and labels as share-cards.js / the site hero board.
const HERO_CATEGORIES = [
  { id: 'Lighting', label: 'Lighting' },
  { id: 'Art', label: 'Art' },
  { id: 'Fixtures', label: 'Fixtures' },
  { id: 'Software', label: 'Software' },
  { id: 'Tooling', label: 'Shop' },
  { id: 'Systems', label: 'Systems' }
];

const DEFAULTS = {
  site_url: 'https://chrismoore.me',
  site_title: 'Chris Moore Designs',
  site_description: 'Creative Technologist & Systems Integrator'
};

function siteConfig(settings = {}) {
  const url = String(settings.site_url || DEFAULTS.site_url).trim().replace(/\/+$/, '');
  return {
    url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
    title: String(settings.site_title || DEFAULTS.site_title).trim(),
    description: String(settings.site_description || DEFAULTS.site_description).trim()
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max = 200) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

function cardWebPath(id) {
  return `share/cards/${safeId(id)}.jpg`;
}

function cardExists(id) {
  return fs.existsSync(path.join(PORTFOLIO_ROOT, ...cardWebPath(id).split('/')));
}

// --- incremental fingerprints ------------------------------------------------------
// A card remakes only when something that appears on it changed: title, short
// description, category, thumbnail path/bytes, crop, or site branding. Gallery,
// specs, tags, etc. are ignored.

function readManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { rendererVersion: 0, cards: {} };
    return {
      rendererVersion: Number(raw.rendererVersion) || 0,
      cards: raw.cards && typeof raw.cards === 'object' ? raw.cards : {}
    };
  } catch {
    return { rendererVersion: 0, cards: {} };
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
}

function fingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function fitStamp(fit) {
  if (!fit || typeof fit !== 'object') return null;
  return {
    scale: Number(fit.scale) || 1,
    x: Number.isFinite(Number(fit.x)) ? Number(fit.x) : 50,
    y: Number.isFinite(Number(fit.y)) ? Number(fit.y) : 50
  };
}

function mediaStamp(relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  if (/^https?:\/\//i.test(relPath)) return { remote: relPath };
  const cleaned = relPath.replace(/^\/+/, '').replace(/\\/g, '/');
  const abs = path.join(PORTFOLIO_ROOT, ...cleaned.split('/'));
  const root = PORTFOLIO_ROOT.endsWith(path.sep) ? PORTFOLIO_ROOT : PORTFOLIO_ROOT + path.sep;
  if (abs !== PORTFOLIO_ROOT && !abs.startsWith(root)) return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { missing: cleaned };
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return { missing: cleaned };
  }
}

function heroProjectsByCategory(projects) {
  return HERO_CATEGORIES.map(cat => {
    const list = (projects || []).filter(p => p.category === cat.id && p.draft !== true);
    const featured = list.find(p => p.featured === true);
    const project = featured || list.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0] || null;
    return { ...cat, project };
  });
}

function projectCardPayload(project, site) {
  const image = project.thumbnail || project.image || '';
  return {
    v: RENDERER_VERSION,
    title: project.title || '',
    description: stripHtml(project.description),
    category: project.category || '',
    image,
    fit: fitStamp(project.thumbnailFit),
    media: mediaStamp(image),
    site_title: site.title,
    site_url: site.url
  };
}

function siteCardPayload(projects, site) {
  return {
    v: RENDERER_VERSION,
    site_title: site.title,
    site_description: site.description,
    site_url: site.url,
    tiles: heroProjectsByCategory(projects).map(tile => {
      const p = tile.project;
      const image = p ? (p.thumbnail || p.image || '') : '';
      return {
        id: tile.id,
        projectId: p ? String(p.id) : null,
        image,
        fit: p ? fitStamp(p.thumbnailFit) : null,
        media: p ? mediaStamp(image) : null
      };
    })
  };
}

function currentFingerprints(projects, settings) {
  const published = (projects || []).filter(p => p && p.draft !== true && p.id != null);
  const site = siteConfig(settings);
  const out = { site: fingerprint(siteCardPayload(published, site)) };
  for (const p of published) {
    out[safeId(p.id)] = fingerprint(projectCardPayload(p, site));
  }
  return out;
}

function recordWrittenCards(ids, projects, settings) {
  if (!ids || !ids.length) return;
  const current = currentFingerprints(projects, settings);
  const manifest = readManifest();
  manifest.rendererVersion = RENDERER_VERSION;
  for (const id of ids) {
    const key = safeId(id);
    if (current[key]) manifest.cards[key] = current[key];
  }
  writeManifest(manifest);
}

function pruneManifest(projects) {
  const keep = new Set(['site', ...(projects || []).map(p => safeId(p.id))]);
  const manifest = readManifest();
  let changed = false;
  for (const key of Object.keys(manifest.cards)) {
    if (keep.has(key)) continue;
    delete manifest.cards[key];
    changed = true;
  }
  if (changed) writeManifest(manifest);
}

// Compare current card inputs to the last successful write. Missing JPEGs and
// a renderer-version bump both force a remake.
function planCards(projects, settings) {
  const published = (projects || []).filter(p => p && p.draft !== true && p.id != null);
  const current = currentFingerprints(published, settings);
  const manifest = readManifest();
  const staleRenderer = manifest.rendererVersion !== RENDERER_VERSION;
  const ids = ['site', ...published.map(p => safeId(p.id))];
  const render = [];
  for (const id of ids) {
    const stored = !staleRenderer && manifest.cards[id];
    if (!cardExists(id) || !stored || stored !== current[id]) render.push(id);
  }
  return { render, skip: ids.length - render.length, total: ids.length };
}

// --- meta tags ---------------------------------------------------------------------

function metaBlock({ url, title, description, image, imageAlt, type = 'website', siteName }) {
  const lines = [
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="${escapeHtml(type)}">`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`
  ];
  if (image) {
    lines.push(
      `<meta property="og:image" content="${escapeHtml(image)}">`,
      `<meta property="og:image:secure_url" content="${escapeHtml(image)}">`,
      `<meta property="og:image:type" content="image/jpeg">`,
      `<meta property="og:image:width" content="${CARD_W}">`,
      `<meta property="og:image:height" content="${CARD_H}">`,
      `<meta property="og:image:alt" content="${escapeHtml(imageAlt || title)}">`
    );
  }
  lines.push(
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`
  );
  if (image) lines.push(`<meta name="twitter:image" content="${escapeHtml(image)}">`, `<meta name="twitter:image:alt" content="${escapeHtml(imageAlt || title)}">`);
  lines.push(`<meta name="theme-color" content="#09090b">`);
  return lines.join('\n    ');
}

// Site-wide tags injected into index.html at {{SITE_META}}.
function buildSiteMeta(settings) {
  const site = siteConfig(settings);
  const image = cardExists('site') ? `${site.url}/${cardWebPath('site')}` : '';
  return metaBlock({
    url: `${site.url}/`,
    title: `${site.title} | Portfolio`,
    description: site.description,
    image,
    imageAlt: `${site.title} portfolio`,
    siteName: site.title
  });
}

// --- per-project pages -------------------------------------------------------------

function projectShareUrl(settings, id) {
  return `${siteConfig(settings).url}/share/${safeId(id)}`;
}

function projectPageHtml(project, settings) {
  const site = siteConfig(settings);
  const id = safeId(project.id);
  const title = `${project.title || 'Project'} | ${site.title}`;
  const description = truncate(stripHtml(project.description) || site.description, 200);
  const image = cardExists(project.id) ? `${site.url}/${cardWebPath(project.id)}` : '';
  const pageUrl = projectShareUrl(settings, project.id);
  const target = `../#project/${encodeURIComponent(String(project.id))}`;
  const fallbackImage = project.thumbnail || project.image || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    ${metaBlock({ url: pageUrl, title: project.title || 'Project', description, image, imageAlt: project.title, type: 'article', siteName: site.title })}
    <meta name="robots" content="noindex, follow">
    <script>
    (function () {
      var target = ${JSON.stringify(target)};
      var ua = navigator.userAgent || '';
      // Social crawlers must stay on this HTML so they can read the Open Graph tags.
      // An instant meta-refresh / location.replace sends them to index.html, which
      // has no per-project image (URL hashes are ignored).
      if (/facebookexternalhit|Facebot|LinkedInBot|Twitterbot|Slackbot|WhatsApp|Discordbot|TelegramBot|Pinterest|Googlebot|bingbot|Applebot|Embedly|outbrain|vkShare|W3C_Validator|Quora Link Preview/i.test(ua)) return;
      setTimeout(function () { window.location.assign(target); }, 2500);
    })();
    </script>
    <style>
        body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
        main{max-width:640px;padding:32px;text-align:center}
        img{max-width:100%;border-radius:12px;display:block;margin:0 auto 20px}
        h1{font-size:28px;margin:0 0 8px}
        p{color:#a1a1aa;line-height:1.5;margin:0 0 20px}
        a{color:#22d3ee;font-weight:700;text-decoration:none}
        small{display:block;margin-top:24px;color:#71717a}
    </style>
</head>
<body>
    <main>
        ${fallbackImage ? `<img src="../${escapeHtml(fallbackImage)}" alt="">` : ''}
        <h1>${escapeHtml(project.title || 'Project')}</h1>
        <p>${escapeHtml(description)}</p>
        <a href="${escapeHtml(target)}">View this project on ${escapeHtml(site.url.replace(/^https?:\/\//, ''))} →</a>
        <small>Opening the project…</small>
    </main>
</body>
</html>
`;
}

function writeProjectPages(projects, settings) {
  fs.mkdirSync(SHARE_DIR, { recursive: true });
  const keep = new Set();
  let written = 0;
  for (const project of projects) {
    if (project?.id == null) continue;
    const file = `${safeId(project.id)}.html`;
    fs.writeFileSync(path.join(SHARE_DIR, file), projectPageHtml(project, settings), 'utf-8');
    keep.add(file);
    written++;
  }
  // Remove pages for projects that are no longer published (deleted or drafted).
  let removed = 0;
  for (const entry of fs.readdirSync(SHARE_DIR)) {
    if (!entry.endsWith('.html') || keep.has(entry)) continue;
    try { fs.unlinkSync(path.join(SHARE_DIR, entry)); removed++; } catch (_) { /* ignore */ }
  }
  return { written, removed };
}

// Drop cards that no longer correspond to a published project (site.jpg is always kept).
function pruneCards(projects) {
  if (!fs.existsSync(CARDS_DIR)) return 0;
  const keep = new Set(['site.jpg', ...projects.map(p => `${safeId(p.id)}.jpg`)]);
  let removed = 0;
  for (const entry of fs.readdirSync(CARDS_DIR)) {
    if (keep.has(entry)) continue;
    try { fs.unlinkSync(path.join(CARDS_DIR, entry)); removed++; } catch (_) { /* ignore */ }
  }
  pruneManifest(projects);
  return removed;
}

// --- cards -------------------------------------------------------------------------

function decodeDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('Card is not a base64 image data URL');
  return Buffer.from(m[2], 'base64');
}

async function writeCards(cards, projects, settings) {
  if (!Array.isArray(cards)) throw new Error('cards must be an array');
  fs.mkdirSync(CARDS_DIR, { recursive: true });
  const written = [];
  const writtenIds = [];
  const warnings = [];
  for (const card of cards) {
    if (!card || card.id == null || !card.dataUrl) continue;
    const file = `${safeId(card.id)}.jpg`;
    try {
      const buf = decodeDataUrl(card.dataUrl);
      await sharp(buf)
        .resize(CARD_W, CARD_H, { fit: 'cover' })
        .jpeg({ quality: 85, progressive: true, mozjpeg: true })
        .toFile(path.join(CARDS_DIR, file));
      written.push(`share/cards/${file}`);
      writtenIds.push(card.id);
    } catch (err) {
      warnings.push(`${file}: ${err.message}`);
    }
  }
  if (writtenIds.length && Array.isArray(projects) && settings) {
    recordWrittenCards(writtenIds, projects, settings);
  }
  return { written: written.length, files: written, warnings };
}

module.exports = {
  SHARE_DIR,
  CARDS_DIR,
  RENDERER_VERSION,
  siteConfig,
  stripHtml,
  buildSiteMeta,
  writeProjectPages,
  pruneCards,
  writeCards,
  planCards,
  projectShareUrl,
  cardWebPath
};
