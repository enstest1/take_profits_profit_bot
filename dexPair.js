import { parseEnabledChains } from './chains.js';

function normalizeChainId(chainId) {
  return String(chainId || '').toLowerCase();
}

function pairInvolvesToken(pair, address) {
  const target = String(address || '').toLowerCase();
  if (!target) return true;
  return (
    pair.baseToken?.address?.toLowerCase() === target ||
    pair.quoteToken?.address?.toLowerCase() === target
  );
}

function tokenMetaFromPair(pair, address) {
  const target = String(address || '').toLowerCase();
  if (pair.baseToken?.address?.toLowerCase() === target) {
    return {
      name: pair.baseToken.name || pair.baseToken.symbol || 'Unknown',
      symbol: pair.baseToken.symbol || '?',
    };
  }
  if (pair.quoteToken?.address?.toLowerCase() === target) {
    return {
      name: pair.quoteToken.name || pair.quoteToken.symbol || 'Unknown',
      symbol: pair.quoteToken.symbol || '?',
    };
  }
  return {
    name: pair.baseToken?.name || pair.baseToken?.symbol || 'Unknown',
    symbol: pair.baseToken?.symbol || '?',
  };
}

function pickBestPair(pairs, { enabledChains, chainHint, tokenAddress } = {}) {
  const allowed = new Set((enabledChains || parseEnabledChains()).map(normalizeChainId));
  let filtered = pairs.filter((p) => allowed.has(normalizeChainId(p.chainId)));
  if (filtered.length === 0) return null;

  if (tokenAddress) {
    const involving = filtered.filter((p) => pairInvolvesToken(p, tokenAddress));
    if (involving.length > 0) filtered = involving;
  }

  if (chainHint) {
    const hint = normalizeChainId(chainHint);
    const onHint = filtered.filter((p) => normalizeChainId(p.chainId) === hint);
    if (onHint.length > 0) filtered = onHint;
  }

  return filtered.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

function pairToToken(pair, address) {
  const meta = tokenMetaFromPair(pair, address);
  const totalTxns =
    ((pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0) +
    ((pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0);

  return {
    chain: normalizeChainId(pair.chainId),
    name: meta.name,
    symbol: meta.symbol,
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
  const attempts = options.retries ?? 2;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + address, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
      });
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status);
        continue;
      }

      const data = await res.json();
      const pairs = data.pairs || [];
      if (pairs.length === 0) {
        lastErr = new Error('no pairs');
        continue;
      }

      const pair = pickBestPair(pairs, { ...options, tokenAddress: address });
      if (!pair) {
        lastErr = new Error('no pair on enabled chains');
        continue;
      }

      const meta = tokenMetaFromPair(pair, address);
      if (!meta.name && !meta.symbol) {
        lastErr = new Error('missing token metadata');
        continue;
      }

      return pairToToken(pair, address);
    } catch (e) {
      lastErr = e;
    }
  }

  console.error('[dex] failed for ' + address.slice(0, 10) + '...:', lastErr?.message || 'unknown');
  return null;
}
