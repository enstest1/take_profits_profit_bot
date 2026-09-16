import { parseEnabledChains, CHAINS, chainIdFromDexScreenerSlug } from './chains.js';
import { rateLimiter } from './rateLimiter.js';
import { xHandleFromPair } from './xSocial.js';
import { enrichLiveFromPair } from './valuationAudit.js';
import { selectBestPair, tokenAddressFromPair, tokenIsBase, trackedTokenFromPool } from './pairSelect.js';

function normalizeChainId(chainId) {
  return String(chainId || '').toLowerCase();
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

function pickBestPair(pairs, { enabledChains, chainHint, tokenAddress, pinnedPair } = {}) {
  const allowed = new Set((enabledChains || parseEnabledChains()).map(normalizeChainId));
  let filtered = pairs.filter((p) => allowed.has(normalizeChainId(p.chainId)));
  if (filtered.length === 0) return null;

  if (chainHint) {
    const hint = normalizeChainId(chainHint);
    const onHint = filtered.filter((p) => normalizeChainId(p.chainId) === hint);
    if (onHint.length > 0) filtered = onHint;
  }

  const chainId = chainHint || filtered[0]?.chainId;
  if (tokenAddress) {
    return selectBestPair(filtered, tokenAddress, { chainId, pinnedPair });
  }
  return filtered.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

function pairToToken(pair, address) {
  const chain = normalizeChainId(pair.chainId);
  const addr = String(address || '');
  const meta = tokenMetaFromPair(pair, address);
  const totalTxns =
    ((pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0) +
    ((pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0);

  const token = {
    address: chain === 'solana' ? addr : addr.toLowerCase(),
    chain,
    name: meta.name,
    symbol: meta.symbol,
    price: tokenIsBase(pair, address) && pair.priceUsd != null ? String(pair.priceUsd) : null,
    marketCap: tokenIsBase(pair, address) ? pair.marketCap ?? null : null,
    fdv: tokenIsBase(pair, address) ? pair.fdv ?? null : null,
    pairAddress: pair.pairAddress || null,
    volume24h: (pair.volume && pair.volume.h24) || 0,
    volume: pair.volume || null,
    priceChange: pair.priceChange || null,
    liquidity: (pair.liquidity && pair.liquidity.usd) || 0,
    buys24h: (pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0,
    sells24h: (pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0,
    priceChange1h: (pair.priceChange && pair.priceChange.h1) || null,
    buyPct: totalTxns > 0 ? Math.round(((pair.txns.h24.buys || 0) / totalTxns) * 100) : null,
    dexUrl: pair.url || null,
    imageUrl: (pair.info && pair.info.imageUrl) || null,
    pairCreatedAt: pair.pairCreatedAt || null,
    source: 'dexscreener',
    xHandle: xHandleFromPair(pair),
  };
  return enrichLiveFromPair(token, pair);
}

/** DexScreener URLs in chat: dexscreener.com/{chain}/{address} */
export function extractDexScreenerRefs(text) {
  const refs = [];
  if (!text) return refs;
  const re = /dexscreener\.com\/([a-z0-9_-]+)\/(0x[a-fA-F0-9]{40})/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    refs.push({
      chainId: chainIdFromDexScreenerSlug(m[1]),
      address: m[2].toLowerCase(),
    });
  }
  return refs;
}

/** Lookup by liquidity pool / pair contract (DexScreener pairs endpoint). */
export async function fetchDexPairFromPool(chainId, poolAddress, options = {}) {
  const chain = normalizeChainId(chainId);
  const slug = CHAINS[chain]?.dexScreenerSlug || chain;
  const attempts = options.retries ?? 2;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await rateLimiter.fetch(
        'https://api.dexscreener.com/latest/dex/pairs/' + slug + '/' + poolAddress,
        { signal: AbortSignal.timeout(options.timeoutMs ?? 12_000) },
      );
      if (!res.ok) continue;
      const data = await res.json();
      const pairs = data.pairs || [];
      if (pairs.length === 0) continue;
      const pair = pairs[0];
      const tokenAddr = trackedTokenFromPool(pair, chain);
      if (!tokenAddr) continue;
      // Inverted pool (SOL as base): priceUsd is SOL — look up the mint's own pairs.
      if (!tokenIsBase(pair, tokenAddr)) {
        const resolved = await fetchDexPairOnChain(chain, tokenAddr, options);
        if (resolved) return resolved;
      }
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
  const slug = CHAINS[chain]?.dexScreenerSlug || chain;
  const attempts = options.retries ?? 2;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await rateLimiter.fetch(
        'https://api.dexscreener.com/token-pairs/v1/' + slug + '/' + tokenAddress,
        { signal: AbortSignal.timeout(options.timeoutMs ?? 12_000) },
      );
      if (res.status === 429) {
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      if (!res.ok) continue;
      const pairs = await res.json();
      if (!Array.isArray(pairs) || pairs.length === 0) continue;
      const pair = selectBestPair(pairs, tokenAddress, {
        chainId: chain,
        pinnedPair: options.pinnedPair,
      });
      if (!pair) continue;
      const tokenAddr = tokenAddressFromPair(pair, tokenAddress);
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
      const res = await rateLimiter.fetch('https://api.dexscreener.com/latest/dex/tokens/' + address, {
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

/**
 * Resolve 0x on ONE specific EVM chain — pool-in, token-out (prevents v1 bug #1).
 * No cross-chain fallback (prevents v1 bug #2). Generalized from the robinhood-only
 * resolver so base (and future EVM chains) reuse identical logic.
 */
export async function resolveEvmChainToken(chainId, rawAddr) {
  const slug = CHAINS[chainId]?.dexScreenerSlug;
  if (!slug) return null;
  const addr = rawAddr.toLowerCase();

  let res = await rateLimiter.fetch(
    'https://api.dexscreener.com/token-pairs/v1/' + slug + '/' + addr,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (res.ok) {
    const pairs = await res.json();
    if (Array.isArray(pairs) && pairs.length > 0) {
      const best = selectBestPair(pairs, addr, { chainId });
      const tokenAddress = best ? tokenAddressFromPair(best, addr) : null;
      if (best && tokenAddress) {
        return { tokenAddress: tokenAddress.toLowerCase(), pair: best };
      }
    }
  }

  res = await rateLimiter.fetch(
    'https://api.dexscreener.com/latest/dex/pairs/' + slug + '/' + addr,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (res.ok) {
    const data = await res.json();
    const pair = data?.pairs?.[0] || data?.pair;
    if (pair?.baseToken?.address || pair?.quoteToken?.address) {
      let chosen = pair;
      const tokenAddress = String(
        trackedTokenFromPool(pair, chainId) || pair.baseToken?.address || '',
      ).toLowerCase();
      if (tokenAddress && !tokenIsBase(pair, tokenAddress)) {
        const tpRes = await rateLimiter.fetch(
          'https://api.dexscreener.com/token-pairs/v1/' + slug + '/' + tokenAddress,
          { signal: AbortSignal.timeout(8_000) },
        );
        if (tpRes.ok) {
          const list = await tpRes.json();
          const better = selectBestPair(Array.isArray(list) ? list : [], tokenAddress, { chainId });
          if (better) chosen = better;
        }
      }
      if (tokenAddress) {
        console.log(
          '[' + chainId + '] pool address resolved to token ' + tokenAddress +
          ' (input was pair ' + addr.slice(0, 10) + '…)',
        );
        return { tokenAddress, pair: chosen };
      }
    }
  }

  return null;
}

/** Build autotrack token object from a resolved EVM DexScreener pair. */
export function tokenDataFromEvmPair(chainId, pair, tokenAddress) {
  const token = pairToToken(pair, tokenAddress);
  return {
    ...token,
    platform: 'dexscreener',
    chain: chainId,
    address: tokenAddress,
  };
}

/** @deprecated back-compat wrappers — robinhood behavior byte-identical to before. */
export const resolveRobinhoodToken = (rawAddr) => resolveEvmChainToken('robinhood', rawAddr);
export const tokenDataFromRobinhoodPair = (pair, addr) => tokenDataFromEvmPair('robinhood', pair, addr);
