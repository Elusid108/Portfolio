const fs = require('fs');
const path = require('path');
const { getProjects, getSettings } = require('./data');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(__dirname, '..', 'template', 'Portfolio Template.html');
const OUTPUT_PATH = path.join(PORTFOLIO_ROOT, 'index.html');

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
    html = html.replace('{{PORTFOLIO_DATA}}', jsonString);
  } else {
    html = html.replace('</body>', `<script>window.PORTFOLIO_DATA = ${jsonString};</script>\n</body>`);
  }

  fs.writeFileSync(OUTPUT_PATH, html, 'utf-8');

  return {
    success: true,
    outputPath: OUTPUT_PATH,
    html
  };
}

module.exports = { publish };
