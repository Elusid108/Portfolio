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

function probeMedia(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve({ duration: 0, hasAudio: false });
      const hasAudio = (data?.streams || []).some((s) => s.codec_type === 'audio');
      resolve({ duration: data?.format?.duration || 0, hasAudio });
    });
  });
}

function transcodeToH264(srcPath, destPath, onProgress, keepAudio) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(srcPath)
      .videoCodec('libx264')
      .outputOptions(['-crf 23', '-preset medium', '-movflags +faststart', '-pix_fmt yuv420p'])
      .videoFilters("fps=30,scale='min(1920,iw)':-2");

    if (keepAudio) {
      cmd.audioCodec('aac').audioBitrate('128k').audioChannels(2).audioFrequency(44100);
    } else {
      cmd.noAudio();
    }

    cmd
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

async function processVideoUpload(file, category, projectName, onProgress, keepAudio = false) {
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

  const probe = await probeMedia(srcPath);
  const encodeAudio = Boolean(keepAudio && probe.hasAudio);

  try {
    await transcodeToH264(srcPath, destPath, onProgress, encodeAudio);
    if (onProgress) onProgress(99, '');
  } catch (err) {
    console.error('ffmpeg transcode error:', err.message);
  }

  let posterGenerated = false;
  try {
    const duration = probe.duration;
    const posterAt = duration > 1 ? Math.min(duration * 0.1, 3) : 0;
    const tempJpgName = `${stem}-poster-tmp.jpg`;
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    await extractFrame(srcPath, posterAt, TEMP_DIR, tempJpgName);

    const tempJpgPath = path.join(TEMP_DIR, tempJpgName);
    if (fs.existsSync(tempJpgPath)) {
      const jpgBuffer = fs.readFileSync(tempJpgPath);
      const posterPipeline = sharp(jpgBuffer);
      try {
        await posterPipeline.webp({ quality: 85 }).toFile(path.join(destDir, posterName));
      } finally {
        posterPipeline.destroy();
      }
      const thumbPipeline = sharp(jpgBuffer);
      try {
        await thumbPipeline
          .resize(800, null, { withoutEnlargement: true })
          .webp({ quality: 75 })
          .toFile(path.join(destDir, posterThumbName));
      } finally {
        thumbPipeline.destroy();
      }
      posterGenerated = true;
      scheduleUnlink(tempJpgPath);
    }
  } catch (err) {
    console.error('Poster extraction error:', err.message);
  }

  scheduleUnlink(srcPath);

  return {
    path: videoWebPath,
    poster: posterWebPath,
    posterThumbnail: posterGenerated ? posterThumbWebPath : '',
    hasAudio: encodeAudio
  };
}

module.exports = { processVideoUpload };
