/**
 * fib/store.js — where fib state lives and how it is written safely.
 *
 * Integrated mode  → state nests at db.tokens[key].fib. It is mutated inside the poll
 *                    cycle on the poll's staged db and persisted by the poll's own
 *                    saveDB — the same pattern signals/retest.js uses, which survives
 *                    dbStore.mergePollSnapshot because `tokens` is the merged collection.
 *
 * Independent mode → entries live at db.fibWatch[key]. NEVER mutate fibWatch on a db
 *                    object that has awaited since it was loaded: mergePollSnapshot
 *                    rebuilds every non-tokens collection from disk, so stale writes
 *                    would clobber newer data. updateFibWatch() loads → mutates →
 *                    saves synchronously (no await inside), which makes it safe.
 */

import { loadDB, saveDB, ensureDBSchema } from '../dbStore.js';
import { makeStorageKey, parseStorageKey } from '../chains.js';

/** Synchronous read-modify-write for the fibWatch collection. mutator(fibWatch, db) → return value. */
export function updateFibWatch(mutator) {
  const db = ensureDBSchema(loadDB());
  if (!db.fibWatch) db.fibWatch = {};
  const out = mutator(db.fibWatch, db);
  saveDB(db);
  return out;
}

export function readFibWatch() {
  const db = ensureDBSchema(loadDB());
  return db.fibWatch || {};
}

export function watchKey(chainId, address) {
  return makeStorageKey(chainId, address);
}

export function chainOfKey(key) {
  return parseStorageKey(key).chainId;
}

/** Extract the DexScreener pair address from a stored dexUrl (…dexscreener.com/<chain>/<pair>). */
export function pairFromDexUrl(dexUrl) {
  if (!dexUrl) return null;
  const m = String(dexUrl).match(/dexscreener\.com\/[a-z0-9-]+\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

/** Human status line for /fibtrack status + list. */
export function describeStatus(fib) {
  if (!fib) return 'not tracking';
  const s = fib.status;
  if (s === 'waiting_mcap') return 'waiting for market cap floor';
  if (s === 'detecting') return 'detecting impulse (cycle ' + ((fib.cycleId || 0) + 1) + ')';
  if (s === 'armed') return 'armed — cycle #' + fib.cycleId + ', watching retracement';
  if (s === 'target_mode') return 'entry hit — cycle #' + fib.cycleId + ', watching targets';
  if (s === 'completed') return 'cycle #' + fib.cycleId + ' completed (TP2 hit)';
  if (s === 'invalidated') return 'cycle #' + fib.cycleId + ' invalidated (broke swing low)';
  if (s === 'paused') return 'paused';
  return s || 'unknown';
}
