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
  if (!db.xRadar) db.xRadar = { users: {}, snapshots: {} };
  if (!db.xFeed) db.xFeed = { seen: {}, lastPollAt: 0 };
  if (!db.mintScanner) db.mintScanner = { lastScannedBlock: 0, cards: {}, nearMisses: {} };
  if (!db.nftTp) db.nftTp = { collections: {} };
  if (!db.nftTp.collections) db.nftTp.collections = {};
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

/** Atomic write that skips mergePollSnapshot — used by xradar/xfeed side state. */
function writeDirect(db) {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_PATH);
}

/**
 * Mutate nftTp on disk without losing the write to a concurrent token poll.
 * OG floor locks must survive mergePollSnapshot the same way xRadar snapshots do.
 */
export function patchNftTp(mutator) {
  const db = ensureDBSchema(loadDB());
  if (!db.nftTp) db.nftTp = { collections: {} };
  if (!db.nftTp.collections) db.nftTp.collections = {};
  const out = mutator(db.nftTp, db);
  const nftTp = db.nftTp;
  const fresh = ensureDBSchema(loadDB());
  fresh.nftTp = nftTp;
  try {
    writeDirect(fresh);
  } catch (e) {
    console.error('[DB] patchNftTp failed (' + DB_PATH + '):', e.message);
  }
  return out;
}

/**
 * Mutate xRadar on disk without losing the write to a concurrent token poll.
 * Reloads tokens after the mutator so we do not clobber poller price updates.
 */
export function patchXRadar(mutator) {
  const db = ensureDBSchema(loadDB());
  if (!db.xRadar) db.xRadar = { users: {}, snapshots: {} };
  if (!db.xRadar.users) db.xRadar.users = {};
  if (!db.xRadar.snapshots) db.xRadar.snapshots = {};
  const out = mutator(db.xRadar, db);
  const xRadar = db.xRadar;
  const fresh = ensureDBSchema(loadDB());
  fresh.xRadar = xRadar;
  try {
    writeDirect(fresh);
  } catch (e) {
    console.error('[DB] patchXRadar failed (' + DB_PATH + '):', e.message);
  }
  return out;
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
