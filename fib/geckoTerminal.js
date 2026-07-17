/**
 * fib/geckoTerminal.js — OHLCV candle provider (GeckoTerminal public API, keyless).
 * Free tier ≈ 30 calls/min → internal spacing + retry/backoff, independent of the
 * DexScreener rateLimiter so the two budgets never starve each other.
 *
 * Endpoints:
 *   GET /networks/{network}/tokens/{address}/pools           → top pools for a token
 *   GET /networks/{network}/pools/{pool}/ohlcv/{timeframe}   → candles (max 1000)
 *   GET /networks                                            → network slug discovery (diagnostics)
 *
 * All candles are PRICE-denominated (USD). Callers convert to market cap via supplyFactor.
 */

import { FIB, timeframeSpec } from './config.js';

const BASE = 'https://api.geckoterminal.com/api/v2';
const HEADERS = { Accept: 'application/json;version=20230302' };

let lastCallAt = 0;
async function paced() {
  const wait = lastCallAt + FIB.GT_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function gtFetch(path) {
  let lastErr = null;
  for (let attempt = 0; attempt <= FIB.PROVIDER_RETRIES; attempt++) {
    try {
      await paced();
      const res = await fetch(BASE + path, {
        headers: HEADERS,
        signal: AbortSignal.timeout(FIB.PROVIDER_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error('GT HTTP ' + res.status);
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt));
        continue;
      }
      if (res.status === 404) return { notFound: true };
      if (!res.ok) {
        lastErr = new Error('GT HTTP ' + res.status);
        break;
      }
      return { json: await res.json() };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
    }
  }
  return { error: lastErr?.message || 'GT request failed' };
}

export function gtNetworkFor(chainId) {
  return FIB.GT_NETWORKS[String(chainId || '').toLowerCase()] || null;
}

/** Top pool (by reserve) trading `tokenAddress` on `chainId`. → { poolAddress } | { error } */
export async function resolveTopPool(chainId, tokenAddress) {
  const network = gtNetworkFor(chainId);
  if (!network) return { error: 'unsupported_chain:' + chainId };
  const addr = String(tokenAddress);
  const r = await gtFetch('/networks/' + network + '/tokens/' + encodeURIComponent(addr) + '/pools?page=1');
  if (r.error) return { error: r.error };
  if (r.notFound) return { error: 'token_not_indexed' };
  const pools = r.json?.data || [];
  if (!pools.length) return { error: 'no_pools' };
  let best = null;
  let bestReserve = -1;
  for (const p of pools) {
    const reserve = Number(p?.attributes?.reserve_in_usd || 0);
    if (reserve > bestReserve) {
      bestReserve = reserve;
      best = p;
    }
  }
  const poolAddress = best?.attributes?.address;
  if (!poolAddress) return { error: 'no_pools' };
  return { poolAddress };
}

const cache = new Map(); // cacheKey → { at, candles }

/**
 * Fetch normalized candles for a pool.
 * → { candles: [{ t, o, h, l, c, v }] } chronological | { error }
 */
export async function fetchCandles(chainId, poolAddress, tf, { limit = FIB.CANDLE_LIMIT, fresh = false } = {}) {
  const network = gtNetworkFor(chainId);
  if (!network) return { error: 'unsupported_chain:' + chainId };
  const spec = timeframeSpec(tf);
  const cacheKey = network + ':' + String(poolAddress).toLowerCase() + ':' + tf + ':' + limit;

  if (!fresh) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < FIB.CANDLE_CACHE_MS) return { candles: hit.candles, cached: true };
  }

  const path =
    '/networks/' + network + '/pools/' + encodeURIComponent(poolAddress) +
    '/ohlcv/' + spec.gtTf + '?aggregate=' + spec.agg + '&limit=' + Math.min(limit, 1000) + '&currency=usd';
  const r = await gtFetch(path);
  if (r.error) return { error: r.error };
  if (r.notFound) return { error: 'pool_not_indexed' };

  const list = r.json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list) || !list.length) return { error: 'no_candles' };

  // GT returns newest-first arrays of [tsSeconds, o, h, l, c, v]
  const candles = list
    .map((row) => ({
      t: Number(row[0]) * 1000,
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]) || 0,
    }))
    .filter((c) => Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c))
    .sort((a, b) => a.t - b.t);

  if (!candles.length) return { error: 'no_candles' };
  cache.set(cacheKey, { at: Date.now(), candles });
  return { candles };
}

/** Diagnostics: does GT know a network containing `needle`? Used by the simulate script. */
export async function findNetworkSlug(needle) {
  const q = String(needle).toLowerCase();
  for (let page = 1; page <= 5; page++) {
    const r = await gtFetch('/networks?page=' + page);
    if (r.error || !r.json?.data?.length) break;
    for (const n of r.json.data) {
      const id = String(n?.id || '').toLowerCase();
      const name = String(n?.attributes?.name || '').toLowerCase();
      if (id.includes(q) || name.includes(q)) return { id: n.id, name: n.attributes?.name };
    }
  }
  return null;
}
