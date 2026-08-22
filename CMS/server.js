const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const data = require('./lib/data');
const media = require('./lib/media');
const video = require('./lib/video');
const { publish } = require('./lib/publish');

// SSE connections for video progress: jobId -> res
const sseClients = new Map();

const app = express();
const PORT = process.env.PORT || 3000;
const PORTFOLIO_ROOT = path.join(__dirname, '..');

// Use OS temp directory for multer uploads so OneDrive never locks them.
const UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'portfolio-cms-uploads');
fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });

// Sweep orphan temp files older than 1 hour on startup
(function cleanupOrphanTemps() {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of fs.readdirSync(UPLOAD_TEMP_DIR)) {
      const fullPath = path.join(UPLOAD_TEMP_DIR, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
        }
      } catch (_) { /* ignore individual file errors */ }
    }
  } catch (_) { /* directory may not exist yet on first run */ }
})();

app.use(express.json({ limit: '50mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(PORTFOLIO_ROOT, 'media')));

app.get('/preview', (req, res) => {
  const indexPath = path.join(PORTFOLIO_ROOT, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('No published site yet. Click Publish first.');
  }
});

const upload = multer({
  dest: UPLOAD_TEMP_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }
});

const uploadVideo = multer({
  dest: UPLOAD_TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }
});

// --- Projects ---

app.get('/api/projects', (req, res) => {
  try {
    res.json(data.getProjects());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    let incoming = req.body;
    const oldProject = incoming.id
      ? data.getProjects().find(p => String(p.id) === String(incoming.id)) || null
      : null;
    // Always relocate media for existing projects. relocateAsset is a no-op
    // when a file is already in the canonical path, so this is safe to run
    // on every save — it fixes stale paths from prior category/title changes.
    if (incoming.id) {
      const { project: relocated, moved, warnings } = media.relocateProject(incoming);
      incoming = relocated;
      if (warnings.length) console.warn('[relocate] missing files:', warnings);
      if (moved > 0) console.log(`[relocate] moved ${moved} file(s) for project "${incoming.title}"`);
    }
    const result = data.saveProject(incoming);
    try {
      const trashResult = await media.trashDroppedAssets(oldProject, result.project);
      if (trashResult.moved > 0) {
        console.log(`[trash] moved ${trashResult.moved} unused file(s) after save of "${result.project?.title}"`);
      }
      if (trashResult.warnings.length) console.warn('[trash] after save:', trashResult.warnings);
    } catch (err) {
      console.error('[trash] after save:', err.message);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const oldProject = data.getProjects().find(p => String(p.id) === String(req.params.id)) || null;
    const result = data.deleteProject(req.params.id);
    try {
      const trashResult = await media.trashDroppedAssets(oldProject, null);
      if (trashResult.moved > 0) {
        console.log(`[trash] moved ${trashResult.moved} unused file(s) after delete`);
      }
      if (trashResult.warnings.length) console.warn('[trash] after delete:', trashResult.warnings);
    } catch (err) {
      console.error('[trash] after delete:', err.message);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/reorder', (req, res) => {
  try {
    res.json(data.reorderProjects(req.body.items));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Settings ---

app.get('/api/settings', (req, res) => {
  try {
    res.json(data.getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const oldSettings = data.getSettings();
    const result = data.saveSettings(req.body);
    try {
      const trashResult = await media.trashDroppedAssets(oldSettings, req.body);
      if (trashResult.moved > 0) {
        console.log(`[trash] moved ${trashResult.moved} unused file(s) after settings save`);
      }
      if (trashResult.warnings.length) console.warn('[trash] after settings save:', trashResult.warnings);
    } catch (err) {
      console.error('[trash] after settings save:', err.message);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Media ---

app.post('/api/media/upload', upload.single('file'), async (req, res) => {
  try {
    const { category, project } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!category || !project) return res.status(400).json({ error: 'Category and project name required' });

    const result = await media.processUpload(req.file, category, project);
    res.json({ success: true, path: result.path, thumbnail: result.thumbnail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/upload-file', upload.single('file'), async (req, res) => {
  try {
    const { category, project } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!category || !project) return res.status(400).json({ error: 'Category and project name required' });
    const relativePath = await media.processFileUpload(req.file, category, project);
    res.json({ success: true, path: relativePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint — client subscribes before starting a video upload
app.get('/api/media/video-progress/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // Tell the client the channel is open so it can safely start the POST
  res.write(`data: ${JSON.stringify({ ready: true })}\n\n`);
  sseClients.set(req.params.jobId, res);
  req.on('close', () => sseClients.delete(req.params.jobId));
});

app.post('/api/media/upload-video', uploadVideo.single('file'), async (req, res) => {
  try {
    const { category, project, jobId } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!category || !project) return res.status(400).json({ error: 'Category and project name required' });

    const sseRes = jobId ? sseClients.get(jobId) : null;
    const sendProgress = (percent, timemark) => {
      if (sseRes && !sseRes.writableEnded) {
        sseRes.write(`data: ${JSON.stringify({ percent, timemark })}\n\n`);
      }
    };

    const result = await video.processVideoUpload(req.file, category, project, sseRes ? sendProgress : null);

    if (sseRes && !sseRes.writableEnded) {
      sseRes.write(`data: ${JSON.stringify({ percent: 100, done: true })}\n\n`);
      sseRes.end();
      sseClients.delete(jobId);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/fix-structure', async (req, res) => {
  try {
    const result = media.fixFileStructure();
    const publishResult = publish();
    res.json({ success: true, ...result, published: publishResult.success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/cleanup', async (req, res) => {
  try {
    const result = await media.trashUnusedMedia();
    if (result.moved > 0) {
      console.log(`[trash] cleanup moved ${result.moved} unused file(s)`);
    }
    if (result.warnings.length) console.warn('[trash] cleanup:', result.warnings);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Publish ---

app.post('/api/publish', (req, res) => {
  try {
    const result = publish();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate thumbnails for existing projects that lack them
app.post('/api/media/generate-thumbnails', async (req, res) => {
  try {
    const sharp = require('sharp');
    const projects = data.getProjects();
    let generated = 0;
    let skipped = 0;

    for (const project of projects) {
      // Project hero image thumbnail
      if (project.image && project.image.startsWith('media/')) {
        const imagePath = path.join(PORTFOLIO_ROOT, ...project.image.split('/'));
        if (fs.existsSync(imagePath)) {
          const parsed = path.parse(imagePath);
          const thumbPath = path.join(parsed.dir, `${parsed.name}-thumb.webp`);
          const thumbWebPath = project.image.replace(parsed.base, `${parsed.name}-thumb.webp`);

          if (!project.thumbnail || !fs.existsSync(path.join(PORTFOLIO_ROOT, ...project.thumbnail.split('/')))) {
            try {
              await sharp(imagePath)
                .rotate()
                .resize(800, null, { withoutEnlargement: true })
                .webp({ quality: 75 })
                .toFile(thumbPath);
              project.thumbnail = thumbWebPath;
              generated++;
            } catch (err) {
              console.error(`Thumbnail failed for ${project.title} hero:`, err.message);
              skipped++;
            }
          } else { skipped++; }
        } else { skipped++; }
      } else { skipped++; }

      // Gallery items
      if (Array.isArray(project.gallery)) {
        for (let i = 0; i < project.gallery.length; i++) {
          const item = project.gallery[i];
          const url = typeof item === 'string' ? item : (item?.url || '');
          const isVideo = /\.(mp4|webm|mov|avi)$/i.test(url);
          const existingThumb = typeof item === 'object' ? (item?.thumbnail || '') : '';

          if (existingThumb && fs.existsSync(path.join(PORTFOLIO_ROOT, ...existingThumb.split('/')))) {
            skipped++;
            continue;
          }

          // For videos: generate thumbnail from poster
          if (isVideo) {
            const poster = typeof item === 'object' ? (item?.poster || '') : '';
            if (!poster || !poster.startsWith('media/')) { skipped++; continue; }
            const posterPath = path.join(PORTFOLIO_ROOT, ...poster.split('/'));
            if (!fs.existsSync(posterPath)) { skipped++; continue; }

            const parsed = path.parse(posterPath);
            const thumbName = `${parsed.name}-thumb.webp`;
            const thumbPath = path.join(parsed.dir, thumbName);
            const thumbWebPath = poster.replace(parsed.base, thumbName);

            try {
              await sharp(posterPath)
                .rotate()
                .resize(800, null, { withoutEnlargement: true })
                .webp({ quality: 75 })
                .toFile(thumbPath);
              if (typeof item === 'string') {
                project.gallery[i] = { url: item, thumbnail: thumbWebPath };
              } else {
                item.thumbnail = thumbWebPath;
              }
              generated++;
            } catch (err) {
              console.error(`Gallery thumb failed for ${project.title}[${i}]:`, err.message);
              skipped++;
            }
            continue;
          }

          // For images: generate thumbnail from the image itself
          if (!url.startsWith('media/')) { skipped++; continue; }
          if (/youtube\.com|youtu\.be/i.test(url)) { skipped++; continue; }
          const imgPath = path.join(PORTFOLIO_ROOT, ...url.split('/'));
          if (!fs.existsSync(imgPath)) { skipped++; continue; }

          const parsed = path.parse(imgPath);
          if (parsed.name.endsWith('-thumb')) { skipped++; continue; }
          const thumbName = `${parsed.name}-thumb.webp`;
          const thumbPath = path.join(parsed.dir, thumbName);
          const thumbWebPath = url.replace(parsed.base, thumbName);

          try {
            await sharp(imgPath)
              .rotate()
              .resize(800, null, { withoutEnlargement: true })
              .webp({ quality: 75 })
              .toFile(thumbPath);
            if (typeof item === 'string') {
              project.gallery[i] = { url: item, thumbnail: thumbWebPath };
            } else {
              item.thumbnail = thumbWebPath;
            }
            generated++;
          } catch (err) {
            console.error(`Gallery thumb failed for ${project.title}[${i}]:`, err.message);
            skipped++;
          }
        }
      }
    }

    const projectsPath = path.join(__dirname, 'data', 'projects.json');
    fs.writeFileSync(projectsPath, JSON.stringify(projects, null, 2), 'utf-8');

    res.json({ success: true, generated, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n  Portfolio CMS running at http://localhost:${PORT}`);
  console.log(`  Preview:  http://localhost:${PORT}/preview\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ERROR: Port ${PORT} is already in use by another server.`);
    console.error(`  Close all CMS windows (or run launch.bat again) and retry.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
