const fs = require('fs');
const path = require('path');
const { getProjects, getSettings, writeJSON } = require('./data');
const { ensureSlugs } = require('./slug');
const share = require('./share');
const pages = require('./pages');
const { buildSite } = require('./build');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(__dirname, '..', 'template', 'Portfolio Template.html');
const OUTPUT_PATH = path.join(PORTFOLIO_ROOT, 'index.html');
// Shared three.js viewer used by both the admin UI and the published site.
// Inlined at publish time so the viewer is ready as soon as a model opens.
const MODEL_VIEWER_CORE_PATH = path.join(__dirname, '..', 'public', 'js', 'model-viewer-core.js');

// Models with more parts than this ship their per-part colours as a sidecar JSON
// next to the GLB instead of inside index.html (one model alone was ~370 KB).
const INLINE_PARTS_LIMIT = 50;

// CMS-only fields that the site never reads.
const CMS_ONLY_FIELDS = ['specsData', 'linkHeroImages', 'slugHistory', 'draft'];

function readModelViewerCore() {
  if (!fs.existsSync(MODEL_VIEWER_CORE_PATH)) return '';
  const src = fs.readFileSync(MODEL_VIEWER_CORE_PATH, 'utf-8');
  // Never let the inlined source terminate the surrounding <script> tag.
  return src.replace(/<\/script/gi, '<\\/script');
}

function isDraft(project) {
  return project.draft === true;
}

function relatedTargetId(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('#project/')) return null;
  try {
    return decodeURIComponent(url.slice('#project/'.length));
  } catch {
    return url.slice('#project/'.length);
  }
}

function absFromWeb(webPath) {
  const abs = path.resolve(PORTFOLIO_ROOT, ...String(webPath).split('/'));
  const rel = path.relative(PORTFOLIO_ROOT, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? abs : null;
}

function webExists(webPath) {
  const abs = webPath && !/^[a-z]+:/i.test(webPath) ? absFromWeb(webPath) : null;
  return !!(abs && fs.existsSync(abs));
}

// "media/X/foo.webp" -> "media/X/foo-thumb.webp" when the CMS generated one.
function thumbSibling(webPath) {
  if (!webPath || /-thumb\.[a-z0-9]+$/i.test(webPath)) return '';
  const candidate = webPath.replace(/(\.[a-z0-9]+)$/i, '-thumb$1');
  return candidate !== webPath && webExists(candidate) ? candidate : '';
}

// Writes <model>.parts.json beside the GLB (only when it changed) and returns its web path.
function writePartsSidecar(modelUrl, parts) {
  const web = modelUrl.replace(/\.glb$/i, '.parts.json');
  const abs = absFromWeb(web);
  if (!abs || web === modelUrl) return null;
  const json = JSON.stringify(parts);
  if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf-8') !== json) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, json, 'utf-8');
  }
  return web;
}

function slimGalleryItem(item, sidecars) {
  if (!item || typeof item !== 'object' || !Array.isArray(item.parts)) return item;
  if (item.parts.length <= INLINE_PARTS_LIMIT || typeof item.url !== 'string') return item;
  const partsUrl = writePartsSidecar(item.url, item.parts);
  if (!partsUrl) return item;
  sidecars.add(partsUrl);
  const { parts, ...rest } = item;
  return { ...rest, partsUrl, partsCount: parts.length };
}

// Remove sidecars left behind by models that were deleted or slimmed down.
function pruneSidecars(allProjects, keep) {
  const dirs = new Set();
  for (const p of allProjects) {
    for (const g of p.gallery || []) {
      const url = typeof g === 'string' ? g : g?.url;
      if (url && /\.glb$/i.test(url)) {
        const abs = absFromWeb(url);
        if (abs) dirs.add(path.dirname(abs));
      }
    }
  }
  const keepAbs = new Set([...keep].map((w) => absFromWeb(w)));
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (entry.endsWith('.parts.json') && !keepAbs.has(abs)) {
        try { fs.unlinkSync(abs); } catch (_) { /* ignore */ }
      }
    }
  }
}

function projectsForPublish(allProjects, sidecars = new Set()) {
  const draftIds = new Set(allProjects.filter(isDraft).map(p => String(p.id)));
  return allProjects.filter(p => !isDraft(p)).map(p => {
    const out = { ...p };
    for (const key of CMS_ONLY_FIELDS) delete out[key];
    if (Array.isArray(p.related) && p.related.length) {
      out.related = p.related.filter(r => {
        const id = relatedTargetId(r.url);
        return !id || !draftIds.has(String(id));
      });
    }
    if (Array.isArray(p.gallery)) out.gallery = p.gallery.map(g => slimGalleryItem(g, sidecars));
    const imageThumb = thumbSibling(p.image);
    if (imageThumb) out.imageThumb = imageThumb;
    return out;
  });
}

async function publish() {
  // Every project gets a permanent URL slug the first time it is published.
  const allProjects = getProjects();
  if (ensureSlugs(allProjects)) writeJSON('projects.json', allProjects);

  const sidecars = new Set();
  const projects = projectsForPublish(allProjects, sidecars);
  pruneSidecars(allProjects, sidecars);
  const settings = getSettings();
  const exportData = { projects, settings };

  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error('Portfolio Template.html not found in template/ directory');
  }

  // Compile JSX + Tailwind first, against the raw template (and the markup of the
  // static project pages), then fill in the data.
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const pagesSource = fs.readFileSync(path.join(__dirname, 'pages.js'), 'utf-8');
  const projectHtml = projects.map(p => `${p.description || ''}${p.longDescription || ''}${p.specs || ''}`).join('\n');
  const built = await buildSite(template, [pagesSource, projectHtml]);
  let html = built.html;

  // "<" is escaped so rich text containing "</script>" or "<!--" can't end the data block.
  const jsonString = JSON.stringify(exportData).replace(/</g, '\\u003c');

  if (html.includes('{{PORTFOLIO_DATA}}')) {
    html = html.replace('{{PORTFOLIO_DATA}}', () => jsonString);
  } else {
    html = html.replace('</body>', () => `<script>window.PORTFOLIO_DATA = ${jsonString};</script>\n</body>`);
  }

  if (html.includes('{{MODEL_VIEWER_CORE}}')) {
    html = html.replace('{{MODEL_VIEWER_CORE}}', () => readModelViewerCore());
  }

  // Open Graph / Twitter tags for the site itself (share/cards/site.jpg is
  // rendered by the admin UI and uploaded just before publish).
  if (html.includes('{{SITE_META}}')) {
    html = html.replace('{{SITE_META}}', () => share.buildSiteMeta(settings));
  }

  fs.writeFileSync(OUTPUT_PATH, html, 'utf-8');

  // Static project pages, legacy share/<id> forwards, sitemap/robots/404, favicons.
  let projectPages = { written: 0, removed: 0, total: 0 };
  let sharePages = { written: 0, removed: 0 };
  let prunedCards = 0;
  try {
    projectPages = pages.writeProjectPages(projects, settings, { cssPath: built.cssPath });
    pages.writeSeoFiles(projects, settings);
    await pages.writeFavicons();
  } catch (err) {
    console.error('[pages] failed to write project pages:', err.message);
  }
  try {
    sharePages = share.writeProjectPages(projects, settings);
    prunedCards = share.pruneCards(projects);
  } catch (err) {
    console.error('[share] failed to write share pages:', err.message);
  }

  return {
    success: true,
    outputPath: OUTPUT_PATH,
    html,
    bytes: Buffer.byteLength(html),
    assets: { css: built.cssPath, js: built.jsPath },
    projectPages,
    share: {
      pages: sharePages.written,
      removedPages: sharePages.removed,
      prunedCards,
      siteCard: share.cardWebPath('site'),
      siteUrl: share.siteConfig(settings).url
    }
  };
}

module.exports = { publish };
