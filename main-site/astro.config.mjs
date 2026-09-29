// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// `site` is the final production origin. Until the domain is split from
// chrismoore.me the deployed copy lives at https://elusid108.github.io/chrismooredesigns/
// — leave `base` at '/' anyway; every internal link is root-relative and
// the GitHub Pages project URL is only a temporary preview.
export default defineConfig({
  site: 'https://chrismooredesigns.com',
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap()],
  vite: {
    build: {
      // The CSP meta in Base.astro is `script-src 'self'`, so every script must be
      // an external file. 0 stops Vite/Astro from inlining small scripts.
      assetsInlineLimit: 0,
    },
  },
});
