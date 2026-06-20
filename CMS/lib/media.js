const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const MEDIA_DIR = path.join(PORTFOLIO_ROOT, 'media');
const OPTIMIZED_DIR = path.join(MEDIA_DIR, '.optimized');

const CATEGORY_FOLDER_MAP = {
  'Lighting': 'Lighting',
  'Art': 'Art',
  'Circuits': 'Electronics',
  'Apps': 'Apps',
  'Solutions': 'Fabrication',
  'Integration': 'Integration'
};

const THUMB_WIDTH = 400;
const FULL_WIDTH = 1200;

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_');
}

async function processUpload(file, category, projectName) {
  const filename = sanitize(file.originalname);
  let destDir, optDir, webPath;

  if (category === '_root' || !projectName) {
    destDir = MEDIA_DIR;
    optDir = OPTIMIZED_DIR;
    webPath = `/media/${filename}`;
  } else {
    const folder = CATEGORY_FOLDER_MAP[category] || category;
    const safeProject = sanitize(projectName);
    destDir = path.join(MEDIA_DIR, folder, safeProject);
    optDir = path.join(OPTIMIZED_DIR, folder, safeProject);
    webPath = `/media/${folder}/${safeProject}/${filename}`;
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(optDir, { recursive: true });

  const destPath = path.join(destDir, filename);

  if (file.path) {
    fs.copyFileSync(file.path, destPath);
    fs.unlinkSync(file.path);
  } else if (file.buffer) {
    fs.writeFileSync(destPath, file.buffer);
  }

  const stem = path.parse(filename).name;

  try {
    const meta = await sharp(destPath).metadata();

    if (meta.width > THUMB_WIDTH) {
      await sharp(destPath)
        .resize(THUMB_WIDTH)
        .webp({ quality: 80 })
        .toFile(path.join(optDir, `${stem}-thumb.webp`));
    }

    if (meta.width > FULL_WIDTH) {
      await sharp(destPath)
        .resize(FULL_WIDTH)
        .webp({ quality: 85 })
        .toFile(path.join(optDir, `${stem}-full.webp`));
    }
  } catch (err) {
    console.error('Sharp processing error:', err.message);
  }

  return webPath;
}

async function optimizeExistingMedia() {
  const categories = fs.readdirSync(MEDIA_DIR).filter(f => {
    const full = path.join(MEDIA_DIR, f);
    return fs.statSync(full).isDirectory() && f !== '.optimized';
  });

  let processed = 0;

  for (const cat of categories) {
    const catPath = path.join(MEDIA_DIR, cat);
    const entries = fs.readdirSync(catPath);

    for (const entry of entries) {
      const entryPath = path.join(catPath, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;

      const optDir = path.join(OPTIMIZED_DIR, cat, entry);
      fs.mkdirSync(optDir, { recursive: true });

      const images = fs.readdirSync(entryPath).filter(f =>
        /\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(f)
      );

      for (const img of images) {
        const imgPath = path.join(entryPath, img);
        const stem = path.parse(img).name;
        const thumbPath = path.join(optDir, `${stem}-thumb.webp`);
        const fullPath = path.join(optDir, `${stem}-full.webp`);

        if (fs.existsSync(thumbPath) && fs.existsSync(fullPath)) continue;

        try {
          const meta = await sharp(imgPath).metadata();

          if (!fs.existsSync(thumbPath) && meta.width > THUMB_WIDTH) {
            await sharp(imgPath).resize(THUMB_WIDTH).webp({ quality: 80 }).toFile(thumbPath);
          }
          if (!fs.existsSync(fullPath) && meta.width > FULL_WIDTH) {
            await sharp(imgPath).resize(FULL_WIDTH).webp({ quality: 85 }).toFile(fullPath);
          }
          processed++;
        } catch (err) {
          console.error(`Failed to process ${imgPath}:`, err.message);
        }
      }
    }
  }

  const rootImages = fs.readdirSync(MEDIA_DIR).filter(f =>
    /\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(f)
  );
  fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });

  for (const img of rootImages) {
    const imgPath = path.join(MEDIA_DIR, img);
    const stem = path.parse(img).name;
    const thumbPath = path.join(OPTIMIZED_DIR, `${stem}-thumb.webp`);

    if (!fs.existsSync(thumbPath)) {
      try {
        await sharp(imgPath).resize(THUMB_WIDTH).webp({ quality: 80 }).toFile(thumbPath);
        processed++;
      } catch (err) {
        console.error(`Failed to process ${imgPath}:`, err.message);
      }
    }
  }

  return { processed };
}

module.exports = { processUpload, optimizeExistingMedia, CATEGORY_FOLDER_MAP };
