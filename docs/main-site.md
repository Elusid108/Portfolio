# Main site (chrismooredesigns.com)

The portfolio at chrismoore.me is one of two sites. The product/store site for
pro-sumer DIYers lives in its own repository:

- **Repo:** https://github.com/Elusid108/chris-moore-designs
- **Stack:** Astro + Tailwind v4, built by GitHub Actions, served by GitHub Pages
- **Store:** Shopify Storefront API (cart on-site, hosted checkout on Shopify)
- **Design tokens:** `design/tokens.json` and `design/tokens.css` in that repo are
  the source of truth. They are meant to be copied into `CMS/design/` here and
  read by `CMS/lib/build.js` (follow-up change), so both sites share one palette.
- **UI mockups:** `design/mockups/` there, served at `/mockups/` on the deployed site.
- **Integration and security notes:** `docs/INTEGRATION.md` there.

## How this repo links to it

Nothing in the template needs to change. Two CMS settings already exist:

| Setting | Where | Value once the main site is live |
|---|---|---|
| `shop_url` | CMS → Settings (site-wide). Shows the hero "Visit Shop" button. | `https://chrismooredesigns.com/` |
| `shopLink` | Per project. Shows the "KIT" link on the project card. | `https://chrismooredesigns.com/products/<slug>/` (the product page, not a Shopify URL) |

Set them in the CMS and republish. Optionally relabel the hero button from
"Visit Shop" in `CMS/template/Portfolio Template.html` (search for `Visit Shop`).

## Domain

chrismooredesigns.com currently redirects to chrismoore.me at the registrar.
Splitting it is a DNS change plus a `public/CNAME` file in the other repo; the
steps are in that repo's `docs/INTEGRATION.md`, section 2. Nothing here changes.
