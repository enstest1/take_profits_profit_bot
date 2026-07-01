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
    address: String(address || '').toLowerCase(),
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

/** DexScreener URLs in chat: dexscreener.com/{chain}/{address} */
export function extractDexScreenerRefs(text) {
  const refs = [];
  if (!text) return refs;
  const re = /dexscreener\.com\/([a-z0-9]+)\/(0x[a-fA-F0-9]{40})/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    refs.push({ chainId: m[1].toLowerCase(), address: m[2].toLowerCase() });
  }
  return refs;
}

/** Lookup by liquidity pool / pair contract (DexScreener pairs endpoint). */
export async function fetchDexPairFromPool(chainId, poolAddress, options = {}) {
  const chain = normalizeChainId(chainId);
  const attempts = options.retries ?? 2;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(
        'https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + poolAddress,
        { signal: AbortSignal.timeout(options.timeoutMs ?? 12_000) },
      );
      if (!res.ok) continue;
      const data = await res.json();
      const pairs = data.pairs || [];
      if (pairs.length === 0) continue;
      const pair = pairs[0];
      const tokenAddr = pair.baseToken?.address;
      if (!tokenAddr) continue;
      const meta = tokenMetaFromPair(pair, tokenAddr);
      if (!meta.name && !meta.symbol) continue;
      return pairToToken(pair, tokenAddr);
    } catch {
      /* retry */
    }
  }
  return null;
}

/** Chain-scoped token lookup (often faster / more reliable than /tokens/{address}). */
export async function fetchDexPairOnChain(chainId, tokenAddress, options = {}) {
  const chain = normalizeChainId(chainId);
  const attempts = options.retries ?? 2;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(
        'https://api.dexscreener.com/token-pairs/v1/' + chain + '/' + tokenAddress,
        { signal: AbortSignal.timeout(options.timeoutMs ?? 12_000) },
      );
      if (res.status === 429) {
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      if (!res.ok) continue;
      const pairs = await res.json();
      if (!Array.isArray(pairs) || pairs.length === 0) continue;
      const pair = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const target = String(tokenAddress).toLowerCase();
      let tokenAddr = pair.baseToken?.address;
      if (pair.baseToken?.address?.toLowerCase() !== target && pair.quoteToken?.address?.toLowerCase() === target) {
        tokenAddr = pair.quoteToken.address;
      }
      if (!tokenAddr) continue;
      const meta = tokenMetaFromPair(pair, tokenAddr);
      if (!meta.name && !meta.symbol) continue;
      return pairToToken(pair, tokenAddr);
    } catch {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400));
    }
  }
  return null;
}

function dexResultToToken(dex) {
  return { ...dex, platform: 'dexscreener' };
}

/**
 * EVM token resolve — parallel per-chain DexScreener first (fast on Railway).
 */
export async function resolveEvmToken(address, { evmChains, messageText, retries, timeoutMs } = {}) {
  const chains = evmChains || parseEnabledChains().filter((c) => c !== 'solana');
  const normalized = String(address).toLowerCase();
  const fetchOpts = { retries: retries ?? 2, timeoutMs: timeoutMs ?? 10_000 };

  // DexScreener link in message → try that chain first (user workflow).
  for (const ref of extractDexScreenerRefs(messageText)) {
    if (!chains.includes(ref.chainId)) continue;
    let dex = await fetchDexPairOnChain(ref.chainId, normalized, fetchOpts);
    if (dex?.name || dex?.symbol) {
      console.log('[dex] link chain API → ' + dex.symbol + ' on ' + ref.chainId);
      return dexResultToToken(dex);
    }
    dex = await fetchDexPairFromPool(ref.chainId, ref.address, fetchOpts);
    if (dex?.name || dex?.symbol) {
      console.log('[dex] link pool → ' + dex.symbol + ' on ' + ref.chainId);
      return dexResultToToken(dex);
    }
  }

  // Primary: hit every enabled chain API in parallel (~10s max, not 40s+ sequential).
  const chainResults = await Promise.allSettled(
    chains.map((chain) => fetchDexPairOnChain(chain, normalized, fetchOpts)),
  );
  for (let i = 0; i < chainResults.length; i++) {
    const r = chainResults[i];
    if (r.status === 'fulfilled' && r.value && (r.value.name || r.value.symbol)) {
      console.log('[dex] parallel chain API → ' + r.value.symbol + ' on ' + chains[i]);
      return dexResultToToken(r.value);
    }
  }

  // Fallback: global token endpoint.
  let dex = await fetchDexPair(normalized, {
    enabledChains: chains,
    retries: fetchOpts.retries,
    timeoutMs: fetchOpts.timeoutMs,
  });
  if (dex?.name || dex?.symbol) return dexResultToToken(dex);

  // Pool address posted instead of token.
  for (const chain of chains) {
    dex = await fetchDexPairFromPool(chain, normalized, fetchOpts);
    if (dex?.name || dex?.symbol) {
      console.log('[dex] pool → ' + dex.symbol + ' on ' + chain);
      return dexResultToToken(dex);
    }
  }

  return null;
}

/**
 * Fetch best DexScreener pair for an address, filtered to enabled chains.
 * @param {string} address
 * @param {{ enabledChains?: string[], chainHint?: string }} options
 */
export async function fetchDexPair(address, options = {}) {
  const attempts = options.retries ?? 3;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + address, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status);
        if (res.status === 429 && i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        }
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
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }

  console.error('[dex] failed for ' + address.slice(0, 10) + '...:', lastErr?.message || 'unknown');
  return null;
}
