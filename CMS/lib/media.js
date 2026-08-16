const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const convertHeic = require('heic-convert');
const { getProjects } = require('./data');

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
  const stem = path.parse(originalName).name;
  const webpName = `${stem}.webp`;
  const thumbName = `${stem}-thumb.webp`;
  let destDir, webPath, thumbWebPath;

  if (category === '_root' || !projectName) {
    destDir = MEDIA_DIR;
    webPath = `media/${webpName}`;
    thumbWebPath = `media/${thumbName}`;
  } else {
    const folder = CATEGORY_FOLDER_MAP[category] || category;
    const safeProject = sanitize(projectName);
    destDir = path.join(MEDIA_DIR, folder, safeProject);
    webPath = `media/${folder}/${safeProject}/${webpName}`;
    thumbWebPath = `media/${folder}/${safeProject}/${thumbName}`;
  }

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

function removeEmptyDirs(dir, isRoot = false) {
  if (!fs.existsSync(dir)) return 0;
  let removedCount = 0;

  for (const entry of fs.readdirSync(dir)) {
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
      project.files = project.files.map(file => {
        if (file && typeof file.url === 'string') {
          return { ...file, url: relocateAsset(file.url, targetWebDir, ctx) };
        }
        return file;
      });
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
    updated.files = updated.files.map(file => {
      if (file && typeof file.url === 'string') return { ...file, url: relocateAsset(file.url, targetWebDir, ctx) };
      return file;
    });
  }

  if (ctx.moved > 0) removeEmptyDirs(MEDIA_DIR, true);

  return { project: updated, moved: ctx.moved, copied: ctx.copied, missing: ctx.missing, warnings: ctx.warnings };
}

module.exports = { processUpload, processFileUpload, fixFileStructure, relocateProject, CATEGORY_FOLDER_MAP, sanitize, scheduleUnlink };
