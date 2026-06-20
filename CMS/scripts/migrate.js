const fs = require('fs');
const path = require('path');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(__dirname, '..', 'data');
const HTML_PATH = path.join(PORTFOLIO_ROOT, 'index.html');

function convertGitHubUrl(url) {
  if (!url || typeof url !== 'string') return url;

  const prefix = 'https://github.com/Elusid108/Portfolio/blob/main/';
  if (!url.startsWith(prefix)) return url;

  let rel = url.replace(prefix, '/');
  rel = rel.replace(/\?raw=true$/, '');
  rel = decodeURIComponent(rel);
  return rel;
}

function migrate() {
  console.log('Reading published index.html...');
  const html = fs.readFileSync(HTML_PATH, 'utf-8');

  const match = html.match(/<script id="portfolio-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    console.error('Could not find portfolio-data in index.html');
    process.exit(1);
  }

  const raw = JSON.parse(match[1].trim());
  let projects = raw.projects || [];
  let settings = raw.settings || {};

  projects = projects.map(p => {
    p.image = convertGitHubUrl(p.image);

    if (Array.isArray(p.gallery)) {
      p.gallery = p.gallery.map(url => {
        if (url.includes('?raw=true') && url.indexOf('?raw=true') !== url.lastIndexOf('?raw=true')) {
          url = url.substring(0, url.indexOf('?raw=true') + '?raw=true'.length);
        }
        return convertGitHubUrl(url);
      });
    }

    if (p.wip === '' || p.wip === null || p.wip === undefined) {
      p.wip = false;
    }

    delete p.rowIndex;
    return p;
  });

  settings.about_headshot = convertGitHubUrl(settings.about_headshot);

  delete settings.hero_1;
  delete settings.hero_2;
  delete settings.hero_3;
  delete settings.hero_4;
  delete settings.hero_5;
  delete settings.hero_6;
  delete settings.accepting_work;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify(projects, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify(settings, null, 2));

  console.log(`Migrated ${projects.length} projects`);
  console.log('Written to CMS/data/projects.json and CMS/data/settings.json');
}

migrate();
