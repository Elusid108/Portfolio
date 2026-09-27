#!/usr/bin/env node
// Re-encode published videos down to the web delivery cap (short side <= 720 px,
// CRF 26, faststart). Files are replaced in place under the same name so no
// project data changes. Videos already at or below the cap are skipped.
//
//   npm run reencode-videos                 # every media/**/*.mp4
//   npm run reencode-videos -- <file> ...   # only these files
//   npm run reencode-videos -- --dry        # report what would change

const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { transcodeToH264, MAX_SHORT_SIDE } = require('../lib/video');

const PORTFOLIO_ROOT = path.join(__dirname, '..', '..');
const MEDIA_DIR = path.join(PORTFOLIO_ROOT, 'media');
const TEMP_DIR = path.join(os.tmpdir(), 'portfolio-cms-reencode');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue; // _trash and other private folders
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.mp4$/i.test(entry.name)) out.push(abs);
  }
  return out;
}

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);
      const video = (data.streams || []).find((s) => s.codec_type === 'video');
      const hasAudio = (data.streams || []).some((s) => s.codec_type === 'audio');
      resolve({ width: video?.width || 0, height: video?.height || 0, hasAudio });
    });
  });
}

// OneDrive can briefly lock files it is syncing.
async function replaceWithRetry(src, dest) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

const mb = (n) => (n / 1e6).toFixed(1);

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const named = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
  const files = named.length ? named : walk(MEDIA_DIR);
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  let before = 0;
  let after = 0;
  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, file] of files.entries()) {
    const rel = path.relative(PORTFOLIO_ROOT, file);
    const tag = `[${i + 1}/${files.length}]`;
    let info;
    try {
      info = await probe(file);
    } catch (err) {
      console.log(`${tag} FAIL probe ${rel}: ${err.message}`);
      failed++;
      continue;
    }
    const shortSide = Math.min(info.width, info.height);
    if (shortSide && shortSide <= MAX_SHORT_SIDE) {
      skipped++;
      continue;
    }
    const size = fs.statSync(file).size;
    if (dry) {
      console.log(`${tag} would re-encode ${rel} (${info.width}x${info.height}, ${mb(size)} MB)`);
      continue;
    }
    const tmp = path.join(TEMP_DIR, `reencode-${process.pid}-${i}.mp4`);
    try {
      await transcodeToH264(file, tmp, null, info.hasAudio);
      const newSize = fs.statSync(tmp).size;
      if (!newSize) throw new Error('empty output');
      await replaceWithRetry(tmp, file);
      before += size;
      after += newSize;
      done++;
      console.log(`${tag} ${rel}: ${info.width}x${info.height} ${mb(size)} MB -> ${mb(newSize)} MB`);
    } catch (err) {
      failed++;
      console.log(`${tag} FAIL ${rel}: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  }

  console.log(`\nRe-encoded ${done}, skipped ${skipped} (already <= ${MAX_SHORT_SIDE}p), failed ${failed}.`);
  if (done) console.log(`Size: ${mb(before)} MB -> ${mb(after)} MB (saved ${mb(before - after)} MB).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
