// scripts/repair-mint-case.mjs
// One-time repair: recover correct-case Solana mints for entries whose keys were
// lowercased by the old pairToToken() bug, using the untouched pair address in dexUrl.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rateLimiter } from '../rateLimiter.js';
import { isBrokenSolKey } from '../chains.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(ROOT, '..');
const DB_PATH = path.join(DATA_DIR, 'tracked.json');
const MARKER = path.join(DATA_DIR, '.tp_mintcase_repair_v1');

function pairAddressFromDexUrl(dexUrl) {
  const m = /dexscreener\.com\/solana\/([1-9A-HJ-NP-Za-km-z]{32,64})/.exec(dexUrl || '');
  return m ? m[1] : null;
}

async function canonicalMintFromPair(pairAddress, brokenKey) {
  const url = 'https://api.dexscreener.com/latest/dex/pairs/solana/' + pairAddress;
  const res = await rateLimiter.fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return null;
  const data = await res.json();
  const pair = (data.pairs || [])[0];
  if (!pair) return null;
  for (const side of [pair.baseToken, pair.quoteToken]) {
    const addr = side?.address;
    if (addr && addr.toLowerCase() === brokenKey) return addr;
  }
  return null;
}

export async function runMintCaseRepair() {
  if (fs.existsSync(MARKER)) {
    console.log('[repair] marker present — mint-case repair already ran, skipping');
    return { repaired: 0, skipped: 0, failed: 0, alreadyRan: true };
  }
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('[repair] cannot read DB:', e.message);
    return null;
  }
  if (!db.tokens) db.tokens = {};

  const broken = Object.entries(db.tokens).filter(([k, e]) => isBrokenSolKey(k, e));
  console.log(
    '[repair] found ' + broken.length + ' broken lowercase keys of ' +
    Object.keys(db.tokens).length + ' total',
  );

  let repaired = 0;
  let skipped = 0;
  let failed = 0;
  for (const [key, entry] of broken) {
    const pairAddr = pairAddressFromDexUrl(entry.dexUrl);
    if (!pairAddr) {
      skipped += 1;
      continue;
    }
    try {
      const canonical = await canonicalMintFromPair(pairAddr, key);
      if (!canonical) {
        failed += 1;
        continue;
      }
      if (db.tokens[canonical]) {
        skipped += 1;
        continue;
      }
      db.tokens[canonical] = { ...entry, address: canonical };
      delete db.tokens[key];
      repaired += 1;
      console.log(
        '[repair] ' + (entry.symbol || key.slice(0, 8)) + ' → ' +
        canonical.slice(0, 8) + '... (OG ' + entry.postedBy + ' preserved)',
      );
    } catch (e) {
      failed += 1;
      console.error('[repair] error on ' + key.slice(0, 12) + ':', e.message);
    }
  }

  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_PATH);
  fs.writeFileSync(MARKER, String(Date.now()));
  console.log(
    '[repair] done — repaired=' + repaired + ' skipped=' + skipped +
    ' failed=' + failed + ' (skipped/failed stay tracked; repost repair is fallback)',
  );
  return { repaired, skipped, failed, alreadyRan: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMintCaseRepair().then(() => process.exit(0));
}
