/**
 * fib/watchLoop.js — 15s poll loop for /fibtrack tokens that the main tracker does NOT
 * already follow. Reuses dexBatch.batchFetch, so each tick costs one batched
 * DexScreener call per chain (30 tokens/request) through the shared rate limiter.
 *
 * Tokens that ARE in db.tokens ride the main poller instead (evaluateFib inside
 * processTokenWithLive) — this loop skips them to avoid double alerts.
 */

import { FIB } from './config.js';
import { batchFetch } from '../dexBatch.js';
import { CHAINS } from '../chains.js';
import { loadDB, ensureDBSchema } from '../dbStore.js';
import { readFibWatch } from './store.js';
import { evaluateFibWatch } from './evaluate.js';

let running = false;
let timer = null;

async function tick(client) {
  if (running) return;
  running = true;
  try {
    const watch = readFibWatch();
    const keys = Object.keys(watch);
    if (!keys.length) return;

    const db = ensureDBSchema(loadDB());

    // group by chain, skipping paused/disabled and tokens the main poller already covers
    const byChain = new Map();
    for (const key of keys) {
      const w = watch[key];
      if (!w?.fib || w.fib.enabled === false || w.fib.status === 'paused') continue;
      if (db.tokens[key]?.fib) continue; // integrated tracking wins
      const chainId = (w.chain || 'solana').toLowerCase();
      if (!byChain.has(chainId)) byChain.set(chainId, []);
      byChain.get(chainId).push({ key, w });
    }

    for (const [chainId, items] of byChain) {
      const isEvm = CHAINS[chainId]?.kind === 'evm';
      const addrs = items.map(({ w }) => (isEvm ? String(w.address).toLowerCase() : w.address));
      let liveMap;
      try {
        liveMap = await batchFetch(chainId, addrs);
      } catch (e) {
        console.error('[fib/watch] batch ' + chainId + ':', e.message);
        continue;
      }
      for (const { key, w } of items) {
        const addr = isEvm ? String(w.address).toLowerCase() : w.address;
        const live = liveMap.get(addr);
        if (!live) continue;
        try {
          await evaluateFibWatch(client, key, w, live);
        } catch (e) {
          console.error('[fib/watch] ' + key + ':', e.message);
        }
      }
    }
  } catch (e) {
    console.error('[fib/watch] tick failed:', e.message);
  } finally {
    running = false;
  }
}

export function startFibWatchLoop(client) {
  if (!FIB.ENABLED) {
    console.log('[fib/watch] FIB_TRACKING_ENABLED=false — watch loop not started');
    return;
  }
  if (timer) return;
  timer = setInterval(() => void tick(client), FIB.WATCH_POLL_MS);
  timer.unref?.();
  console.log('[fib/watch] loop started (' + FIB.WATCH_POLL_MS + 'ms)');
}

export function stopFibWatchLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
