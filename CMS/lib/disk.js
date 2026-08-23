const fs = require('fs');
const path = require('path');

function entrySize(fullPath) {
  try {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
  } catch (_) {
    return 0;
  }

  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    total += entrySize(path.join(fullPath, entry.name));
  }
  return total;
}

function fileSize(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch (_) {
    return 0;
  }
}

function diskCapacity(targetPath) {
  try {
    const st = fs.statfsSync(targetPath);
    return Number(st.blocks) * Number(st.bsize);
  } catch (_) {
    return 0;
  }
}

function getStorage(portfolioRoot) {
  const mediaDir = path.join(portfolioRoot, 'media');
  const dataDir = path.join(portfolioRoot, 'CMS', 'data');
  const indexPath = path.join(portfolioRoot, 'index.html');

  const used = entrySize(mediaDir) + entrySize(dataDir) + fileSize(indexPath);
  const quota = diskCapacity(portfolioRoot);
  const percentUsed = quota ? ((used / quota) * 100).toFixed(1) : 0;

  return { used, quota, percentUsed };
}

module.exports = { getStorage };
