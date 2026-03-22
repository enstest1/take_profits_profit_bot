"use strict";

/**
 * DexScreener API wrapper
 */

/**
 * Fetch token data from DexScreener.
 * @param {string} address - token contract address
 * @returns {object|null} normalised token data or null if no pairs found
 */
async function fetchTokenDex(address) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;

    const json = await res.json();
    const pairs = json?.pairs;
    if (!pairs || pairs.length === 0) return null;

    // Pick the pair with highest liquidity
    const pair = pairs.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0];

    return {
      name: pair.baseToken?.name ?? "Unknown",
      symbol: pair.baseToken?.symbol ?? "???",
      chain: pair.chainId ?? "unknown",
      price: pair.priceUsd ?? null,
      priceChange24h: pair.priceChange?.h24 ?? null,
      volume24h: pair.volume?.h24 ?? 0,
      buys24h: pair.txns?.h24?.buys ?? 0,
      sells24h: pair.txns?.h24?.sells ?? 0,
      marketCap: pair.marketCap ?? null,
      liquidity: pair.liquidity?.usd ?? null,
      dexUrl: pair.url ?? null,
      imageUrl: pair.info?.imageUrl ?? null,
      pairCreatedAt: pair.pairCreatedAt ?? null, // ms timestamp
    };
  } catch (err) {
    console.error(`[DexScreener] fetchTokenDex(${address}) error:`, err.message);
    return null;
  }
}

module.exports = { fetchTokenDex };
