const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const data = require('./lib/data');
const media = require('./lib/media');
const { publish } = require('./lib/publish');

const app = express();
const PORT = process.env.PORT || 3000;
const PORTFOLIO_ROOT = path.join(__dirname, '..');

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
  dest: path.join(__dirname, '.uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// --- Projects ---

app.get('/api/projects', (req, res) => {
  try {
    res.json(data.getProjects());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    res.json(data.saveProject(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    res.json(data.deleteProject(req.params.id));
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

app.post('/api/settings', (req, res) => {
  try {
    res.json(data.saveSettings(req.body));
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

    const relativePath = await media.processUpload(req.file, category, project);
    res.json({ success: true, path: relativePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/convert-all', async (req, res) => {
  try {
    const result = await media.convertAllMedia();
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
