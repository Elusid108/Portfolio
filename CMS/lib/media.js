const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getProjects, getSettings, saveProject } = require('./data');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const MEDIA_DIR = path.join(PORTFOLIO_ROOT, 'media');
const ARCHIVE_DIR = path.join(PORTFOLIO_ROOT, 'archive');
const DATA_DIR = path.join(__dirname, '..', 'data');

const CATEGORY_FOLDER_MAP = {
  'Lighting': 'Lighting',
  'Art': 'Art',
  'Circuits': 'Electronics',
  'Apps': 'Apps',
  'Solutions': 'Fabrication',
  'Integration': 'Integration'
};

const NON_WEBP_PATTERN = /\.(jpg|jpeg|png|gif|bmp|tiff|tif|heic|heif)$/i;

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_');
}

async function processUpload(file, category, projectName) {
  const originalName = sanitize(file.originalname);
  const stem = path.parse(originalName).name;
  const webpName = `${stem}.webp`;
  let destDir, webPath;

  if (category === '_root' || !projectName) {
    destDir = MEDIA_DIR;
    webPath = `media/${webpName}`;
  } else {
    const folder = CATEGORY_FOLDER_MAP[category] || category;
    const safeProject = sanitize(projectName);
    destDir = path.join(MEDIA_DIR, folder, safeProject);
    webPath = `media/${folder}/${safeProject}/${webpName}`;
  }

  fs.mkdirSync(destDir, { recursive: true });

  const srcPath = file.path || null;
  const srcBuffer = file.buffer || null;
  const destPath = path.join(destDir, webpName);

  try {
    await (srcPath ? sharp(srcPath) : sharp(srcBuffer))
      .rotate()
      .webp({ quality: 85 })
      .toFile(destPath);
  } catch (err) {
    console.error('Sharp processing error:', err.message);
  }

  if (srcPath) {
    try { fs.unlinkSync(srcPath); } catch (_) {}
  }

  return webPath;
}

function walkImages(dir, skipDirs = []) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (skipDirs.includes(entry)) continue;

    if (fs.statSync(full).isDirectory()) {
      results = results.concat(walkImages(full, skipDirs));
    } else if (NON_WEBP_PATTERN.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

async function convertAllMedia() {
  let converted = 0;
  let archived = 0;
  let refixed = 0;
  const pathMap = {};

  // Pass 1: re-convert any archived originals to fix images that were
  // converted before EXIF orientation handling was added. Regenerates the
  // WebP at the mirrored media/ path (overwriting), with .rotate() applied.
  const archivedPaths = walkImages(ARCHIVE_DIR);
  for (const archivedPath of archivedPaths) {
    const relFromArchive = path.relative(ARCHIVE_DIR, archivedPath);
    const dir = path.dirname(path.join(MEDIA_DIR, relFromArchive));
    const stem = path.parse(archivedPath).name;
    const webpDest = path.join(dir, `${stem}.webp`);

    if (!fs.existsSync(webpDest)) continue;

    try {
      fs.mkdirSync(dir, { recursive: true });
      await sharp(archivedPath).rotate().webp({ quality: 85 }).toFile(webpDest);
      refixed++;
    } catch (err) {
      console.error(`Failed to re-fix ${archivedPath}:`, err.message);
    }
  }

  // Pass 2: convert any non-WebP originals still sitting in media/.
  const imagePaths = walkImages(MEDIA_DIR, ['.optimized']);

  for (const imgPath of imagePaths) {
    const dir = path.dirname(imgPath);
    const stem = path.parse(imgPath).name;
    const webpDest = path.join(dir, `${stem}.webp`);

    try {
      await sharp(imgPath).rotate().webp({ quality: 85 }).toFile(webpDest);
      converted++;

      const relFromMedia = path.relative(MEDIA_DIR, imgPath);
      const archiveDest = path.join(ARCHIVE_DIR, relFromMedia);
      fs.mkdirSync(path.dirname(archiveDest), { recursive: true });
      fs.renameSync(imgPath, archiveDest);
      archived++;

      const oldWebPath = 'media/' + relFromMedia.replace(/\\/g, '/');
      const newWebPath = 'media/' + path.relative(MEDIA_DIR, webpDest).replace(/\\/g, '/');
      pathMap[oldWebPath] = newWebPath;
    } catch (err) {
      console.error(`Failed to convert ${imgPath}:`, err.message);
    }
  }

  if (Object.keys(pathMap).length > 0) {
    updateDataReferences(pathMap);
  }

  const optimizedDir = path.join(MEDIA_DIR, '.optimized');
  if (fs.existsSync(optimizedDir)) {
    fs.rmSync(optimizedDir, { recursive: true, force: true });
  }

  return { converted, archived, refixed };
}

function updateDataReferences(pathMap) {
  const projectsPath = path.join(DATA_DIR, 'projects.json');
  const settingsPath = path.join(DATA_DIR, 'settings.json');

  if (fs.existsSync(projectsPath)) {
    let text = fs.readFileSync(projectsPath, 'utf-8');
    for (const [oldPath, newPath] of Object.entries(pathMap)) {
      text = text.split(oldPath).join(newPath);
    }
    fs.writeFileSync(projectsPath, text, 'utf-8');
  }

  if (fs.existsSync(settingsPath)) {
    let text = fs.readFileSync(settingsPath, 'utf-8');
    for (const [oldPath, newPath] of Object.entries(pathMap)) {
      text = text.split(oldPath).join(newPath);
    }
    fs.writeFileSync(settingsPath, text, 'utf-8');
  }
}

module.exports = { processUpload, convertAllMedia, CATEGORY_FOLDER_MAP };
