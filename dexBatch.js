import { rateLimiter } from './rateLimiter.js';
import { CHAINS } from './chains.js';
import { xHandleFromPair } from './xSocial.js';
import { enrichLiveFromPair } from './valuationAudit.js';
import { selectBestPair, tokenIsBase } from './pairSelect.js';

const BATCH_SIZE = 30;

function normAddr(addr) {
  return String(addr || '').toLowerCase();
}

/**
 * Map DexScreener pairs onto the requested addresses (case-insensitive so a
 * mangled/canonical Solana mint still matches), then pick the priced pair.
 */
function pickBestPairPerToken(pairs, wantedAddresses, chainId, pinnedPairs = {}) {
  const wantedByNorm = new Map();
  for (const a of wantedAddresses) {
    if (!a) continue;
    wantedByNorm.set(normAddr(a), a);
  }

  const byMint = new Map();
  for (const pair of pairs || []) {
    const sides = [pair.baseToken?.address, pair.quoteToken?.address];
    let orig = null;
    for (const side of sides) {
      if (!side) continue;
      const hit = wantedByNorm.get(normAddr(side));
      if (hit) {
        orig = hit;
        break;
      }
    }
    if (!orig) continue;
    const arr = byMint.get(orig) || [];
    arr.push(pair);
    byMint.set(orig, arr);
  }

  const best = new Map();
  for (const [mint, list] of byMint) {
    const pinned = pinnedPairs[mint] || pinnedPairs[normAddr(mint)];
    const picked = selectBestPair(list, mint, { chainId, pinnedPair: pinned });
    if (picked) best.set(mint, picked);
  }
  return best;
}

function pairToLive(pair, mint, chainId) {
  const isBase = tokenIsBase(pair, mint);
  const meta = isBase ? pair.baseToken : pair.quoteToken;
  const buys = pair.txns?.h24?.buys || 0;
  const sells = pair.txns?.h24?.sells || 0;
  const total = buys + sells;
  const live = {
    address: mint,
    name: meta?.name || meta?.symbol || 'Unknown',
    symbol: meta?.symbol || '?',
    // priceUsd is always the BASE token. selectBestPair refuses quote-side rows.
    price: isBase && pair.priceUsd != null ? String(pair.priceUsd) : null,
    marketCap: isBase ? pair.marketCap ?? null : null,
    fdv: isBase ? pair.fdv ?? null : null,
    pairAddress: pair.pairAddress || null,
    volume24h: pair.volume?.h24 || 0,
    volume: pair.volume || null,
    priceChange: pair.priceChange || null,
    liquidity: pair.liquidity?.usd || 0,
    buyPct: total > 0 ? Math.round((buys / total) * 100) : null,
    priceChange1h: pair.priceChange?.h1 ?? null,
    dexUrl: pair.url || null,
    imageUrl: pair.info?.imageUrl || null,
    source: 'dexscreener',
    xHandle: xHandleFromPair(pair),
  };
  return enrichLiveFromPair(live, pair);
}

async function fetchChunk(slug, chunk, timeoutMs) {
  const url = 'https://api.dexscreener.com/tokens/v1/' + slug + '/' + chunk.join(',');
  const res = await rateLimiter.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res || !res.ok) {
    throw new Error('HTTP ' + (res ? res.status : 'null'));
  }
  const pairs = await res.json();
  return Array.isArray(pairs) ? pairs : [];
}

/**
 * Batch fetch live data for one chain (30 addresses per request).
 * @param {string} chainId
 * @param {string[]} addresses
 * @param {{ timeoutMs?: number, pinnedPairs?: Record<string, string> }} [opts]
 * @returns {Promise<Map<string, object>>}
 */
export async function batchFetch(chainId, addresses, { timeoutMs = 12_000, pinnedPairs = {} } = {}) {
  const slug = CHAINS[chainId]?.dexScreenerSlug;
  if (!slug || !addresses.length) return new Map();

  const out = new Map();
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const chunk = addresses.slice(i, i + BATCH_SIZE);
    let pairs = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        pairs = await fetchChunk(slug, chunk, timeoutMs);
        break;
      } catch (e) {
        if (attempt === 0) {
          console.warn('[dexBatch] ' + chainId + ' chunk retry (' + chunk.length + ' addrs):', e.message);
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        console.error('[dexBatch] ' + chainId + ' chunk failed (' + chunk.length + ' addrs):', e.message);
      }
    }
    if (!pairs) continue;
    const best = pickBestPairPerToken(pairs, chunk, chainId, pinnedPairs);
    for (const [mint, pair] of best) out.set(mint, pairToLive(pair, mint, chainId));
  }
  return out;
}

export const batchFetchSolana = (mints, opts) => batchFetch('solana', mints, opts);
