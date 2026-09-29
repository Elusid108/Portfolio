# Integration and security: Shopify on a GitHub Pages site

How chrismooredesigns.com is built, how it talks to Shopify, how it stays in step with the portfolio at chrismoore.me, and what the security posture is on a host that can't run code or set headers.

## 1. The shape of it

```
                 chrismoore.me (portfolio)                chrismooredesigns.com (this repo)
                 React UMD page, local CMS, GH Pages      Astro static build, GH Actions, GH Pages
                        │                                          │
     "Visit Shop" ──────┼──────────────────────────────────────────▶ /
     per-project KIT ───┼──────────────────────────────────────────▶ /products/<slug>/
                        ◀──────────────────────────────────────────┼── nav "Portfolio ↗", family pages link back
                                                                   │
                                            browser (public Storefront token)
                                                                   ▼
                                                 <store>.myshopify.com  (Storefront API)
                                                                   │
                                                          cart.checkoutUrl
                                                                   ▼
                                                   Shopify hosted checkout (PCI scope lives here)
```

Two static sites, one brand, one commerce backend. Nothing on GitHub Pages ever handles payment or personal data.

## 2. Architecture of the new site

**Stack.** Astro (static output) with Tailwind v4 through PostCSS. No client framework; the only JavaScript that ships is the nav toggle, the PixelField canvas and the cart island.

**Content model.** `src/content/` with Zod schemas in `src/content.config.ts`:

| Collection | What it is | Key fields |
|---|---|---|
| `families` | A product line sharing firmware/software (PixelDecode, PixelPilot) | `name`, `category`, `order`, `portfolioSlug` |
| `products` | One purchasable thing | `sku`, `family`, `shopifyHandle`, `placeholderPrice`, `specs`, `firmware[]`, `software[]` |
| `firmware` | A release | `version`, `date`, `targets[]`, `downloadUrl`, `sha256`, `webInstallerManifest`, `ota` |
| `software` | Desktop/web apps, including the litho tools | `platforms[]`, `repo`, `releaseUrl`, `appUrl` |
| `services` | Made-to-order work | `startingPrice`, `relatedApps[]` |

Pages: `/`, `/families/<slug>/`, `/products/<slug>/`, `/firmware/`, `/software/`, `/services/`. Add a `docs/` collection later for wiring guides; the Docs First mockup shows the shape.

**Design tokens shared with the portfolio.** `design/tokens.json` is the source; `design/tokens.css` is its Tailwind `@theme` rendering. The portfolio compiles Tailwind inside its CMS and cannot import from this repo, so the two files are copied into `Portfolio/CMS/design/` and diffed on change. A shared npm package would be overkill for two repos. The PixelField constants live in the same file so both heroes animate identically.

**Deploy.** `.github/workflows/deploy.yml`: on push to `main` (and weekly), `npm ci`, `npm run build`, upload `dist/`, deploy to Pages. Same permissions and concurrency block as the portfolio's workflow. The weekly run keeps build-time prices from going stale.

**Domain.** chrismooredesigns.com currently redirects to chrismoore.me at the registrar. To split:

1. Remove that redirect.
2. Add `A`/`AAAA` records for the apex to GitHub Pages (`185.199.108–111.153` and the matching IPv6 set; check the current list in GitHub's docs) and a `CNAME` for `www` to `elusid108.github.io`.
3. Add `public/CNAME` containing `chrismooredesigns.com` to this repo and push.
4. In repo Settings → Pages, confirm the custom domain and enable **Enforce HTTPS** once the certificate issues.

Until then the site is served at `https://elusid108.github.io/chrismooredesigns/`. Astro's `base` stays `/` because that URL is temporary.

**Cross-linking from the portfolio.** No template change is required:

- `shop_url` in the CMS settings → `https://chrismooredesigns.com/`. This shows the hero's "Visit Shop" button. The label can be changed in the template if "Chris Moore Designs" reads better than "Visit Shop".
- Per-project `shopLink` → `https://chrismooredesigns.com/products/<slug>/`, not a Shopify URL. The product page stays the canonical landing page and keeps SEO on the domain you own.
- Families carry `portfolioSlug`, so family pages link back to `chrismoore.me/projects/<slug>/`.

## 3. Shopify integration

**Use the Storefront API directly, not the Buy Button SDK.** The Buy Button library is a wrapper around the same Storefront API, is large, and is not actively developed. A `fetch` wrapper (`src/lib/shopify.ts`, about 120 lines) gives full control over CSP and bundle size.

**Two moments of use:**

1. **Build time (GitHub Actions).** `AddToCart.astro` calls `getProductByHandle` for each product with a `shopifyHandle`, so the static HTML carries the real price, availability and first variant id. Product pages need no JavaScript to render. Without the env vars the build still succeeds and shows `placeholderPrice`.
2. **Runtime (browser).** The cart island calls `cartCreate`, `cartLinesAdd`, `cartLinesUpdate`, `cartLinesRemove` and `cart` on the Storefront API. The cart id lives in `localStorage`. "Checkout" is a plain link to `cart.checkoutUrl`.

**Stale prices.** A static page shows the price at last build. The cart mutation and the checkout are authoritative, so the worst case is a visitor seeing an old number until they add to cart. The weekly rebuild plus a "prices confirmed at checkout" line in the drawer covers it. Trigger `workflow_dispatch` after a price change if you want it live sooner.

**Token setup in Shopify.** Create a custom app (or use the Headless sales channel) with Storefront API access and grant only:

- `unauthenticated_read_product_listings`
- `unauthenticated_read_product_inventory` (optional, for availability)
- `unauthenticated_write_checkouts` and `unauthenticated_read_checkouts` (carts)

Do not grant customer, order or content scopes. Put the token in the repo as an Actions **secret** named `PUBLIC_SHOPIFY_STOREFRONT_TOKEN` and the domain as an Actions **variable** `PUBLIC_SHOPIFY_DOMAIN`. Pin `PUBLIC_SHOPIFY_API_VERSION` to a current quarterly version and bump it deliberately; Shopify supports each version for a year.

**Checkout domain.** By default `checkoutUrl` lands on `<store>.myshopify.com`, so visitors see the domain change at checkout. Recommended: point `shop.chrismooredesigns.com` at Shopify (`CNAME shops.myshopify.com`) and make it the store's primary domain. Checkout then runs on `shop.chrismooredesigns.com`, and you get a full Shopify-hosted storefront at that subdomain as a fallback with zero code. A fully custom checkout beyond that needs Shopify Plus, which is not needed here.

Things to confirm against Shopify's docs at build time because they change: the current Storefront API version to pin, whether the Headless channel or a custom app is the right place to mint the token on your plan, and any plan limits on Storefront API rate.

## 4. Security on GitHub Pages

GitHub Pages serves static files. It cannot run code, cannot set response headers, and cannot hold a secret. The design works with that rather than around it.

**What is public by design.**
- The Storefront API token. It can read the public catalogue and create carts. That is the same information the store's own theme exposes. It is kept in an Actions secret only so it can be rotated without a commit, not because it is sensitive.

**What must never be in this repo, in Actions logs, or in the client.**
- An Admin API token. It is not needed for this design and must not be introduced for convenience (for example to read inventory). If you ever need Admin data on the site, fetch it in a separate private workflow and commit only the derived JSON.
- Any customer or order data. The site never sees it; Shopify's hosted checkout does.

**Headers via meta.** `Base.astro` sets a `Content-Security-Policy` meta tag: `default-src 'self'`, `connect-src` limited to the store domain, `img-src` allowing `cdn.shopify.com`, `form-action` limited to `'self'` and the store, `object-src 'none'`, `upgrade-insecure-requests`. Known limits of the meta form:

- `frame-ancestors` is ignored in a meta tag, so clickjacking protection is not achievable on Pages. Mitigation: nothing on the site does anything sensitive on click; checkout is on Shopify, which sets its own headers.
- `report-uri` / `report-to` are ignored in meta. There is no CSP reporting.
- HSTS cannot be set. GitHub's "Enforce HTTPS" redirects HTTP to HTTPS, which is the practical equivalent for a site with no cookies.

**Scripts and fonts.** Production ships no CDN scripts; Tailwind is compiled. The Tailwind play CDN is used only in `design/mockups/`. If a third-party script is ever added (ESP Web Tools for the browser flasher is the likely one), pin its version and add `integrity` + `crossorigin="anonymous"`. Google Fonts cannot carry SRI because the CSS varies by user agent; self-hosting Inter and JetBrains Mono under `public/fonts/` removes that third party and is the recommended follow-up for both sites.

**No PII forms.** The static site has no contact or quote form that posts anywhere. Quote requests link to the portfolio's contact flow (EmailJS, already in place) or to a Shopify-hosted form. Adding a form here would mean adding a third-party form service and its privacy policy.

**Repo hygiene.** `.env` is gitignored. Turn on secret scanning and push protection in the repo settings. Enable Dependabot for npm and Actions. Actions are pinned by major tag as in the portfolio; pin to SHAs if you want stricter supply-chain guarantees.

**Firmware distribution.** Publish binaries as GitHub Releases on the firmware repos, list the SHA-256 in the `firmware` collection, and serve the ESP Web Tools manifest from this domain. Visitors can verify a download against the hash on the page.

## 5. What to do next

1. Pick a mockup direction (`/mockups/`). The winning page becomes the reference for `src/pages/index.astro` and the components.
2. Create the Shopify store, mint the Storefront token with the scopes above, add the Actions secret and variable, and set `shopifyHandle` on each product entry.
3. Split the domain (section 2) and add `public/CNAME`.
4. Set `shop_url` and `shopLink` values in the portfolio CMS and republish.
5. Copy `design/tokens.json` and `tokens.css` into the portfolio's `CMS/design/` and wire `CMS/lib/build.js` to read them (separate change in the Portfolio repo).
6. Self-host fonts on both sites.
