// Static, crawlable pages written at publish time:
//
//   projects/<slug>/index.html   one readable page per published project (no JS
//                                needed): story, specs, gallery, downloads, links
//   projects/<old-slug>/         forwarding page for each renamed slug
//   sitemap.xml, robots.txt, 404.html, favicon.svg / favicon-32.png / apple-touch-icon.png
//
// The single-page site (index.html) stays the interactive experience; these pages
// are what search engines index and what shared links open. Tailwind classes used
// here are compiled into the shared site stylesheet (lib/build.js scans this file).

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const share = require('./share');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const PROJECTS_DIR = path.join(PORTFOLIO_ROOT, 'projects');
const UP = '../../'; // projects/<slug>/ -> site root

const { escapeHtml: esc, stripHtml, truncate, siteConfig } = share;

// Site-relative media path ("media/Art/X/a b.webp") -> URL usable from a project page.
function mediaHref(p) {
  if (!p) return '';
  if (/^(https?:|mailto:|data:)/i.test(p)) return p;
  return UP + encodeURI(String(p).replace(/^\/+/, ''));
}

function externalHref(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[a-z]+\//i.test(u) && !u.includes('://')) return mediaHref(u); // media/...
  return `https://${u}`;
}

function projectPath(project) {
  return `projects/${project.slug}/`;
}

function projectUrl(settings, project) {
  return `${siteConfig(settings).url}/${projectPath(project)}`;
}

// Same idea as demoteHeadings() in the template: authored headings start at `start`.
function demoteHeadings(html, start) {
  const source = String(html || '');
  const present = [...source.matchAll(/<h([1-6])\b/gi)].map((m) => parseInt(m[1], 10));
  if (!present.length) return source;
  const shallowest = Math.min(...present);
  return source.replace(/<(\/?)h([1-6])([^>]*)>/gi, (m, slash, lvl, attrs) => {
    const original = parseInt(lvl, 10);
    const level = Math.min(6, start + original - shallowest);
    if (slash) return `</h${level}>`;
    const cls = `rt-h${original}`;
    const withClass = /class\s*=\s*"/i.test(attrs)
      ? attrs.replace(/class\s*=\s*"([^"]*)"/i, (x, c) => `class="${c} ${cls}"`)
      : `${attrs} class="${cls}"`;
    return `<h${level}${withClass}>`;
  });
}

// Media paths inside authored rich text are site-relative too.
function rebaseRichText(html) {
  return String(html || '').replace(/(\s(?:src|href)=")(media\/[^"]+)"/gi, (m, attr, p) => `${attr}${mediaHref(p)}"`);
}

const mediaUrl = (item) => (typeof item === 'string' ? item : item?.url || '');
const youTubeId = (url) => {
  const m = String(url || '').match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/);
  return m && m[2].length === 11 ? m[2] : null;
};

function galleryItemHtml(item, index, total, project) {
  const url = mediaUrl(item);
  const caption = typeof item === 'object' && item?.caption ? item.caption : '';
  const thumb = typeof item === 'object' ? item?.thumbnail || item?.poster || '' : '';
  const label = caption || `${project.title}, ${index + 1} of ${total}`;
  const figcaption = caption ? `<figcaption class="px-3 py-2 text-sm text-zinc-400">${esc(caption)}</figcaption>` : '';
  const yt = youTubeId(url);

  if (yt) {
    return `<figure class="rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900">
          <a href="https://www.youtube.com/watch?v=${esc(yt)}" class="block aspect-video relative" target="_blank" rel="noopener noreferrer">
            <img src="https://img.youtube.com/vi/${esc(yt)}/hqdefault.jpg" alt="${esc(label)} (YouTube video)" loading="lazy" decoding="async" class="w-full h-full object-cover">
            <span class="absolute inset-0 flex items-center justify-center"><span class="px-3 py-1 rounded-full bg-red-600 text-white text-sm font-bold">▶ YouTube</span></span>
          </a>${figcaption}
        </figure>`;
  }
  if ((typeof item === 'object' && item?.type === 'model') || /\.glb$/i.test(url)) {
    return `<figure class="rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900">
          <a href="${UP}#project/${encodeURIComponent(project.id)}" class="block aspect-video relative">
            ${thumb ? `<img src="${mediaHref(thumb)}" alt="${esc(label)} (3D model preview)" loading="lazy" decoding="async" class="w-full h-full object-cover">` : ''}
            <span class="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/70 text-xs font-mono text-zinc-200">3D · open in viewer</span>
          </a>${figcaption}
        </figure>`;
  }
  if (/\.(mp4|webm|mov|m4v)$/i.test(url.split('?')[0])) {
    const poster = typeof item === 'object' ? item?.poster || item?.thumbnail || '' : '';
    return `<figure class="rounded-lg overflow-hidden border border-zinc-800 bg-black">
          <video controls playsinline preload="none" class="w-full aspect-video bg-black"${poster ? ` poster="${mediaHref(poster)}"` : ''} aria-label="${esc(label)}">
            <source src="${mediaHref(url)}" type="video/mp4">
          </video>${figcaption}
        </figure>`;
  }
  return `<figure class="rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900">
          <a href="${mediaHref(url)}" class="block aspect-video">
            <img src="${mediaHref(thumb || url)}" alt="${esc(label)}" loading="lazy" decoding="async" class="w-full h-full object-cover">
          </a>${figcaption}
        </figure>`;
}

function fileExt(url) {
  return String(url || '').split('?')[0].split('.').pop().slice(0, 4).toUpperCase();
}

function downloadsHtml(project) {
  const files = (project.files || []).filter((f) => mediaUrl(f));
  if (!files.length) return '';
  const items = files.map((f, i) => {
    const url = mediaUrl(f);
    const name = typeof f === 'string' ? `File ${i + 1}` : f.name || `File ${i + 1}`;
    const desc = typeof f === 'object' ? f.description : '';
    const license = typeof f === 'object' ? f.license : '';
    return `<li class="rounded-lg bg-zinc-800/60 border border-zinc-800 p-4">
            <a href="${externalHref(url)}" download class="flex items-center justify-between gap-3 font-bold text-white hover:text-cyan-300">
              <span class="break-words">${esc(name)}</span>
              <span class="shrink-0 text-xs font-mono text-cyan-400">${esc(fileExt(url))} ↓</span>
            </a>
            ${desc ? `<p class="mt-2 text-sm text-zinc-400 leading-relaxed">${esc(desc)}</p>` : ''}
            ${license ? `<p class="mt-1 text-sm text-zinc-400"><span class="font-semibold text-zinc-300">License:</span> ${esc(license)}</p>` : ''}
          </li>`;
  });
  return panel('Downloads', `<ul class="space-y-3">${items.join('\n')}</ul>`);
}

function actionsHtml(project) {
  const links = [
    [project.websiteLink, 'Visit website', 'bg-blue-600 hover:bg-blue-500'],
    [project.launchLink, 'Launch app', 'bg-purple-600 hover:bg-purple-500'],
    [project.shopLink, 'Buy kit', 'bg-cyan-600 hover:bg-cyan-500'],
    [project.githubLink, 'View code on GitHub', 'bg-zinc-800 hover:bg-zinc-700 border border-zinc-700']
  ].filter(([url]) => url);
  if (!links.length) return '';
  return panel('Links', `<div class="space-y-3">${links.map(([url, label, cls]) =>
    `<a href="${esc(externalHref(url))}" target="_blank" rel="noopener noreferrer" class="block w-full text-center py-3 rounded-lg text-white font-medium ${cls}">${esc(label)}</a>`
  ).join('\n')}</div>`);
}

function relatedHtml(project, bySiteId) {
  const rows = (project.related || []).map((r) => {
    if (!r || !r.url) return '';
    if (r.url.startsWith('#project/')) {
      let id = r.url.slice('#project/'.length);
      try { id = decodeURIComponent(id); } catch (_) { /* keep raw */ }
      const target = bySiteId.get(String(id));
      if (!target) return '';
      return `<li><a href="${UP}${projectPath(target)}" class="block rounded-lg bg-zinc-800/60 hover:bg-zinc-800 p-3 text-white font-semibold">${esc(target.title)} →</a></li>`;
    }
    return `<li><a href="${esc(externalHref(r.url))}" target="_blank" rel="noopener noreferrer" class="block rounded-lg bg-zinc-800/60 hover:bg-zinc-800 p-3 text-white font-semibold">${esc(r.name || r.url)} ↗</a></li>`;
  }).filter(Boolean);
  return rows.length ? panel('Related', `<ul class="space-y-2">${rows.join('\n')}</ul>`) : '';
}

function panel(title, body) {
  return `<section class="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
          <h2 class="text-sm font-bold text-zinc-400 uppercase tracking-widest mb-4">${esc(title)}</h2>
          ${body}
        </section>`;
}

function jsonLd(project, settings, description, image) {
  const site = siteConfig(settings);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: project.title,
    description,
    url: projectUrl(settings, project),
    genre: project.category,
    keywords: (project.tags || []).join(', ') || undefined,
    image: image || undefined,
    isPartOf: { '@type': 'WebSite', name: site.title, url: `${site.url}/` }
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function projectPageHtml(project, settings, ctx) {
  const site = siteConfig(settings);
  const description = truncate(stripHtml(project.description) || stripHtml(project.longDescription) || site.description, 200);
  const cardImage = share.cardExists(project.id) ? `${site.url}/${share.cardWebPath(project.id)}` : '';
  const pageUrl = projectUrl(settings, project);
  const banner = project.imageThumb || project.image || project.thumbnail || '';
  const bannerFull = project.image || project.thumbnail || '';
  const gallery = (project.gallery || []).filter((g) => mediaUrl(g));
  const badges = [
    project.featured ? '<span class="px-2 py-1 bg-cyan-600 text-xs font-mono rounded uppercase text-white">Featured</span>' : '',
    project.wip ? '<span class="px-2 py-1 bg-purple-600 text-xs font-mono rounded uppercase text-white">Work in progress</span>' : ''
  ].join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(project.title)} | ${esc(site.title)}</title>
    ${share.metaBlock({ url: pageUrl, title: project.title || 'Project', description, image: cardImage, imageAlt: project.title, type: 'article', siteName: site.title })}
    <link rel="icon" href="${UP}favicon.svg" type="image/svg+xml">
    <link rel="icon" href="${UP}favicon-32.png" sizes="32x32" type="image/png">
    <link rel="apple-touch-icon" href="${UP}apple-touch-icon.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="${UP}${ctx.cssPath}">
    <script type="application/ld+json">${jsonLd(project, settings, description, cardImage || (bannerFull ? `${site.url}/${encodeURI(bannerFull)}` : ''))}</script>
</head>
<body class="bg-zinc-950 text-zinc-200">
    <a href="#main-content" class="skip-link">Skip to main content</a>
    <header class="glass-panel sticky top-0 z-50">
        <nav aria-label="Main" class="container mx-auto px-6 py-4 flex items-center justify-between gap-4">
            <a href="${UP}" class="font-bold text-lg tracking-tight text-white">${esc(site.title)}</a>
            <a href="${UP}#project/${encodeURIComponent(project.id)}" class="text-sm font-semibold text-cyan-400 hover:text-cyan-300">Open in interactive portfolio →</a>
        </nav>
    </header>
    <main id="main-content">
        <div class="relative h-64 md:h-96 w-full overflow-hidden bg-zinc-900">
            ${banner ? `<img src="${mediaHref(banner)}"${project.imageThumb && bannerFull ? ` srcset="${mediaHref(project.imageThumb)} 800w, ${mediaHref(bannerFull)} 1600w" sizes="100vw"` : ''} alt="" fetchpriority="high" class="w-full h-full object-cover">` : ''}
            <div class="absolute inset-0 bg-gradient-to-t from-zinc-950 to-transparent"></div>
            <div class="absolute bottom-6 left-0 right-0">
                <div class="container mx-auto px-6">
                    ${badges ? `<div class="mb-3 flex gap-2">${badges}</div>` : ''}
                    <p class="text-sm font-mono uppercase tracking-widest text-cyan-400 mb-2">${esc(project.category || '')}</p>
                    <h1 class="text-3xl md:text-5xl font-bold text-white">${esc(project.title)}</h1>
                </div>
            </div>
        </div>
        <div class="container mx-auto px-6 py-10 grid gap-10 md:grid-cols-3">
            <article class="md:col-span-2 space-y-10 min-w-0">
                ${project.description ? `<div class="text-xl text-zinc-300 leading-relaxed rich-text">${rebaseRichText(demoteHeadings(project.description, 2))}</div>` : ''}
                ${project.longDescription ? `<section>
                    <h2 class="text-2xl font-bold text-white mb-4">About the project</h2>
                    <div class="text-zinc-300 text-lg leading-relaxed break-words rich-text">${rebaseRichText(demoteHeadings(project.longDescription, 3))}</div>
                </section>` : ''}
                ${(project.tags || []).length ? `<ul class="flex flex-wrap gap-2" aria-label="Skills and tools">${project.tags.map((t) =>
                  `<li class="text-xs font-mono px-2 py-1 bg-zinc-800 text-cyan-400 border border-cyan-500/30 rounded uppercase tracking-wider">${esc(t)}</li>`).join('')}</ul>` : ''}
                ${gallery.length ? `<section>
                    <h2 class="text-2xl font-bold text-white mb-4">Gallery</h2>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        ${gallery.map((g, i) => galleryItemHtml(g, i, gallery.length, project)).join('\n        ')}
                    </div>
                </section>` : ''}
            </article>
            <aside class="space-y-6 min-w-0">
                ${project.specs ? panel('Specifications', `<div class="rich-text specs-rich-text text-zinc-300 text-sm leading-relaxed">${rebaseRichText(demoteHeadings(project.specs, 3))}</div>`) : ''}
                ${actionsHtml(project)}
                ${downloadsHtml(project)}
                ${relatedHtml(project, ctx.bySiteId)}
            </aside>
        </div>
    </main>
    <footer class="border-t border-zinc-900 py-10">
        <div class="container mx-auto px-6 flex flex-col md:flex-row gap-4 justify-between text-sm text-zinc-400">
            <a href="${UP}" class="hover:text-white">← All projects</a>
            <span class="font-mono">&copy; ${new Date().getFullYear()} ${esc(site.title)}</span>
        </div>
    </footer>
</body>
</html>
`;
}

function redirectPageHtml(target, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${esc(title)}</title>
    <link rel="canonical" href="${esc(target)}">
    <meta name="robots" content="noindex, follow">
    <meta http-equiv="refresh" content="0; url=${esc(target)}">
    <script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')});</script>
</head>
<body><p><a href="${esc(target)}">${esc(title)}</a></p></body>
</html>
`;
}

// Only rewrite a file when its bytes change (keeps git history and OneDrive quiet).
function writeIfChanged(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf-8') === content) return false;
  fs.writeFileSync(abs, content, 'utf-8');
  return true;
}

function writeProjectPages(projects, settings, { cssPath }) {
  const bySiteId = new Map(projects.map((p) => [String(p.id), p]));
  const keep = new Set();
  let written = 0;
  for (const project of projects) {
    if (!project.slug) continue;
    keep.add(project.slug);
    if (writeIfChanged(path.join(PROJECTS_DIR, project.slug, 'index.html'), projectPageHtml(project, settings, { cssPath, bySiteId }))) written++;
    for (const old of Array.isArray(project.slugHistory) ? project.slugHistory : []) {
      if (!old || keep.has(old) || bySiteId.has(old)) continue;
      keep.add(old);
      writeIfChanged(path.join(PROJECTS_DIR, old, 'index.html'), redirectPageHtml(`../${project.slug}/`, project.title));
    }
  }
  let removed = 0;
  if (fs.existsSync(PROJECTS_DIR)) {
    for (const entry of fs.readdirSync(PROJECTS_DIR)) {
      if (keep.has(entry)) continue;
      fs.rmSync(path.join(PROJECTS_DIR, entry), { recursive: true, force: true });
      removed++;
    }
  }
  return { written, removed, total: keep.size };
}

function writeSeoFiles(projects, settings) {
  const site = siteConfig(settings);
  const urls = [`${site.url}/`, ...projects.filter((p) => p.slug).map((p) => projectUrl(settings, p))];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}
</urlset>
`;
  writeIfChanged(path.join(PORTFOLIO_ROOT, 'sitemap.xml'), sitemap);
  writeIfChanged(path.join(PORTFOLIO_ROOT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`);
  writeIfChanged(path.join(PORTFOLIO_ROOT, '404.html'), notFoundHtml(site));
}

function notFoundHtml(site) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Page not found | ${esc(site.title)}</title>
    <meta name="robots" content="noindex">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <style>
        body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;padding:24px}
        h1{font-size:28px;margin:0 0 8px;color:#fff}
        p{color:#a1a1aa;line-height:1.5;margin:0 0 24px}
        a{display:inline-block;padding:12px 20px;border-radius:10px;background:#22d3ee;color:#09090b;font-weight:700;text-decoration:none}
        a:focus-visible{outline:2px solid #fff;outline-offset:3px}
    </style>
</head>
<body>
    <main>
        <p style="font-family:ui-monospace,monospace;color:#22d3ee;margin-bottom:8px">404</p>
        <h1>That page isn't here.</h1>
        <p>It may have moved when the site was reorganised.</p>
        <a href="/">Go to ${esc(site.title)}</a>
    </main>
</body>
</html>
`;
}

// The nav's lightning-bolt mark in the brand cyan on a dark tile.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#09090b"/>
  <polygon points="35,8 14,36 31,36 29,56 50,28 33,28" fill="#22d3ee"/>
</svg>
`;

async function writeFavicons() {
  const svgChanged = writeIfChanged(path.join(PORTFOLIO_ROOT, 'favicon.svg'), FAVICON_SVG);
  const targets = [['favicon-32.png', 32], ['apple-touch-icon.png', 180]];
  for (const [file, size] of targets) {
    const abs = path.join(PORTFOLIO_ROOT, file);
    if (!svgChanged && fs.existsSync(abs)) continue;
    await sharp(Buffer.from(FAVICON_SVG), { density: Math.ceil((72 * size) / 64) * 2 })
      .resize(size, size)
      .png()
      .toFile(abs);
  }
}

module.exports = { writeProjectPages, writeSeoFiles, writeFavicons, projectPath, projectUrl, redirectPageHtml };
