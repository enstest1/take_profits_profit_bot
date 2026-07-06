import { rateLimiter } from './rateLimiter.js';
import { CHAINS } from './chains.js';
import { xHandleFromPair } from './xSocial.js';

const BATCH_SIZE = 30;

function pickBestPairPerToken(pairs, wantedAddresses, chainId) {
  const chain = CHAINS[chainId];
  const wanted = new Set(
    wantedAddresses.map((a) => (chain?.kind === 'evm' ? a.toLowerCase() : a)),
  );
  const best = new Map();
  for (const pair of pairs || []) {
    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;
    let mint = null;
    if (chain?.kind === 'evm') {
      const b = base?.toLowerCase();
      const q = quote?.toLowerCase();
      if (wanted.has(b)) mint = b;
      else if (wanted.has(q)) mint = q;
    } else {
      mint = wanted.has(base) ? base : wanted.has(quote) ? quote : null;
    }
    if (!mint) continue;
    const liq = pair.liquidity?.usd ?? 0;
    const cur = best.get(mint);
    if (!cur || liq > (cur.liquidity?.usd ?? 0)) best.set(mint, pair);
  }
  return best;
}

function pairToLive(pair, mint, chainId) {
  const chain = CHAINS[chainId];
  const isEvm = chain?.kind === 'evm';
  const baseAddr = pair.baseToken?.address;
  const isBase = isEvm
    ? baseAddr?.toLowerCase() === mint
    : baseAddr === mint;
  const meta = isBase ? pair.baseToken : pair.quoteToken;
  const buys = pair.txns?.h24?.buys || 0;
  const sells = pair.txns?.h24?.sells || 0;
  const total = buys + sells;
  return {
    address: mint,
    name: meta?.name || meta?.symbol || 'Unknown',
    symbol: meta?.symbol || '?',
    price: pair.priceUsd != null ? String(pair.priceUsd) : null,
    marketCap: pair.marketCap ?? null,
    volume24h: pair.volume?.h24 || 0,
    liquidity: pair.liquidity?.usd || 0,
    buyPct: total > 0 ? Math.round((buys / total) * 100) : null,
    priceChange1h: pair.priceChange?.h1 ?? null,
    dexUrl: pair.url || null,
    imageUrl: pair.info?.imageUrl || null,
    source: 'dexscreener',
    xHandle: xHandleFromPair(pair),
  };
}

/**
 * Batch fetch live data for one chain (30 addresses per request).
 * @returns {Map<string, object>}
 */
export async function batchFetch(chainId, addresses, { timeoutMs = 12_000 } = {}) {
  const slug = CHAINS[chainId]?.dexScreenerSlug;
  if (!slug || !addresses.length) return new Map();

  const out = new Map();
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const chunk = addresses.slice(i, i + BATCH_SIZE);
    const url = 'https://api.dexscreener.com/tokens/v1/' + slug + '/' + chunk.join(',');
    try {
      const res = await rateLimiter.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res || !res.ok) continue;
      const pairs = await res.json();
      const best = pickBestPairPerToken(Array.isArray(pairs) ? pairs : [], chunk, chainId);
      for (const [mint, pair] of best) out.set(mint, pairToLive(pair, mint, chainId));
    } catch (e) {
      console.error('[dexBatch] ' + chainId + ' chunk failed (' + chunk.length + ' addrs):', e.message);
    }
  }
  return out;
}

export const batchFetchSolana = (mints, opts) => batchFetch('solana', mints, opts);
