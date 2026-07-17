import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = fs.existsSync('/data') ? '/data' : ROOT;
export const DB_PATH = path.join(DATA_DIR, 'tracked.json');

/** Keys removed mid-cycle — mergePollSnapshot skips these. */
export const removedThisCycle = new Set();

let activePollTrackedKeys = null;

export function setActivePollTrackedKeys(keys) {
  activePollTrackedKeys = keys;
}

export function clearActivePollTrackedKeys() {
  activePollTrackedKeys = null;
}

export function clearRemovedThisCycle() {
  removedThisCycle.clear();
}

export function markRemovedThisCycle(key) {
  if (key) removedThisCycle.add(key);
}

export function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { tokens: {}, watchlist: {}, wallets: {}, archived: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    const corrupt = DB_PATH + '.corrupt-' + Date.now();
    try {
      fs.renameSync(DB_PATH, corrupt);
    } catch {
      /* best effort */
    }
    console.error('[DB] corrupt tracked.json renamed to ' + corrupt + ':', e.message);
    return { tokens: {}, watchlist: {}, wallets: {}, archived: {} };
  }
}

export function ensureDBSchema(db) {
  if (!db.tokens) db.tokens = {};
  if (!db.watchlist) db.watchlist = {};
  if (!db.wallets) db.wallets = {};
  if (!db.archived) db.archived = {};
  if (!db.xAccounts) db.xAccounts = {};
  if (!db.fibWatch) db.fibWatch = {};
  return db;
}

export function mergePollSnapshot(stagedDb, trackedKeys) {
  const fresh = ensureDBSchema(loadDB());
  for (const key of trackedKeys) {
    if (removedThisCycle.has(key)) continue;
    if (stagedDb.tokens[key]) fresh.tokens[key] = stagedDb.tokens[key];
  }
  return fresh;
}

export function saveDB(db) {
  try {
    const payload = activePollTrackedKeys
      ? mergePollSnapshot(db, activePollTrackedKeys)
      : db;
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.error('[DB] saveDB failed (' + DB_PATH + '):', e.message);
  }
}
