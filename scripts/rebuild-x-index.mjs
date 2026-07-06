#!/usr/bin/env node
/** Rebuild db.xAccounts from entry.xHandle fields (idempotent). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { indexXAccount } from '../xSocial.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(ROOT, '..');
const DB_PATH = path.join(DATA_DIR, 'tracked.json');

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('No tracked.json at ' + DB_PATH);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function walk(db) {
  let indexed = 0;
  let skipped = 0;
  db.xAccounts = {};
  const buckets = [db.tokens || {}, db.archived || {}];
  for (const bucket of buckets) {
    for (const [key, entry] of Object.entries(bucket)) {
      if (!entry?.xHandle) {
        skipped += 1;
        continue;
      }
      indexXAccount(db, entry.xHandle, key);
      indexed += 1;
    }
  }
  return { indexed, skipped };
}

const db = loadDb();
const { indexed, skipped } = walk(db);
const tmp = DB_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(db));
fs.renameSync(tmp, DB_PATH);
console.log('[x-index] indexed=' + indexed + ' skipped(noHandle)=' + skipped);
