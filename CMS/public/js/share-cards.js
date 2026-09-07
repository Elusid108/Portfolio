// Share cards (CMS admin only) — renders the 1200x630 Open Graph images that
// social networks show when the site or a project is shared. Rendering happens
// in the browser so the cards use the site's Inter font and exact thumbnail
// crops; the server just writes the JPEGs to share/cards/.
//
// window.ShareCards = { renderProjectCard, renderSiteCard, renderAll, stripHtml }
// renderAll(projects, settings, onProgress, ids?) — omit ids to render every
// published card; pass an id list (from GET /api/share-cards/plan) to remake only those.
(function () {
  const W = 1200;
  const H = 630;
  const JPEG_QUALITY = 0.86;
  const FONT = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';

  // Same order and labels as the hero board in the site template.
  const HERO_CATEGORIES = [
    { id: 'Lighting', label: 'Lighting' },
    { id: 'Art', label: 'Art' },
    { id: 'Fixtures', label: 'Fixtures' },
    { id: 'Software', label: 'Software' },
    { id: 'Tooling', label: 'Shop' },
    { id: 'Systems', label: 'Systems' }
  ];

  function stripHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = String(html);
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function hostOf(url) {
    try { return new URL(url).host.replace(/^www\./, ''); }
    catch { return String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '') || 'chrismoore.me'; }
  }

  function mediaUrl(p) {
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    return '/' + p.replace(/^\/+/, '');
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      if (!src) { reject(new Error('No image')); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed to load: ' + src));
      img.src = src;
    });
  }

  async function ensureFonts() {
    if (!document.fonts) return;
    try {
      await Promise.all([
        document.fonts.load(`800 64px ${FONT}`),
        document.fonts.load(`600 24px ${FONT}`),
        document.fonts.load(`400 28px ${FONT}`)
      ]);
    } catch (_) { /* fall back to system fonts */ }
  }

  // Cover-fit an image into a rect, honoring the CMS crop ({ scale, x, y, rotate }).
  function drawCover(ctx, img, x, y, w, h, fit) {
    const base = Math.max(w / img.width, h / img.height);
    const scale = base * Math.max(1, Number(fit?.scale) || 1);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const fx = (Number.isFinite(Number(fit?.x)) ? Number(fit.x) : 50) / 100;
    const fy = (Number.isFinite(Number(fit?.y)) ? Number(fit.y) : 50) / 100;
    const dx = x - (dw - w) * fx;
    const dy = y - (dh - h) * fy;
    const rotate = Number(fit?.rotate) || 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (rotate) {
      const cx = x + w * fx;
      const cy = y + h * fy;
      ctx.translate(cx, cy);
      ctx.rotate(rotate * Math.PI / 180);
      ctx.translate(-cx, -cy);
    }
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Word-wraps text to maxLines, ellipsizing the last line.
  function wrapLines(ctx, text, maxWidth, maxLines) {
    const words = String(text || '').split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width <= maxWidth || !line) {
        line = test;
      } else {
        lines.push(line);
        line = word;
        if (lines.length === maxLines) break;
      }
    }
    if (lines.length < maxLines && line) lines.push(line);
    if (lines.length > maxLines) lines.length = maxLines;
    const consumed = lines.join(' ').split(' ').length;
    if (consumed < words.length && lines.length) {
      let last = lines[lines.length - 1];
      while (last.length && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1).trimEnd();
      lines[lines.length - 1] = last + '…';
    }
    return lines;
  }

  function drawBrand(ctx, title, x, y) {
    // Small cyan bolt + wordmark, mirroring the site nav.
    ctx.save();
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.moveTo(x + 11, y - 18); ctx.lineTo(x + 1, y + 2); ctx.lineTo(x + 10, y + 2);
    ctx.lineTo(x + 9, y + 16); ctx.lineTo(x + 19, y - 4); ctx.lineTo(x + 10, y - 4); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e4e4e7';
    ctx.font = `600 22px ${FONT}`;
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    ctx.fillText((title || 'Chris Moore Designs').toUpperCase(), x + 30, y);
    ctx.restore();
  }

  function drawHost(ctx, host, rightX, y) {
    ctx.save();
    ctx.font = `600 26px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(host).width;
    ctx.fillStyle = 'rgba(9,9,11,0.7)';
    roundRect(ctx, rightX - w - 36, y - 24, w + 36, 48, 24);
    ctx.fill();
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(host, rightX - 18, y + 1);
    ctx.restore();
  }

  function drawBackdrop(ctx) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0f0f14');
    g.addColorStop(1, '#09090b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Soft glows like the hero section.
    const glow = (cx, cy, color) => {
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 420);
      rg.addColorStop(0, color);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    };
    glow(W * 0.25, H * 0.3, 'rgba(6,182,212,0.22)');
    glow(W * 0.8, H * 0.85, 'rgba(147,51,234,0.22)');
  }

  async function renderProjectCard(project, settings = {}) {
    await ensureFonts();
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const host = hostOf(settings.site_url || 'https://chrismoore.me');

    drawBackdrop(ctx);

    const imgPath = project.thumbnail || project.image || '';
    let img = null;
    try { img = await loadImage(mediaUrl(imgPath)); } catch (_) { img = null; }
    if (img) {
      drawCover(ctx, img, 0, 0, W, H, project.thumbnailFit || null);
      // Darken toward the bottom-left so the copy stays legible over any photo.
      const g1 = ctx.createLinearGradient(0, H * 0.25, 0, H);
      g1.addColorStop(0, 'rgba(9,9,11,0)');
      g1.addColorStop(0.55, 'rgba(9,9,11,0.72)');
      g1.addColorStop(1, 'rgba(9,9,11,0.96)');
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, W, H);
      const g2 = ctx.createLinearGradient(0, 0, W, 0);
      g2.addColorStop(0, 'rgba(9,9,11,0.55)');
      g2.addColorStop(0.6, 'rgba(9,9,11,0.1)');
      g2.addColorStop(1, 'rgba(9,9,11,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, W, H);
      const g3 = ctx.createLinearGradient(0, 0, 0, 140);
      g3.addColorStop(0, 'rgba(9,9,11,0.6)');
      g3.addColorStop(1, 'rgba(9,9,11,0)');
      ctx.fillStyle = g3;
      ctx.fillRect(0, 0, W, 140);
    }

    drawBrand(ctx, settings.site_title, 64, 66);

    // Category pill
    const pad = 64;
    let cursorY = H - 72;
    const description = stripHtml(project.description);
    ctx.font = `400 28px ${FONT}`;
    const descLines = description ? wrapLines(ctx, description, W - pad * 2 - 40, 2) : [];
    const descBlock = descLines.length * 38;
    ctx.font = `800 62px ${FONT}`;
    const titleLines = wrapLines(ctx, project.title || 'Untitled project', W - pad * 2 - 40, 2);
    const titleBlock = titleLines.length * 70;

    // Lay out from the bottom up: host badge row, description, title, category.
    const descTop = cursorY - 40 - descBlock;
    const titleTop = descTop - (descLines.length ? 16 : 0) - titleBlock;
    const pillY = titleTop - 44;

    if (project.category) {
      ctx.save();
      ctx.font = `700 18px ${FONT}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
      const label = String(project.category).toUpperCase();
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(34,211,238,0.16)';
      roundRect(ctx, pad, pillY - 18, tw + 32, 36, 18);
      ctx.fill();
      ctx.strokeStyle = 'rgba(34,211,238,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#67e8f9';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, pad + 16, pillY + 1);
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 62px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 18;
    titleLines.forEach((line, i) => ctx.fillText(line, pad, titleTop + i * 70));
    ctx.restore();

    if (descLines.length) {
      ctx.save();
      ctx.fillStyle = '#d4d4d8';
      ctx.font = `400 28px ${FONT}`;
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 12;
      descLines.forEach((line, i) => ctx.fillText(line, pad, descTop + i * 38));
      ctx.restore();
    }

    drawHost(ctx, host, W - pad, H - 60);

    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  }

  // Featured project per category, else lowest order — identical to getHeroImage in the template.
  function heroProjectsByCategory(projects) {
    return HERO_CATEGORIES.map(cat => {
      const list = (projects || []).filter(p => p.category === cat.id && p.draft !== true);
      const featured = list.find(p => p.featured === true);
      const project = featured || list.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0] || null;
      return { ...cat, project };
    });
  }

  async function renderSiteCard(projects, settings = {}) {
    await ensureFonts();
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const host = hostOf(settings.site_url || 'https://chrismoore.me');
    const title = settings.site_title || 'Chris Moore Designs';
    const description = settings.site_description || 'Creative Technologist & Systems Integrator';

    drawBackdrop(ctx);

    // Hero board: 3 columns x 2 rows of category thumbnails filling the right ~58%.
    const boardX = 520;
    const boardW = W - boardX;
    const cols = 3, rows = 2, gap = 10;
    const cellW = (boardW - gap * (cols - 1)) / cols;
    const cellH = (H - gap * (rows - 1)) / rows;
    const tiles = heroProjectsByCategory(projects);
    for (let i = 0; i < tiles.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = boardX + col * (cellW + gap);
      const y = row * (cellH + gap);
      const tile = tiles[i];
      ctx.fillStyle = '#18181b';
      ctx.fillRect(x, y, cellW, cellH);
      const p = tile.project;
      if (p) {
        try {
          const img = await loadImage(mediaUrl(p.thumbnail || p.image));
          drawCover(ctx, img, x, y, cellW, cellH, p.thumbnailFit || null);
        } catch (_) { /* leave the dark tile */ }
      }
      // Bottom gradient + label per tile, like HeroBadge.
      const g = ctx.createLinearGradient(0, y + cellH * 0.35, 0, y + cellH);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.85)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cellW, cellH);
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 22px ${FONT}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(tile.label, x + 18, y + cellH - 18);
      ctx.restore();
    }
    // Fade the board into the text panel.
    const fade = ctx.createLinearGradient(boardX - 40, 0, boardX + 220, 0);
    fade.addColorStop(0, 'rgba(12,12,16,1)');
    fade.addColorStop(1, 'rgba(12,12,16,0)');
    ctx.fillStyle = fade;
    ctx.fillRect(boardX - 40, 0, 260, H);

    drawBrand(ctx, title, 64, 66);

    const pad = 64;
    const textW = boardX - pad - 20;
    ctx.font = `800 66px ${FONT}`;
    const words = title.split(' ');
    const titleLines = words.length >= 2 && words.length <= 3 ? [words.slice(0, -1).join(' '), words[words.length - 1] + '.'] : wrapLines(ctx, title, textW, 2);
    ctx.font = `400 26px ${FONT}`;
    const descLines = wrapLines(ctx, description, textW, 3);

    const titleH = titleLines.length * 72;
    const descH = descLines.length * 36;
    const blockH = titleH + 24 + descH;
    let y = (H - blockH) / 2 + 10;

    ctx.save();
    ctx.textBaseline = 'top';
    ctx.font = `800 66px ${FONT}`;
    titleLines.forEach((line, i) => {
      if (i === titleLines.length - 1 && titleLines.length > 1) {
        const grad = ctx.createLinearGradient(pad, 0, pad + ctx.measureText(line).width, 0);
        grad.addColorStop(0, '#22d3ee');
        grad.addColorStop(1, '#a855f7');
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = '#ffffff';
      }
      ctx.fillText(line, pad, y + i * 72);
    });
    y += titleH + 24;
    ctx.fillStyle = '#a1a1aa';
    ctx.font = `400 26px ${FONT}`;
    descLines.forEach((line, i) => ctx.fillText(line, pad, y + i * 36));
    ctx.restore();

    ctx.save();
    ctx.font = `600 24px ${FONT}`;
    ctx.fillStyle = '#22d3ee';
    ctx.textBaseline = 'middle';
    ctx.fillText(host, pad, H - 60);
    ctx.restore();

    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  }

  // Renders published project cards plus the site card.
  // ids: optional list of card IDs to render (e.g. ['site','670']). Omit to
  // render everything. onProgress(done, total) is called after each card.
  async function renderAll(projects, settings, onProgress = () => {}, ids = null) {
    const published = (projects || []).filter(p => p.draft !== true);
    const want = ids ? new Set(ids.map(String)) : null;
    const targets = [];
    if (!want || want.has('site')) targets.push({ kind: 'site' });
    for (const p of published) {
      if (!want || want.has(String(p.id))) targets.push({ kind: 'project', project: p });
    }
    const total = targets.length;
    const cards = [];
    let done = 0;
    for (const t of targets) {
      if (t.kind === 'site') {
        cards.push({ id: 'site', dataUrl: await renderSiteCard(published, settings) });
      } else {
        try {
          cards.push({ id: String(t.project.id), dataUrl: await renderProjectCard(t.project, settings) });
        } catch (err) {
          console.warn('Share card failed for', t.project.title, err);
        }
      }
      onProgress(++done, total);
    }
    return cards;
  }

  window.ShareCards = { renderProjectCard, renderSiteCard, renderAll, stripHtml, heroProjectsByCategory };
})();
