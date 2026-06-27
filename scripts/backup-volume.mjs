import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = '/data';
const MARKER_FILE = path.join(DATA_DIR, '.backup-migration-v1');
const FILES = ['tracked.json', '.tp_comeback_cycles', '.tp_milestone_bootstrap_v2'];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** One-shot backup on the Railway volume (survives region migration). */
export function runVolumeBackup({ force = false } = {}) {
  if (!fs.existsSync(DATA_DIR)) {
    return null;
  }

  if (!force && fs.existsSync(MARKER_FILE)) {
    try {
      const info = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
      console.log('[backup] volume backup already exists:', info.dir, '(' + info.tokens + ' tokens)');
      return info;
    } catch {
      /* re-backup if marker corrupt */
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(DATA_DIR, 'backups', stamp);
  fs.mkdirSync(backupDir, { recursive: true });

  const copied = [];
  for (const name of FILES) {
    const src = path.join(DATA_DIR, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(backupDir, name);
    fs.copyFileSync(src, dest);
    copied.push({
      name,
      bytes: fs.statSync(dest).size,
      sha256: sha256File(dest),
    });
  }

  let tokens = 0;
  const trackedPath = path.join(backupDir, 'tracked.json');
  if (fs.existsSync(trackedPath)) {
    try {
      tokens = Object.keys(JSON.parse(fs.readFileSync(trackedPath, 'utf8')).tokens || {}).length;
    } catch {
      tokens = -1;
    }
  }

  const info = {
    at: new Date().toISOString(),
    dir: backupDir,
    tokens,
    files: copied,
  };

  fs.writeFileSync(MARKER_FILE, JSON.stringify(info, null, 2));
  console.log('[backup] volume backup saved to ' + backupDir + ' (' + tokens + ' tokens)');
  for (const f of copied) {
    console.log('[backup]   ' + f.name + ': ' + f.bytes + ' bytes sha256=' + f.sha256.slice(0, 16) + '...');
  }

  return info;
}
