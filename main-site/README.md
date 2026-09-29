# chrismooredesigns.com

The main Chris Moore Designs site: pixel hardware (PixelDecode ESP32 boards, PixelPilot Raspberry Pi controller), the firmware and software that go with them, and services such as custom color lithophanes. Aimed at pro-sumer DIYers.

It is a sibling of the portfolio at [chrismoore.me](https://chrismoore.me) ([Elusid108/Portfolio](https://github.com/Elusid108/Portfolio)) and shares its design tokens so the two read as one brand.

## Stack

- [Astro](https://astro.build) (static output) + Tailwind CSS v4
- Content collections in `src/content/` (families, products, firmware, software, services)
- Shopify Storefront API for cart + hosted checkout (see `docs/INTEGRATION.md`)
- GitHub Pages via `.github/workflows/deploy.yml`

## Develop

```sh
npm ci
cp .env.example .env   # optional: fill in Shopify values to enable the cart
npm run dev            # http://localhost:4321
npm run build          # -> dist/ (also copies design/mockups -> dist/mockups)
npm run check          # astro check (types)
```

## Layout

```
design/            tokens.json + tokens.css (shared with the portfolio), mockups/
docs/INTEGRATION.md  architecture + Shopify/GitHub Pages security notes
src/content/       markdown entries per collection, schemas in src/content.config.ts
src/components/    Nav, Footer, Wordmark, PixelField, Cart, AddToCart, SpecTable, ReleaseList
src/lib/shopify.ts Storefront API client (public token only)
src/pages/         index, families/[slug], products/[slug], firmware, software, services
public/            favicon, robots.txt, .nojekyll  (add CNAME when the domain is split)
```

## Status

The five candidate UI directions live in `design/mockups/` and are served at `/mockups/` on the deployed site. `src/pages/index.astro` is a placeholder until one is chosen.

## Deploy

1. Repo Settings → Pages → Source: **GitHub Actions**.
2. Push to `main`. The workflow builds and deploys `dist/`.
3. When ready to move the domain off the portfolio redirect: add `public/CNAME` containing `chrismooredesigns.com`, point DNS at GitHub Pages, enable "Enforce HTTPS".
4. Shopify: add `PUBLIC_SHOPIFY_DOMAIN` (variable) and `PUBLIC_SHOPIFY_STOREFRONT_TOKEN` (secret) under Settings → Secrets and variables → Actions.
