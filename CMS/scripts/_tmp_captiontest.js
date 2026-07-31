// Temporary verification harness: builds a throwaway copy of the published site
// with captions injected into one gallery, and serves the Portfolio root.
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'index.html');
const STAMP = Date.now();
const OUTNAME = `_caption-test-${STAMP}.html`;
const OUT = path.join(ROOT, OUTNAME);

const LONG = 'The LithoLab workspace links source image manipulation directly to physical 3D print parameters. In the main canvas, users apply custom geometric masks and adjust spatial orientation, while the sidebar controls physical dimensions, border scaling, and filament palette selection. The dual-preview engine at the bottom provides immediate feedback, displaying both a palette-accurate color rendering and a surface-texture depth map to verify print accuracy before exporting.';
const SHORT = 'Front-of-house rig at load-in.';

const html = fs.readFileSync(SRC, 'utf-8');
const m = html.match(/(<script id="portfolio-data"[^>]*>)([\s\S]*?)(<\/script>)/);
const data = JSON.parse(m[2].trim());

const target = data.projects.find(p => Array.isArray(p.gallery) && p.gallery.length >= 3);
if (!target) throw new Error('no project with a 3+ image gallery');
target.gallery[0] = { url: target.gallery[0], caption: LONG };
target.gallery[1] = { url: target.gallery[1], caption: SHORT };
// gallery[2] intentionally left as a bare string: the no-caption case.

fs.writeFileSync(OUT, html.replace(m[2], '\n' + JSON.stringify(data, null, 4) + '\n'), 'utf-8');
console.log('target project:', target.title, '| id:', target.id, '| gallery:', target.gallery.length);

const TYPES = { '.html': 'text/html', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };
http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || OUTNAME;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
}).listen(3456, () => console.log(`serving on http://localhost:3456/${OUTNAME}`));
