// Production build steps run at publish time, so the live site ships plain
// JavaScript and a static stylesheet instead of compiling in the visitor's browser:
//
//   - the template's <script type="text/babel"> JSX is compiled with esbuild into
//     assets/app.<hash>.js (replaces Babel Standalone, ~3 MB + an in-browser compile)
//   - Tailwind classes used by the template (and the static project pages) are
//     compiled with Tailwind v3 into assets/site.<hash>.css, together with the
//     template's own <style> block (replaces the Tailwind play CDN)
//
// Hashed filenames let browsers cache the assets indefinitely; stale ones are pruned.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const ASSETS_DIR = path.join(PORTFOLIO_ROOT, 'assets');

const REACT_VERSION = '18.3.1';
const REACT_SCRIPTS = [
  `<script defer crossorigin src="https://cdn.jsdelivr.net/npm/react@${REACT_VERSION}/umd/react.production.min.js"></script>`,
  `<script defer crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@${REACT_VERSION}/umd/react-dom.production.min.js"></script>`
];

const JSX_BLOCK_RE = /<script type="text\/babel">([\s\S]*?)<\/script>/;
const STYLE_BLOCK_RE = /<style>([\s\S]*?)<\/style>/;

function hashOf(content) {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 10);
}

// Writes assets/<name>.<hash>.<ext> (unchanged content keeps its file and its git blob).
function writeAsset(name, ext, content) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const file = `${name}.${hashOf(content)}.${ext}`;
  const abs = path.join(ASSETS_DIR, file);
  if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf-8') !== content) {
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return `assets/${file}`;
}

function pruneAssets(keepWebPaths) {
  if (!fs.existsSync(ASSETS_DIR)) return;
  const keep = new Set(keepWebPaths.map((p) => path.basename(p)));
  for (const entry of fs.readdirSync(ASSETS_DIR)) {
    if (/^(app|site)\.[0-9a-f]{10}\.(js|css)$/.test(entry) && !keep.has(entry)) {
      try { fs.unlinkSync(path.join(ASSETS_DIR, entry)); } catch (_) { /* ignore */ }
    }
  }
}

function compileJsx(source) {
  try {
    const result = esbuild.transformSync(source, {
      loader: 'jsx',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      target: 'es2019',
      minify: true,
      legalComments: 'none'
    });
    return result.code;
  } catch (err) {
    const first = err.errors && err.errors[0];
    const where = first && first.location ? ` (template script line ${first.location.line})` : '';
    throw new Error(`Site script failed to compile${where}: ${first ? first.text : err.message}`);
  }
}

async function compileCss(templateCss, contentSources) {
  const input = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n${templateCss}`;
  const result = await postcss([
    tailwindcss({
      content: contentSources.map((raw) => ({ raw, extension: 'html' })),
      theme: { extend: {} },
      plugins: []
    })
  ]).process(input, { from: undefined });
  const minified = await esbuild.transform(result.css, { loader: 'css', minify: true, legalComments: 'none' });
  return minified.code;
}

/**
 * Turns the filled-in template into production HTML plus hashed assets.
 * @param {string} html  template with data/meta already injected
 * @param {string[]} extraContent  other markup that uses Tailwind classes (project pages, data)
 * @returns {Promise<{ html: string, cssPath: string, jsPath: string }>}
 */
async function buildSite(html, extraContent = []) {
  const jsxMatch = html.match(JSX_BLOCK_RE);
  if (!jsxMatch) throw new Error('Template is missing its <script type="text/babel"> block');
  const styleMatch = html.match(STYLE_BLOCK_RE);
  const templateCss = styleMatch ? styleMatch[1] : '';

  const js = compileJsx(jsxMatch[1]);
  const css = await compileCss(templateCss, [html, ...extraContent]);

  const jsPath = writeAsset('app', 'js', js);
  const cssPath = writeAsset('site', 'css', css);
  pruneAssets([jsPath, cssPath]);

  let out = html;
  if (styleMatch) out = out.replace(styleMatch[0], () => '');
  out = out.replace('{{SITE_CSS}}', () => `<link rel="stylesheet" href="${cssPath}">`);
  out = out.replace(JSX_BLOCK_RE, () => [...REACT_SCRIPTS, `<script defer src="${jsPath}"></script>`].join('\n    '));
  return { html: out, cssPath, jsPath };
}

module.exports = { buildSite };
