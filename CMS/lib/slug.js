// URL slugs for the static project pages (projects/<slug>/). A slug is assigned
// once and saved with the project so shared or printed links never change on
// their own; renaming a slug in the CMS keeps the old one in slugHistory, which
// publishes a forwarding page.

function slugify(text) {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'project';
}

function cleanSlug(value) {
  return value ? slugify(value) : '';
}

// Gives every project a unique slug (keeping the ones it already has).
// Returns true when anything changed so the caller can save projects.json.
function ensureSlugs(projects) {
  let changed = false;
  const taken = new Set();
  for (const p of projects) {
    for (const old of Array.isArray(p.slugHistory) ? p.slugHistory : []) taken.add(old);
  }
  for (const p of projects) {
    const clean = cleanSlug(p.slug);
    if (clean && !taken.has(clean)) {
      if (clean !== p.slug) { p.slug = clean; changed = true; }
      taken.add(clean);
    } else {
      if (p.slug) delete p.slug; // duplicate: reassign below
    }
  }
  for (const p of projects) {
    if (p.slug) continue;
    const base = slugify(p.title);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    p.slug = slug;
    taken.add(slug);
    changed = true;
  }
  return changed;
}

// Applied when a project is saved: normalise an edited slug and remember the old one.
function trackSlugChange(existing, incoming) {
  if (!existing || !incoming || incoming.slug === undefined) return;
  const next = cleanSlug(incoming.slug);
  incoming.slug = next || existing.slug || '';
  if (existing.slug && next && next !== existing.slug) {
    const history = new Set(Array.isArray(existing.slugHistory) ? existing.slugHistory : []);
    history.add(existing.slug);
    history.delete(next);
    incoming.slugHistory = [...history];
  }
}

module.exports = { slugify, ensureSlugs, trackSlugChange };
