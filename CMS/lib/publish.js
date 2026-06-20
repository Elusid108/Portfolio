const fs = require('fs');
const path = require('path');
const { getProjects, getSettings } = require('./data');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(__dirname, '..', 'template', 'Portfolio Template.html');
const OUTPUT_PATH = path.join(PORTFOLIO_ROOT, 'index.html');

function publish() {
  const projects = getProjects();
  const settings = getSettings();
  const exportData = { projects, settings };

  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error('Portfolio Template.html not found in template/ directory');
  }

  let html = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const jsonString = JSON.stringify(exportData, null, 4);

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
