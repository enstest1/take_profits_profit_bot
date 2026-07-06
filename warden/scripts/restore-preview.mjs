#!/usr/bin/env node
/** Preview what restoring a Warden snapshot would change — human-only, no writes to bot volume. */
import { listSnapshots, loadSnapshotById } from '../shadowStore.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const id = process.argv[2];
if (!id) {
  console.log('Usage: node warden/scripts/restore-preview.mjs <snapshotId>');
  console.log('Recent snapshots:');
  for (const s of listSnapshots().slice(0, 10)) {
    console.log('  ' + s.id + '  ' + new Date(s.pulledAt).toISOString() + '  sha ' + s.gitSha);
  }
  process.exit(1);
}

const env = loadSnapshotById(id);
if (!env?.db) {
  console.error('Snapshot not found: ' + id);
  process.exit(1);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.warden-data', 'restore-preview');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, id + '-preview.json');
fs.writeFileSync(outPath, JSON.stringify(env.db, null, 2));

const tokens = Object.keys(env.db.tokens || {}).length;
const archived = Object.keys(env.db.archived || {}).length;
console.log('Restore preview for snapshot ' + id);
console.log('  pulledAt: ' + new Date(env.pulledAt).toISOString());
console.log('  gitSha:   ' + env.gitSha);
console.log('  tokens:   ' + tokens + ' active, ' + archived + ' archived');
console.log('  staged:   ' + outPath);
console.log('Copy into /data/tracked.json manually only after reviewing — Warden never auto-restores.');
