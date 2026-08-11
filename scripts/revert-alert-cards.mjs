#!/usr/bin/env node
/**
 * Single-command revert to production (origin/main) alert card files.
 * Restores poller.js, autotrackHelpers.js, channelAlert.js from backups/pre-alert-cards/.
 *
 * Usage: npm run alert-cards:revert
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = path.join(ROOT, 'backups', 'pre-alert-cards');
const FILES = ['poller.js', 'autotrackHelpers.js', 'channelAlert.js'];

function die(msg) {
  console.error('[revert-alert-cards]', msg);
  process.exit(1);
}

if (!fs.existsSync(BACKUP)) die('Backup folder missing: ' + BACKUP);

for (const name of FILES) {
  const src = path.join(BACKUP, name);
  const dest = path.join(ROOT, name);
  if (!fs.existsSync(src)) die('Missing backup: ' + src);
  fs.copyFileSync(src, dest);
  console.log('Restored', name);
}

console.log('');
console.log('Production card files restored from backups/pre-alert-cards/.');
console.log('Also set ALERT_CARDS_ENABLED=false (or remove it) and redeploy.');
console.log('See backups/pre-alert-cards/RESTORE.md for manual copy commands.');
