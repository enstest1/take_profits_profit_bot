import { rateLimiter } from './rateLimiter.js';

const BATCH_SIZE = 30;

function pickBestPairPerToken(pairs, wantedMints) {
  const wanted = new Set(wantedMints);
  const best = new Map();
  for (const pair of pairs || []) {
    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;
    const mint = wanted.has(base) ? base : wanted.has(quote) ? quote : null;
    if (!mint) continue;
    const liq = pair.liquidity?.usd ?? 0;
    const cur = best.get(mint);
    if (!cur || liq > (cur.liquidity?.usd ?? 0)) best.set(mint, pair);
  }
  return best;
}

function pairToLive(pair, mint) {
  const isBase = pair.baseToken?.address === mint;
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
  };
}

/**
 * Fetch live data for many Solana mints in batches of 30.
 * @returns {Map<string, object>} mints with no listed pair are absent
 */
export async function batchFetchSolana(mints, { timeoutMs = 12_000 } = {}) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const chunk = mints.slice(i, i + BATCH_SIZE);
    const url = 'https://api.dexscreener.com/tokens/v1/solana/' + chunk.join(',');
    try {
      const res = await rateLimiter.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res || !res.ok) continue;
      const pairs = await res.json();
      const best = pickBestPairPerToken(Array.isArray(pairs) ? pairs : [], chunk);
      for (const [mint, pair] of best) out.set(mint, pairToLive(pair, mint));
    } catch (e) {
      console.error('[dexBatch] chunk failed (' + chunk.length + ' mints):', e.message);
    }
  }
  return out;
}
