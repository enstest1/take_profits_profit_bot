#!/usr/bin/env node
/** Run at Railway build time — persists commit SHA for runtime when env vars are missing. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, '.deploy-sha');

function pick() {
  for (const key of ['RAILWAY_GIT_COMMIT_SHA', 'GIT_SHA', 'SOURCE_VERSION']) {
    const v = process.env[key]?.trim();
    if (v && v !== 'unknown' && !v.includes('${{')) return v;
  }
  return 'unknown';
}

const sha = pick();
fs.writeFileSync(out, sha + '\n');
console.log('[build] wrote .deploy-sha:', sha);
