const fs = require('fs');
const path = require('path');
const { getProjects, getSettings } = require('./data');
const share = require('./share');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(__dirname, '..', 'template', 'Portfolio Template.html');
const OUTPUT_PATH = path.join(PORTFOLIO_ROOT, 'index.html');
// Shared three.js viewer used by both the admin UI and the published site.
// Inlined at publish time so index.html stays a single self-contained file.
const MODEL_VIEWER_CORE_PATH = path.join(__dirname, '..', 'public', 'js', 'model-viewer-core.js');

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

function projectsForPublish(allProjects) {
  const draftIds = new Set(allProjects.filter(isDraft).map(p => String(p.id)));
  return allProjects.filter(p => !isDraft(p)).map(p => {
    if (!Array.isArray(p.related) || p.related.length === 0) return p;
    const related = p.related.filter(r => {
      const id = relatedTargetId(r.url);
      return !id || !draftIds.has(String(id));
    });
    return related.length === p.related.length ? p : { ...p, related };
  });
}

function publish() {
  const projects = projectsForPublish(getProjects());
  const settings = getSettings();
  const exportData = { projects, settings };

  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error('Portfolio Template.html not found in template/ directory');
  }

  let html = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const jsonString = JSON.stringify(exportData);

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

  // Per-project share pages (share/<id>.html) + cleanup of stale pages/cards.
  let sharePages = { written: 0, removed: 0 };
  let prunedCards = 0;
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
