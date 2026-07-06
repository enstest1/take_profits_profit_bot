import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isBrokenSolKey, parseStorageKey } from '../../chains.js';
import { allEntries } from '../lib/entries.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = fs.existsSync('/data/warden') ? '/data/warden' : path.join(ROOT, '.warden-data');

const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const LEGACY_KEYS_PATH = path.join(DATA_DIR, 'legacyEvmKeys.json');
const BROKEN_KEYS_PATH = path.join(DATA_DIR, 'frozenBrokenKeys.json');
const META_PATH = path.join(DATA_DIR, 'meta.json');

function ensureDirs() {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  fs.mkdirSync(DAILY_DIR, { recursive: true });
}

export function initShadowStore() {
  ensureDirs();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadMeta() {
  initShadowStore();
  if (!fs.existsSync(META_PATH)) return { lastHash: null, lastSnapshotId: null, snapshotCount: 0 };
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  } catch {
    return { lastHash: null, lastSnapshotId: null, snapshotCount: 0 };
  }
}

function saveMeta(meta) {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

export function loadPreviousSnapshot() {
  initShadowStore();
  const meta = loadMeta();
  if (!meta.lastSnapshotId) return null;
  const p = path.join(SNAPSHOTS_DIR, meta.lastSnapshotId + '.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function storeSnapshot(db, { hash, gitSha }) {
  initShadowStore();
  const meta = loadMeta();
  if (meta.lastHash === hash) return { changed: false, hash };

  const id = Date.now().toString(36) + '-' + hash.slice(0, 8);
  const envelope = {
    id,
    hash,
    pulledAt: Date.now(),
    gitSha: gitSha || 'unknown',
    db,
  };
  fs.writeFileSync(path.join(SNAPSHOTS_DIR, id + '.json'), JSON.stringify(envelope));

  const files = fs.readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.json')).sort();
  while (files.length > 48) {
    const old = files.shift();
    try {
      fs.unlinkSync(path.join(SNAPSHOTS_DIR, old));
    } catch {
      /* best effort */
    }
  }

  const day = new Date().toISOString().slice(0, 10);
  const dailyPath = path.join(DAILY_DIR, day + '.json');
  if (!fs.existsSync(dailyPath)) {
    fs.writeFileSync(dailyPath, JSON.stringify(envelope));
    pruneDaily(30);
  }

  saveMeta({
    lastHash: hash,
    lastSnapshotId: id,
    snapshotCount: (meta.snapshotCount || 0) + 1,
    lastChangedAt: Date.now(),
  });

  return { changed: true, hash, id, envelope };
}

function pruneDaily(keepDays) {
  const files = fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith('.json')).sort();
  while (files.length > keepDays) {
    try {
      fs.unlinkSync(path.join(DAILY_DIR, files.shift()));
    } catch {
      /* best effort */
    }
  }
}

export function listSnapshots() {
  initShadowStore();
  return fs
    .readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const env = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf8'));
        return { id: env.id, pulledAt: env.pulledAt, gitSha: env.gitSha, hash: env.hash };
      } catch {
        return { id: f.replace('.json', ''), pulledAt: 0 };
      }
    })
    .sort((a, b) => b.pulledAt - a.pulledAt);
}

export function loadSnapshotById(id) {
  const p = path.join(SNAPSHOTS_DIR, id + '.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Frozen legacy 0x key set — captured once on first snapshot. */
export function initLegacyEvmKeys(snap) {
  initShadowStore();
  if (fs.existsSync(LEGACY_KEYS_PATH)) {
    return JSON.parse(fs.readFileSync(LEGACY_KEYS_PATH, 'utf8'));
  }
  const keys = [];
  for (const key of Object.keys(snap?.tokens || {})) {
    if (/^0x/i.test(key) && !key.includes(':')) keys.push(key);
  }
  for (const key of Object.keys(snap?.archived || {})) {
    if (/^0x/i.test(key) && !key.includes(':') && !keys.includes(key)) keys.push(key);
  }
  fs.writeFileSync(LEGACY_KEYS_PATH, JSON.stringify(keys, null, 2));
  console.log('[warden] frozen legacy EVM keys: ' + keys.length);
  return keys;
}

export function loadLegacyEvmKeys() {
  initShadowStore();
  if (!fs.existsSync(LEGACY_KEYS_PATH)) return null;
  return JSON.parse(fs.readFileSync(LEGACY_KEYS_PATH, 'utf8'));
}

/** Frozen mangled-mint keys at first snapshot — steady-state keys don't re-alert REG-2. */
export function initFrozenBrokenKeys(snap) {
  initShadowStore();
  if (fs.existsSync(BROKEN_KEYS_PATH)) {
    return JSON.parse(fs.readFileSync(BROKEN_KEYS_PATH, 'utf8'));
  }
  const keys = [];
  for (const [key, entry] of allEntries(snap)) {
    if (parseStorageKey(key).chainId === 'solana' && isBrokenSolKey(key, entry)) keys.push(key);
  }
  fs.writeFileSync(BROKEN_KEYS_PATH, JSON.stringify(keys, null, 2));
  console.log('[warden] frozen broken Solana keys: ' + keys.length);
  return keys;
}

export function loadFrozenBrokenKeys() {
  initShadowStore();
  if (!fs.existsSync(BROKEN_KEYS_PATH)) return null;
  return JSON.parse(fs.readFileSync(BROKEN_KEYS_PATH, 'utf8'));
}
