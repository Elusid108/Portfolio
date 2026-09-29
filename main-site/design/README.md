# Design

## Tokens

`tokens.json` is the single source of truth for colors, fonts, radii and the
PixelField constants. `tokens.css` is its Tailwind v4 `@theme` rendering and is
imported by `src/styles/global.css`.

The portfolio (`Elusid108/Portfolio`) compiles Tailwind inside its local CMS and
cannot import from this repo, so the same two files are **copied** into
`CMS/design/` there. When you change a value:

1. Edit `tokens.json` and `tokens.css` here.
2. Copy both files into the portfolio repo and republish from the CMS.
3. `diff` the two copies before committing either side.

## Mockups

`mockups/` holds the five candidate UI directions as self-contained HTML pages
(Tailwind CDN + Google Fonts, no build). They are copied verbatim into
`dist/mockups/` by `scripts/copy-mockups.mjs` after every build so they can be
viewed on the deployed site, and are excluded from `astro check`.

Once a direction is chosen, the winning page is the reference for building the
real components under `src/components/`; the mockups folder can then be deleted.
