const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const convertHeic = require('heic-convert');
const { getProjects, getSettings, writeJSON } = require('./data');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const MEDIA_DIR = path.join(PORTFOLIO_ROOT, 'media');
const DATA_DIR = path.join(__dirname, '..', 'data');

const CATEGORY_FOLDER_MAP = {
  'Lighting': 'Lighting',
  'Art': 'Art',
  'Fixtures': 'Electronics',
  'Software': 'Apps',
  'Tooling': 'Fabrication',
  'Systems': 'Integration',
  'Sculpture': 'Art',
  'Circuits': 'Electronics',
  'Apps': 'Apps',
  'Solutions': 'Fabrication',
  'Integration': 'Integration'
};

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_');
}

const MEDIA_KINDS = ['img', 'vid', 'gfx'];
const NAMED_PRIMARY_RE = /^(.+)-(img|vid|gfx)-([a-z0-9]{6})$/;
const NAMED_COMPANION_RE = /^(.+)-(img|vid|gfx)-([a-z0-9]{6})-(poster-thumb|poster|thumb)$/i;

function titleSlug(title) {
  const slug = String(title || 'Untitled')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'Untitled';
}

function randomMediaId() {
  return crypto.randomBytes(4).toString('hex').slice(0, 6);
}

function mediaStem(projectTitle, kind) {
  const k = MEDIA_KINDS.includes(kind) ? kind : 'img';
  return `${titleSlug(projectTitle)}-${k}-${randomMediaId()}`;
}

function allocateMediaStem(destDir, projectTitle, kind) {
  fs.mkdirSync(destDir, { recursive: true });
  for (let i = 0; i < 40; i++) {
    const stem = mediaStem(projectTitle, kind);
    const taken = ['webp', 'mp4', 'glb', 'webm', 'mov', 'm4v'].some((ext) =>
      fs.existsSync(path.join(destDir, `${stem}.${ext}`))
    );
    if (!taken) return stem;
  }
  throw new Error('Could not allocate a unique media filename');
}

function parseNamedPrimary(stem) {
  const m = String(stem || '').match(NAMED_PRIMARY_RE);
  return m ? { slug: m[1], kind: m[2], id: m[3] } : null;
}

function parseNamedCompanion(stem) {
  const m = String(stem || '').match(NAMED_COMPANION_RE);
  return m ? { slug: m[1], kind: m[2], id: m[3], role: m[4].toLowerCase() } : null;
}

function looksLikeHeic(buf) {
  if (!buf || buf.length < 12) return false;
  const brand = buf.slice(8, 12).toString('ascii');
  return buf.slice(4, 8).toString('ascii') === 'ftyp' &&
    ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand);
}

async function toDecodableBuffer(srcPath, srcBuffer) {
  const buf = srcBuffer || fs.readFileSync(srcPath);
  if (!looksLikeHeic(buf)) return buf;

  // Sharp's Windows libvips build often lacks HEVC decoding for HEIC files
  // (even when renamed .jpg). Convert via WASM first, then hand off to Sharp.
  const jpeg = await convertHeic({ buffer: buf, format: 'JPEG', quality: 0.92 });
  return Buffer.from(jpeg);
}

// This repo lives inside a synced OneDrive folder, which briefly locks
// newly-written files (EPERM on unlink) while it hashes/uploads them. That
// can outlast a naive single-attempt delete, so cleanup of multer's temp
// upload file runs in the background with backoff, well outside the
// request/response path, and simply gives up (leaving a harmless leftover
// temp file) if the lock never clears.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleUnlink(filePath, delays = [300, 800, 1500, 3000, 6000, 10000]) {
  (async () => {
    for (let i = 0; i < delays.length; i++) {
      try {
        fs.unlinkSync(filePath);
        return;
      } catch (err) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < delays.length - 1) {
          await sleep(delays[i]);
          continue;
        }
        console.error(`Failed to delete temp file ${filePath}:`, err.message);
        return;
      }
    }
  })();
}

async function processUpload(file, category, projectName) {
  const originalName = sanitize(file.originalname);
  let destDir, webDir, stem;

  if (category === '_root' || !projectName) {
    destDir = MEDIA_DIR;
    webDir = 'media';
    stem = path.parse(originalName).name;
  } else {
    const folder = CATEGORY_FOLDER_MAP[category] || category;
    const safeProject = sanitize(projectName);
    destDir = path.join(MEDIA_DIR, folder, safeProject);
    webDir = `media/${folder}/${safeProject}`;
    stem = allocateMediaStem(destDir, projectName, 'img');
  }

  const webpName = `${stem}.webp`;
  const thumbName = `${stem}-thumb.webp`;
  const webPath = `${webDir}/${webpName}`;
  const thumbWebPath = `${webDir}/${thumbName}`;

  fs.mkdirSync(destDir, { recursive: true });

  const srcPath = file.path || null;
  const srcBuffer = file.buffer || null;
  const destPath = path.join(destDir, webpName);
  const thumbPath = path.join(destDir, thumbName);

  let workingBuffer;
  try {
    workingBuffer = await toDecodableBuffer(srcPath, srcBuffer);
  } catch (err) {
    if (srcPath) scheduleUnlink(srcPath);
    throw new Error(`Image processing failed for "${file.originalname}" — HEIC/HEIF conversion failed (${err.message})`);
  }

  try {
    await sharp(workingBuffer, { failOn: 'none' })
      .rotate()
      .webp({ quality: 85 })
      .toFile(destPath);
  } catch (err) {
    console.error('Sharp processing error:', err.message);
  }

  try {
    await sharp(workingBuffer, { failOn: 'none' })
      .rotate()
      .resize(800, null, { withoutEnlargement: true })
      .webp({ quality: 75 })
      .toFile(thumbPath);
  } catch (err) {
    console.error('Sharp thumbnail error:', err.message);
  }

  const destOk = fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
  const thumbOk = fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0;

  if (!destOk) {
    try { fs.unlinkSync(destPath); } catch (_) {}
    try { fs.unlinkSync(thumbPath); } catch (_) {}
    if (srcPath) scheduleUnlink(srcPath);
    throw new Error(`Image processing failed for "${file.originalname}" — format may not be supported`);
  }

  if (srcPath) {
    scheduleUnlink(srcPath);
  }

  return { path: webPath, thumbnail: thumbOk ? thumbWebPath : webPath };
}

async function processFileUpload(file, category, projectName) {
  const originalName = sanitize(file.originalname);
  const folder = CATEGORY_FOLDER_MAP[category] || category;
  const safeProject = sanitize(projectName);
  const destDir = path.join(MEDIA_DIR, folder, safeProject, 'files');
  const webPath = `media/${folder}/${safeProject}/files/${originalName}`;

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(file.path, path.join(destDir, originalName));
  scheduleUnlink(file.path);

  return webPath;
}

// --- 3D models ---
//
// Models are converted to GLB in the CMS browser (three.js loaders +
// occt-import-js for STEP). Only the GLB is stored — it is a reduced-poly
// preview for the website, so the original STL/3MF/STEP never lands in the
// repo and is never offered for download.

const MODEL_FORMATS = ['stl', '3mf', 'step', 'glb'];

function normalizeModelFormat(format, fallbackName) {
  let f = String(format || '').toLowerCase().replace(/^\./, '');
  if (!f && fallbackName) f = path.extname(fallbackName).toLowerCase().replace(/^\./, '');
  if (f === 'stp') f = 'step';
  return MODEL_FORMATS.includes(f) ? f : 'glb';
}

async function processModelUpload(glbFile, category, projectName, { format, originalName } = {}) {
  if (!glbFile) throw new Error('No GLB uploaded');

  const folder = CATEGORY_FOLDER_MAP[category] || category;
  const safeProject = sanitize(projectName);
  const destDir = path.join(MEDIA_DIR, folder, safeProject, 'models');
  fs.mkdirSync(destDir, { recursive: true });

  const stem = allocateMediaStem(destDir, projectName, 'gfx');
  const glbName = `${stem}.glb`;
  const webDir = `media/${folder}/${safeProject}/models`;

  await retryFsOp(() => { fs.copyFileSync(glbFile.path, path.join(destDir, glbName)); });
  scheduleUnlink(glbFile.path);

  return { path: `${webDir}/${glbName}`, format: normalizeModelFormat(format, originalName) };
}

// --- Fix File Structure ---
//
// Media on disk is originally filed under media/<categoryFolder>/<projectTitle>/...
// but renaming a project's title or moving it to a different category never moves
// the files that were already uploaded — it just changes the JSON, leaving the old
// path working but stale. fixFileStructure() walks every project, moves/copies its
// media onto the canonical path for its *current* title/category, rewrites every
// reference in projects.json, and removes whatever empty folders are left behind.

function targetWebDirForProject(project) {
  const folder = CATEGORY_FOLDER_MAP[project.category] || project.category || 'Misc';
  const safeProject = sanitize(project.title || 'Untitled');
  return `media/${folder}/${safeProject}`;
}

function toWebPath(absPath) {
  return path.relative(PORTFOLIO_ROOT, absPath).split(path.sep).join('/');
}

function webPathToAbs(webPath) {
  return path.join(PORTFOLIO_ROOT, ...webPath.split('/'));
}

function uniquePath(destAbs) {
  if (!fs.existsSync(destAbs)) return destAbs;
  const dir = path.dirname(destAbs);
  const ext = path.extname(destAbs);
  const base = path.basename(destAbs, ext);
  let i = 2;
  let candidate;
  do {
    candidate = path.join(dir, `${base}-${i}${ext}`);
    i++;
  } while (fs.existsSync(candidate));
  return candidate;
}

// Moves (or, for assets shared between projects, copies) a single media
// reference onto the project's canonical folder. Returns the possibly-updated
// web path to store back in the JSON.
function relocateAsset(oldWebPath, targetWebDir, ctx) {
  if (typeof oldWebPath !== 'string' || !oldWebPath.startsWith('media/')) return oldWebPath;

  const parts = oldWebPath.split('/');
  if (parts.length < 4) return oldWebPath; // not scoped to a project folder, leave alone

  const suffix = parts.slice(3).join('/');
  const newWebPath = `${targetWebDir}/${suffix}`;

  if (newWebPath === oldWebPath) return oldWebPath;

  const oldAbs = webPathToAbs(oldWebPath);
  const desiredNewAbs = webPathToAbs(newWebPath);

  if (fs.existsSync(oldAbs)) {
    const newAbs = uniquePath(desiredNewAbs);
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    fs.renameSync(oldAbs, newAbs);
    ctx.movedFrom.set(oldAbs, newAbs);
    ctx.moved++;
    return toWebPath(newAbs);
  }

  if (ctx.movedFrom.has(oldAbs)) {
    const relocated = ctx.movedFrom.get(oldAbs);
    if (relocated === desiredNewAbs) {
      return toWebPath(relocated);
    }
    // Same source file already relocated for a different project reference
    // (a shared asset) — give this project its own copy at its target path.
    const newAbs = uniquePath(desiredNewAbs);
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    fs.copyFileSync(relocated, newAbs);
    ctx.copied++;
    return toWebPath(newAbs);
  }

  ctx.missing++;
  ctx.warnings.push(oldWebPath);
  return oldWebPath;
}

function relocateFileEntry(file, targetWebDir, ctx) {
  if (typeof file === 'string') return relocateAsset(file, targetWebDir, ctx);
  if (!file || typeof file !== 'object') return file;
  const updated = { ...file };
  if (typeof file.url === 'string') updated.url = relocateAsset(file.url, targetWebDir, ctx);
  if (typeof file.image === 'string') updated.image = relocateAsset(file.image, targetWebDir, ctx);
  if (typeof file.thumbnail === 'string') updated.thumbnail = relocateAsset(file.thumbnail, targetWebDir, ctx);
  return updated;
}

function removeEmptyDirs(dir, isRoot = false) {
  if (!fs.existsSync(dir)) return 0;
  let removedCount = 0;

  for (const entry of fs.readdirSync(dir)) {
    if (isRoot && entry === '_trash') continue;
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      removedCount += removeEmptyDirs(full, false);
    }
  }

  if (!isRoot && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    removedCount++;
  }

  return removedCount;
}

function fixFileStructure() {
  const projects = getProjects();
  const ctx = { moved: 0, copied: 0, missing: 0, warnings: [], movedFrom: new Map() };

  for (const project of projects) {
    const targetWebDir = targetWebDirForProject(project);

    if (typeof project.image === 'string' && project.image) {
      project.image = relocateAsset(project.image, targetWebDir, ctx);
    }

    if (typeof project.thumbnail === 'string' && project.thumbnail) {
      project.thumbnail = relocateAsset(project.thumbnail, targetWebDir, ctx);
    }

    if (Array.isArray(project.gallery)) {
      project.gallery = project.gallery.map(item => {
        if (typeof item === 'string') {
          return relocateAsset(item, targetWebDir, ctx);
        }
        if (item && typeof item === 'object' && typeof item.url === 'string') {
          const updated = { ...item, url: relocateAsset(item.url, targetWebDir, ctx) };
          if (typeof item.poster === 'string') {
            updated.poster = relocateAsset(item.poster, targetWebDir, ctx);
          }
          if (typeof item.thumbnail === 'string') {
            updated.thumbnail = relocateAsset(item.thumbnail, targetWebDir, ctx);
          }
          return updated;
        }
        return item;
      });
    }

    if (Array.isArray(project.files)) {
      project.files = project.files.map(file => relocateFileEntry(file, targetWebDir, ctx));
    }
  }

  const projectsPath = path.join(DATA_DIR, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify(projects, null, 2), 'utf-8');

  const removedDirs = removeEmptyDirs(MEDIA_DIR, true);

  return {
    moved: ctx.moved,
    copied: ctx.copied,
    missing: ctx.missing,
    removedDirs,
    warnings: ctx.warnings
  };
}

// Relocates all media for a single project to its canonical path based on the
// project's current category and title. Returns the updated project object with
// corrected paths plus relocation stats. Call this when category or title changes
// before writing the project to projects.json.
function relocateProject(project) {
  const ctx = { moved: 0, copied: 0, missing: 0, warnings: [], movedFrom: new Map() };
  const targetWebDir = targetWebDirForProject(project);
  const updated = { ...project };

  if (typeof updated.image === 'string' && updated.image) {
    updated.image = relocateAsset(updated.image, targetWebDir, ctx);
  }

  if (typeof updated.thumbnail === 'string' && updated.thumbnail) {
    updated.thumbnail = relocateAsset(updated.thumbnail, targetWebDir, ctx);
  }

  // project-level video — local paths only (not YouTube URLs)
  if (typeof updated.video === 'string' && updated.video.startsWith('media/')) {
    updated.video = relocateAsset(updated.video, targetWebDir, ctx);
  }

  if (Array.isArray(updated.gallery)) {
    updated.gallery = updated.gallery.map(item => {
      if (typeof item === 'string') return relocateAsset(item, targetWebDir, ctx);
      if (item && typeof item === 'object' && typeof item.url === 'string') {
        const result = { ...item, url: relocateAsset(item.url, targetWebDir, ctx) };
        if (typeof item.poster === 'string') result.poster = relocateAsset(item.poster, targetWebDir, ctx);
        if (typeof item.thumbnail === 'string') result.thumbnail = relocateAsset(item.thumbnail, targetWebDir, ctx);
        return result;
      }
      return item;
    });
  }

  if (Array.isArray(updated.files)) {
    updated.files = updated.files.map(file => relocateFileEntry(file, targetWebDir, ctx));
  }

  if (ctx.moved > 0) removeEmptyDirs(MEDIA_DIR, true);

  return { project: updated, moved: ctx.moved, copied: ctx.copied, missing: ctx.missing, warnings: ctx.warnings };
}

// --- Unused media trash ---
//
// Uploads write files immediately, but removing a gallery row, replacing a
// banner, recapturing a video frame, or deleting a project only updates JSON.
// These helpers move unreferenced files under media/ into media/_trash/ so
// they can be restored by moving them back.

const TRASH_DIRNAME = '_trash';

function normalizeMediaPath(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (s.startsWith('/')) s = s.slice(1);
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/\\/g, '/');
  if (!s.startsWith('media/')) return null;
  if (s.startsWith(`media/${TRASH_DIRNAME}/`)) return null;
  s = s.replace(/[.,;:)]+$/, '');
  return s || null;
}

function addMediaPath(set, value) {
  const normalized = normalizeMediaPath(value);
  if (normalized) set.add(normalized);
}

function extractMediaFromHtml(html, set) {
  if (typeof html !== 'string' || !html) return;
  const re = /media\/[^\s"'<>\\]+/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    addMediaPath(set, match[0]);
  }
}

function collectPathsFromProject(project, set = new Set()) {
  if (!project || typeof project !== 'object') return set;
  addMediaPath(set, project.image);
  addMediaPath(set, project.thumbnail);
  addMediaPath(set, project.video);
  if (Array.isArray(project.gallery)) {
    for (const item of project.gallery) {
      if (typeof item === 'string') {
        addMediaPath(set, item);
      } else if (item && typeof item === 'object') {
        addMediaPath(set, item.url);
        addMediaPath(set, item.poster);
        addMediaPath(set, item.thumbnail);
      }
    }
  }
  if (Array.isArray(project.files)) {
    for (const file of project.files) {
      if (typeof file === 'string') {
        addMediaPath(set, file);
      } else if (file && typeof file === 'object') {
        addMediaPath(set, file.url);
        addMediaPath(set, file.image);
        addMediaPath(set, file.thumbnail);
      }
    }
  }
  extractMediaFromHtml(project.description, set);
  extractMediaFromHtml(project.longDescription, set);
  extractMediaFromHtml(project.specs, set);
  return set;
}

function collectPathsFromSettings(settings, set = new Set()) {
  if (!settings || typeof settings !== 'object') return set;
  addMediaPath(set, settings.about_headshot);
  extractMediaFromHtml(settings.about_text, set);
  return set;
}

function collectEntityPaths(entity) {
  const set = new Set();
  collectPathsFromProject(entity, set);
  collectPathsFromSettings(entity, set);
  return set;
}

function companionPaths(webPath) {
  const slash = webPath.lastIndexOf('/');
  if (slash === -1) return [];
  const dir = webPath.slice(0, slash);
  const base = webPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot === -1 ? base : base.slice(0, dot);
  const ext = dot === -1 ? '' : base.slice(dot);
  const companions = [];

  if (ext.toLowerCase() === '.webp' && !stem.endsWith('-thumb')) {
    companions.push(`${dir}/${stem}-thumb.webp`);
  }
  if (/\.(mp4|webm|mov|m4v|avi)$/i.test(ext)) {
    companions.push(`${dir}/${stem}-poster.webp`);
    companions.push(`${dir}/${stem}-poster-thumb.webp`);
  }
  if (ext.toLowerCase() === '.glb') {
    companions.push(`${dir}/${stem}-poster.webp`);
    companions.push(`${dir}/${stem}-poster-thumb.webp`);
  }
  return companions;
}

function addCompanions(set) {
  const extra = [];
  for (const webPath of set) {
    extra.push(...companionPaths(webPath));
  }
  extra.forEach((p) => set.add(p));
  return set;
}

function collectReferencedPaths(projects, settings) {
  const set = new Set();
  (projects || getProjects()).forEach((p) => collectPathsFromProject(p, set));
  collectPathsFromSettings(settings || getSettings(), set);
  addCompanions(set);
  return set;
}

function listMediaFiles(dir = MEDIA_DIR, acc = [], isMediaRoot = true) {
  if (!fs.existsSync(dir)) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const entry of entries) {
    if (isMediaRoot && entry.name === TRASH_DIRNAME) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listMediaFiles(full, acc, false);
    } else if (entry.isFile()) {
      acc.push(toWebPath(full));
    }
  }
  return acc;
}

async function retryFsOp(fn, delays = [300, 800, 1500, 3000, 6000, 10000]) {
  let lastErr;
  for (let i = 0; i < delays.length; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < delays.length - 1) {
        await sleep(delays[i]);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function moveToTrash(webPath) {
  const srcAbs = webPathToAbs(webPath);
  try {
    if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
      return { ok: false, reason: 'missing' };
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const rel = webPath.replace(/^media\//, '');
  const destAbs = uniquePath(path.join(MEDIA_DIR, TRASH_DIRNAME, ...rel.split('/')));
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });

  try {
    await retryFsOp(() => { fs.renameSync(srcAbs, destAbs); });
    return { ok: true, dest: toWebPath(destAbs) };
  } catch (_) {
    try {
      await retryFsOp(() => { fs.copyFileSync(srcAbs, destAbs); });
      await retryFsOp(() => { fs.unlinkSync(srcAbs); });
      return { ok: true, dest: toWebPath(destAbs) };
    } catch (copyErr) {
      return { ok: false, reason: copyErr.message };
    }
  }
}

async function trashPaths(candidates) {
  const moved = [];
  const warnings = [];
  const seen = new Set();

  for (const webPath of candidates) {
    if (!webPath || seen.has(webPath)) continue;
    seen.add(webPath);
    const result = await moveToTrash(webPath);
    if (result.ok) {
      moved.push(webPath);
    } else if (result.reason !== 'missing') {
      warnings.push(`${webPath}: ${result.reason}`);
    }
  }

  if (moved.length > 0) removeEmptyDirs(MEDIA_DIR, true);
  return { moved: moved.length, files: moved, warnings };
}

async function trashUnusedMedia() {
  const used = collectReferencedPaths();
  const unused = listMediaFiles().filter((p) => !used.has(p));
  return trashPaths(unused);
}

function webBasename(webPath) {
  const parts = String(webPath || '').split('/');
  return parts[parts.length - 1] || '';
}

function webDirname(webPath) {
  const i = String(webPath || '').lastIndexOf('/');
  return i === -1 ? '' : webPath.slice(0, i);
}

function webStem(webPath) {
  const base = webBasename(webPath);
  const d = base.lastIndexOf('.');
  return d === -1 ? base : base.slice(0, d);
}

function webExt(webPath) {
  const base = webBasename(webPath);
  const d = base.lastIndexOf('.');
  return d === -1 ? '' : base.slice(d).toLowerCase();
}

function skipRename(webPath) {
  const n = normalizeMediaPath(webPath);
  if (!n) return true;
  if (n.includes('/files/')) return true;
  const parts = n.split('/');
  return parts.length < 4;
}

function kindFromPrimary(webPath) {
  const ext = webExt(webPath);
  if (['.mp4', '.webm', '.mov', '.m4v', '.avi'].includes(ext)) return 'vid';
  if (ext === '.glb') return 'gfx';
  return 'img';
}

function companionRole(webPath) {
  const stem = webStem(webPath);
  const named = parseNamedCompanion(stem);
  if (named) return named.role;
  if (/-poster-thumb$/i.test(stem)) return 'poster-thumb';
  if (/-poster$/i.test(stem)) return 'poster';
  if (/-thumb$/i.test(stem)) return 'thumb';
  return null;
}

function companionSuffix(role) {
  if (role === 'poster-thumb') return '-poster-thumb.webp';
  if (role === 'poster') return '-poster.webp';
  if (role === 'thumb') return '-thumb.webp';
  return null;
}

function galleryCompanionRole(primaryKind, field, webPath) {
  const named = companionRole(webPath);
  if (primaryKind === 'vid' || primaryKind === 'gfx') {
    if (field === 'poster') return named === 'poster-thumb' ? 'poster-thumb' : 'poster';
    if (field === 'thumbnail') return named === 'poster' ? 'poster' : 'poster-thumb';
  }
  return named || 'thumb';
}

function familyOwningPath(webPath, families, currentFam) {
  const asPrimary = families.find((f) => f.primary === webPath);
  if (asPrimary) return asPrimary;
  const namedC = parseNamedCompanion(webStem(webPath));
  if (namedC) {
    const stem = `${namedC.slug}-${namedC.kind}-${namedC.id}`;
    const match = families.find((f) => webStem(f.primary) === stem);
    if (match) return match;
  }
  const namedP = parseNamedPrimary(webStem(webPath));
  if (namedP) {
    const stem = `${namedP.slug}-${namedP.kind}-${namedP.id}`;
    const match = families.find((f) => webStem(f.primary) === stem);
    if (match) return match;
  }
  const imgFam = families.find((f) => f.kind === 'img' && f.companions.some((c) => c.path === webPath));
  if (imgFam) return imgFam;
  return currentFam;
}

function applyPathMapping(value, mapping) {
  if (typeof value !== 'string' || !value.includes('media/')) return value;
  let out = value;
  const keys = [...mapping.keys()]
    .filter((oldPath) => mapping.get(oldPath) && mapping.get(oldPath) !== oldPath)
    .sort((a, b) => b.length - a.length);
  for (const oldPath of keys) {
    if (out.includes(oldPath)) out = out.split(oldPath).join(mapping.get(oldPath));
  }
  return out;
}

function collectRenameFamilies(projects, settings) {
  const families = new Map();

  const addPrimary = (raw) => {
    const n = normalizeMediaPath(raw);
    if (!n || skipRename(n)) return null;
    if (companionRole(n)) return null;
    if (!families.has(n)) {
      families.set(n, { primary: n, kind: kindFromPrimary(n), companions: [] });
    }
    return families.get(n);
  };

  const addCompanion = (primaryRaw, companionRaw, roleHint) => {
    const fam = addPrimary(primaryRaw);
    if (!fam) return;
    const n = normalizeMediaPath(companionRaw);
    if (!n || skipRename(n) || n === fam.primary) return;
    const role = roleHint || companionRole(n) || (fam.kind === 'img' ? 'thumb' : 'poster');
    if (!fam.companions.some((c) => c.path === n)) {
      fam.companions.push({ path: n, role });
    }
  };

  const visitProject = (project) => {
    addPrimary(project.image);
    if (project.image && project.thumbnail && companionRole(project.thumbnail)) {
      addCompanion(project.image, project.thumbnail);
    } else if (project.thumbnail && !companionRole(project.thumbnail)) {
      addPrimary(project.thumbnail);
    }
    if (typeof project.video === 'string' && project.video.startsWith('media/')) {
      addPrimary(project.video);
    }
    if (Array.isArray(project.gallery)) {
      for (const item of project.gallery) {
        const url = typeof item === 'string' ? item : item && item.url;
        addPrimary(url);
        if (item && typeof item === 'object') {
          const kind = kindFromPrimary(url);
          if (item.poster) addCompanion(url, item.poster, galleryCompanionRole(kind, 'poster', item.poster));
          if (item.thumbnail) addCompanion(url, item.thumbnail, galleryCompanionRole(kind, 'thumbnail', item.thumbnail));
        }
      }
    }
    if (Array.isArray(project.files)) {
      for (const file of project.files) {
        if (!file || typeof file === 'string') continue;
        if (file.image) {
          addPrimary(file.image);
          if (file.thumbnail && companionRole(file.thumbnail)) addCompanion(file.image, file.thumbnail);
          else if (file.thumbnail) addPrimary(file.thumbnail);
        }
      }
    }
    const htmlSet = new Set();
    extractMediaFromHtml(project.description, htmlSet);
    extractMediaFromHtml(project.longDescription, htmlSet);
    extractMediaFromHtml(project.specs, htmlSet);
    htmlSet.forEach((p) => addPrimary(p));
  };

  (projects || []).forEach(visitProject);
  if (settings) {
    addPrimary(settings.about_headshot);
    const htmlSet = new Set();
    extractMediaFromHtml(settings.about_text, htmlSet);
    htmlSet.forEach((p) => addPrimary(p));
  }

  for (const fam of families.values()) {
    for (const extra of companionPaths(fam.primary)) {
      if (fs.existsSync(webPathToAbs(extra))) addCompanion(fam.primary, extra);
    }
  }

  return [...families.values()];
}

async function renameWebFile(oldWeb, newWeb, ctx) {
  if (!oldWeb || !newWeb) return oldWeb;
  if (ctx.mapping.has(oldWeb)) return ctx.mapping.get(oldWeb);
  if (oldWeb === newWeb) {
    ctx.mapping.set(oldWeb, newWeb);
    return newWeb;
  }

  const oldAbs = webPathToAbs(oldWeb);
  if (!fs.existsSync(oldAbs)) {
    ctx.missing++;
    ctx.warnings.push(oldWeb);
    ctx.mapping.set(oldWeb, oldWeb);
    return oldWeb;
  }

  const destAbs = webPathToAbs(newWeb);
  if (fs.existsSync(destAbs) && path.resolve(destAbs) !== path.resolve(oldAbs)) {
    ctx.mapping.set(oldWeb, newWeb);
    return newWeb;
  }

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  await retryFsOp(() => { fs.renameSync(oldAbs, destAbs); });
  ctx.renamed++;
  ctx.mapping.set(oldWeb, newWeb);
  return newWeb;
}

async function copyWebFile(oldWeb, newWeb, ctx) {
  if (!oldWeb || !newWeb) return oldWeb;
  if (oldWeb === newWeb) return newWeb;
  const destAbs = webPathToAbs(newWeb);
  if (fs.existsSync(destAbs)) return newWeb;
  const sourceWeb = ctx.mapping.get(oldWeb) || oldWeb;
  const oldAbs = webPathToAbs(sourceWeb);
  if (!fs.existsSync(oldAbs)) {
    ctx.missing++;
    ctx.warnings.push(oldWeb);
    return oldWeb;
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  await retryFsOp(() => { fs.copyFileSync(oldAbs, destAbs); });
  ctx.renamed++;
  return newWeb;
}

function isNamedImgPrimary(webPath) {
  const n = normalizeMediaPath(webPath);
  if (!n) return false;
  const parsed = parseNamedPrimary(webStem(n));
  return !!(parsed && parsed.kind === 'img' && !companionRole(n));
}

function betterStillSource(webPath) {
  const n = normalizeMediaPath(webPath);
  if (!n) return webPath;
  const named = parseNamedCompanion(webStem(n));
  if (!named) return n;
  const dir = webDirname(n);
  const base = `${dir}/${named.slug}-${named.kind}-${named.id}`;
  const poster = `${base}-poster.webp`;
  const full = `${base}.webp`;
  if (named.role === 'poster-thumb' || named.role === 'thumb') {
    if (fs.existsSync(webPathToAbs(poster))) return poster;
    if (fs.existsSync(webPathToAbs(full))) return full;
  }
  return n;
}

async function rehomeCardImages(projects, ctx) {
  for (const project of projects || []) {
    if (typeof project.image !== 'string' || skipRename(project.image)) continue;

    if (!isNamedImgPrimary(project.image)) {
      const source = betterStillSource(project.image);
      if (!fs.existsSync(webPathToAbs(source))) continue;
      const stem = allocateMediaStem(path.dirname(webPathToAbs(source)), project.title || 'Untitled', 'img');
      const dir = webDirname(source);
      const imageDest = `${dir}/${stem}.webp`;
      const thumbDest = `${dir}/${stem}-thumb.webp`;
      project.image = await copyWebFile(source, imageDest, ctx);

      let thumbSrc = null;
      if (typeof project.thumbnail === 'string' && fs.existsSync(webPathToAbs(project.thumbnail))) {
        thumbSrc = project.thumbnail;
      } else {
        const srcNamed = parseNamedCompanion(webStem(source));
        if (srcNamed) {
          const sibling = `${webDirname(source)}/${srcNamed.slug}-${srcNamed.kind}-${srcNamed.id}-poster-thumb.webp`;
          if (fs.existsSync(webPathToAbs(sibling))) thumbSrc = sibling;
        }
      }
      project.thumbnail = thumbSrc
        ? await copyWebFile(thumbSrc, thumbDest, ctx)
        : project.image;
      continue;
    }

    if (typeof project.thumbnail === 'string' && !skipRename(project.thumbnail)) {
      const dest = `${webDirname(project.image)}/${webStem(project.image)}-thumb.webp`;
      if (project.thumbnail === dest) continue;
      if (fs.existsSync(webPathToAbs(dest))) {
        project.thumbnail = dest;
      } else if (fs.existsSync(webPathToAbs(project.thumbnail))) {
        project.thumbnail = await copyWebFile(project.thumbnail, dest, ctx);
      }
    }
  }
}

async function renameReferencedMedia(projects, settings) {
  const ctx = {
    renamed: 0,
    skipped: 0,
    missing: 0,
    warnings: [],
    mapping: new Map()
  };

  const families = collectRenameFamilies(projects, settings);
  const kindRank = { img: 0, vid: 1, gfx: 2 };
  families.sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9));
  const familyByPrimary = new Map(families.map((f) => [f.primary, f]));
  console.log(`[rename] ${families.length} media families`);

  for (let fi = 0; fi < families.length; fi++) {
    const fam = families[fi];
    const owner = (projects || []).find((p) => {
      const set = new Set();
      collectPathsFromProject(p, set);
      return set.has(fam.primary) || fam.companions.some((c) => set.has(c.path));
    });
    const title = owner && owner.title
      ? owner.title
      : webBasename(webDirname(fam.primary).replace(/\/models$/, ''));

    const canonical = parseNamedPrimary(webStem(fam.primary));
    const already = !!(canonical && canonical.kind === fam.kind);
    const primaryDir = webDirname(fam.primary);
    const destDirAbs = path.dirname(webPathToAbs(fam.primary));

    let stem;
    let newPrimary;
    if (already) {
      stem = webStem(fam.primary);
      newPrimary = fam.primary;
    } else {
      stem = allocateMediaStem(destDirAbs, title, fam.kind);
      newPrimary = `${primaryDir}/${stem}${webExt(fam.primary)}`;
    }

    if (already) {
      ctx.skipped++;
      ctx.mapping.set(fam.primary, fam.primary);
    } else {
      await renameWebFile(fam.primary, newPrimary, ctx);
    }

    const finalPrimary = ctx.mapping.get(fam.primary) || fam.primary;
    const finalStem = webStem(finalPrimary);
    fam.finalPrimary = finalPrimary;
    fam.destByRole = {};

    for (const companion of fam.companions) {
      const suffix = companionSuffix(companion.role);
      if (!suffix) continue;
      const dest = `${webDirname(companion.path)}/${finalStem}${suffix}`;
      const shared = familyOwningPath(companion.path, families, fam) !== fam;

      if (companion.path === dest) {
        fam.destByRole[companion.role] = dest;
        if (!shared) ctx.mapping.set(companion.path, dest);
        continue;
      }

      if (shared) {
        fam.destByRole[companion.role] = await copyWebFile(companion.path, dest, ctx);
        continue;
      }

      fam.destByRole[companion.role] = await renameWebFile(companion.path, dest, ctx);
    }

    if ((fi + 1) % 50 === 0 || fi + 1 === families.length) {
      console.log(`[rename] ${fi + 1}/${families.length} (renamed ${ctx.renamed}, skipped ${ctx.skipped}, missing ${ctx.missing})`);
    }
  }

  const rewriteProject = (project) => {
    if (typeof project.image === 'string') project.image = applyPathMapping(project.image, ctx.mapping);
    if (typeof project.thumbnail === 'string') project.thumbnail = applyPathMapping(project.thumbnail, ctx.mapping);
    if (typeof project.video === 'string') project.video = applyPathMapping(project.video, ctx.mapping);
    if (typeof project.description === 'string') project.description = applyPathMapping(project.description, ctx.mapping);
    if (typeof project.longDescription === 'string') project.longDescription = applyPathMapping(project.longDescription, ctx.mapping);
    if (typeof project.specs === 'string') project.specs = applyPathMapping(project.specs, ctx.mapping);
    if (Array.isArray(project.gallery)) {
      project.gallery = project.gallery.map((item) => {
        if (typeof item === 'string') return applyPathMapping(item, ctx.mapping);
        if (!item || typeof item !== 'object') return item;
        const updated = { ...item };
        const fam = typeof item.url === 'string' ? familyByPrimary.get(normalizeMediaPath(item.url)) : null;
        if (typeof item.url === 'string') updated.url = applyPathMapping(item.url, ctx.mapping);
        if (typeof item.poster === 'string') {
          const role = fam ? galleryCompanionRole(fam.kind, 'poster', item.poster) : null;
          updated.poster = (fam && fam.destByRole && (fam.destByRole[role] || fam.destByRole.poster))
            || applyPathMapping(item.poster, ctx.mapping);
        }
        if (typeof item.thumbnail === 'string') {
          const role = fam ? galleryCompanionRole(fam.kind, 'thumbnail', item.thumbnail) : null;
          updated.thumbnail = (fam && fam.destByRole && (fam.destByRole[role] || fam.destByRole['poster-thumb'] || fam.destByRole.thumb))
            || applyPathMapping(item.thumbnail, ctx.mapping);
        }
        return updated;
      });
    }
    if (Array.isArray(project.files)) {
      project.files = project.files.map((file) => {
        if (typeof file === 'string') return file;
        if (!file || typeof file !== 'object') return file;
        const updated = { ...file };
        if (typeof file.image === 'string') updated.image = applyPathMapping(file.image, ctx.mapping);
        if (typeof file.thumbnail === 'string') updated.thumbnail = applyPathMapping(file.thumbnail, ctx.mapping);
        return updated;
      });
    }
  };

  (projects || []).forEach(rewriteProject);
  await rehomeCardImages(projects, ctx);

  let settingsChanged = false;
  if (settings) {
    const beforeHeadshot = settings.about_headshot;
    const beforeAbout = settings.about_text;
    if (typeof settings.about_headshot === 'string') {
      settings.about_headshot = applyPathMapping(settings.about_headshot, ctx.mapping);
    }
    if (typeof settings.about_text === 'string') {
      settings.about_text = applyPathMapping(settings.about_text, ctx.mapping);
    }
    settingsChanged = settings.about_headshot !== beforeHeadshot || settings.about_text !== beforeAbout;
  }

  writeJSON('projects.json', projects);
  if (settings && settingsChanged) writeJSON('settings.json', settings);

  return {
    renamed: ctx.renamed,
    skippedAlreadyNamed: ctx.skipped,
    missing: ctx.missing,
    warnings: ctx.warnings
  };
}

async function trashDroppedAssets(oldEntity, newEntity) {
  const oldPaths = collectEntityPaths(oldEntity);
  const newPaths = collectEntityPaths(newEntity);
  const dropped = [...oldPaths].filter((p) => !newPaths.has(p));
  if (dropped.length === 0) return { moved: 0, files: [], warnings: [] };

  const used = collectReferencedPaths();
  const toTrash = new Set(dropped.filter((p) => !used.has(p)));
  for (const p of [...toTrash]) {
    for (const companion of companionPaths(p)) {
      if (!used.has(companion)) toTrash.add(companion);
    }
  }

  return trashPaths([...toTrash]);
}

module.exports = {
  processUpload,
  processFileUpload,
  processModelUpload,
  fixFileStructure,
  relocateProject,
  trashUnusedMedia,
  trashDroppedAssets,
  renameReferencedMedia,
  allocateMediaStem,
  mediaStem,
  titleSlug,
  CATEGORY_FOLDER_MAP,
  sanitize,
  scheduleUnlink
};
