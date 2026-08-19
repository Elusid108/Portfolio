const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { CATEGORY_FOLDER_MAP, sanitize, scheduleUnlink } = require('./media');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const MEDIA_DIR = path.join(PORTFOLIO_ROOT, 'media');
const TEMP_DIR = path.join(os.tmpdir(), 'portfolio-cms-uploads');

function probeDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve(0);
      resolve(data?.format?.duration || 0);
    });
  });
}

function transcodeToH264(srcPath, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .noAudio()
      .videoCodec('libx264')
      .outputOptions(['-crf 23', '-preset medium', '-movflags +faststart', '-pix_fmt yuv420p'])
      .videoFilters("fps=30,scale='min(1920,iw)':-2")
      .on('progress', (p) => {
        if (onProgress) onProgress(Math.min(99, Math.round(p.percent || 0)), p.timemark || '');
      })
      .on('end', resolve)
      .on('error', reject)
      .save(destPath);
  });
}

function extractFrame(srcPath, atSeconds, destDir, filename) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .on('end', resolve)
      .on('error', reject)
      .screenshots({ timestamps: [atSeconds], filename, folder: destDir });
  });
}

async function processVideoUpload(file, category, projectName, onProgress) {
  const originalName = sanitize(file.originalname);
  const stem = path.parse(originalName).name;
  const mp4Name = `${stem}.mp4`;
  const posterName = `${stem}-poster.webp`;
  const posterThumbName = `${stem}-poster-thumb.webp`;

  const folder = CATEGORY_FOLDER_MAP[category] || category;
  const safeProject = sanitize(projectName);
  const destDir = path.join(MEDIA_DIR, folder, safeProject);
  const videoWebPath = `media/${folder}/${safeProject}/${mp4Name}`;
  const posterWebPath = `media/${folder}/${safeProject}/${posterName}`;
  const posterThumbWebPath = `media/${folder}/${safeProject}/${posterThumbName}`;

  fs.mkdirSync(destDir, { recursive: true });

  const srcPath = file.path;
  const destPath = path.join(destDir, mp4Name);

  try {
    await transcodeToH264(srcPath, destPath, onProgress);
    if (onProgress) onProgress(99, '');
  } catch (err) {
    console.error('ffmpeg transcode error:', err.message);
  }

  let posterGenerated = false;
  try {
    const duration = await probeDuration(srcPath);
    const posterAt = duration > 1 ? Math.min(duration * 0.1, 3) : 0;
    const tempJpgName = `${stem}-poster-tmp.jpg`;
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const extractStartedAt = Date.now();
    await extractFrame(srcPath, posterAt, TEMP_DIR, tempJpgName);
    // #region agent log
    fetch('http://127.0.0.1:7539/ingest/47d65063-da39-4589-8187-0bb2721ced5a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'3ea769'},body:JSON.stringify({sessionId:'3ea769',runId:'pre-fix',hypothesisId:'B',location:'CMS/lib/video.js:extractFrame',message:'ffmpeg frame extracted',data:{tempJpgName,extractMs:Date.now()-extractStartedAt,srcPath},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const tempJpgPath = path.join(TEMP_DIR, tempJpgName);
    if (fs.existsSync(tempJpgPath)) {
      const statBefore = fs.statSync(tempJpgPath);
      // #region agent log
      fetch('http://127.0.0.1:7539/ingest/47d65063-da39-4589-8187-0bb2721ced5a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'3ea769'},body:JSON.stringify({sessionId:'3ea769',runId:'pre-fix',hypothesisId:'A,B',location:'CMS/lib/video.js:beforeSharp',message:'about to run sharp on poster tmp',data:{tempJpgPath,size:statBefore.size,inOnedrive:/onedrive/i.test(tempJpgPath)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      const sharp1StartedAt = Date.now();
      await sharp(tempJpgPath).webp({ quality: 85 }).toFile(path.join(destDir, posterName));
      // #region agent log
      fetch('http://127.0.0.1:7539/ingest/47d65063-da39-4589-8187-0bb2721ced5a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'3ea769'},body:JSON.stringify({sessionId:'3ea769',runId:'pre-fix',hypothesisId:'A',location:'CMS/lib/video.js:afterSharp1',message:'first sharp toFile done',data:{tempJpgPath,sharp1Ms:Date.now()-sharp1StartedAt,cache:sharp.cache()},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      const sharp2StartedAt = Date.now();
      await sharp(tempJpgPath)
        .resize(800, null, { withoutEnlargement: true })
        .webp({ quality: 75 })
        .toFile(path.join(destDir, posterThumbName));
      posterGenerated = true;
      // #region agent log
      fetch('http://127.0.0.1:7539/ingest/47d65063-da39-4589-8187-0bb2721ced5a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'3ea769'},body:JSON.stringify({sessionId:'3ea769',runId:'pre-fix',hypothesisId:'A,D',location:'CMS/lib/video.js:beforeUnlink',message:'second sharp done, scheduling unlink',data:{tempJpgPath,sharp2Ms:Date.now()-sharp2StartedAt,exists:fs.existsSync(tempJpgPath)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      scheduleUnlink(tempJpgPath);
    }
  } catch (err) {
    console.error('Poster extraction error:', err.message);
  }

  scheduleUnlink(srcPath);

  return { path: videoWebPath, poster: posterWebPath, posterThumbnail: posterGenerated ? posterThumbWebPath : '' };
}

module.exports = { processVideoUpload };
