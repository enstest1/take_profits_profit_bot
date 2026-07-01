import { parseEnabledChains } from './chains.js';

function normalizeChainId(chainId) {
  return String(chainId || '').toLowerCase();
}

function pickBestPair(pairs, { enabledChains, chainHint } = {}) {
  const allowed = new Set((enabledChains || parseEnabledChains()).map(normalizeChainId));
  let filtered = pairs.filter((p) => allowed.has(normalizeChainId(p.chainId)));
  if (filtered.length === 0) return null;

  if (chainHint) {
    const hint = normalizeChainId(chainHint);
    const onHint = filtered.filter((p) => normalizeChainId(p.chainId) === hint);
    if (onHint.length > 0) filtered = onHint;
  }

  return filtered.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

function pairToToken(pair) {
  const totalTxns =
    ((pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0) +
    ((pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0);

  return {
    chain: normalizeChainId(pair.chainId),
    name: pair.baseToken?.name,
    symbol: pair.baseToken?.symbol,
    price: pair.priceUsd != null ? String(pair.priceUsd) : null,
    marketCap: pair.marketCap ?? null,
    volume24h: (pair.volume && pair.volume.h24) || 0,
    liquidity: (pair.liquidity && pair.liquidity.usd) || 0,
    buys24h: (pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0,
    sells24h: (pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0,
    priceChange1h: (pair.priceChange && pair.priceChange.h1) || null,
    buyPct: totalTxns > 0 ? Math.round(((pair.txns.h24.buys || 0) / totalTxns) * 100) : null,
    dexUrl: pair.url || null,
    imageUrl: (pair.info && pair.info.imageUrl) || null,
    pairCreatedAt: pair.pairCreatedAt || null,
    source: 'dexscreener',
  };
}

/**
 * Fetch best DexScreener pair for an address, filtered to enabled chains.
 * @param {string} address
 * @param {{ enabledChains?: string[], chainHint?: string }} options
 */
export async function fetchDexPair(address, options = {}) {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + address, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;

    const pair = pickBestPair(pairs, options);
    if (!pair || !pair.baseToken?.name) return null;

    return pairToToken(pair);
  } catch (e) {
    console.error('[dex] failed for ' + address.slice(0, 10) + '...:', e.message);
    return null;
  }
}
