/** Resolve the git commit SHA for deploy correlation (Warden alert footers). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_SHA_FILE = path.join(ROOT, '.deploy-sha');

let fileSha = null;

function isUsableSha(v) {
  if (!v) return false;
  const s = String(v).trim();
  if (!s || s === 'unknown') return false;
  // CLI-set Railway refs that never expanded
  if (s.includes('${{') || s.includes('}}')) return false;
  return true;
}

function fromEnv() {
  for (const key of ['RAILWAY_GIT_COMMIT_SHA', 'GIT_SHA', 'SOURCE_VERSION']) {
    const v = process.env[key];
    if (isUsableSha(v)) return String(v).trim();
  }
  return null;
}

function fromFile() {
  if (fileSha !== null) return fileSha;
  try {
    const raw = fs.readFileSync(DEPLOY_SHA_FILE, 'utf8').trim();
    fileSha = isUsableSha(raw) ? raw : 'unknown';
  } catch {
    fileSha = 'unknown';
  }
  return fileSha;
}

/** Short sha for Discord footers; full hash when unavailable. */
export function resolveGitSha() {
  return fromEnv() || fromFile() || 'unknown';
}

export function shortGitSha(sha = resolveGitSha()) {
  if (!sha || sha === 'unknown') return 'unknown';
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}
