"use strict";

/**
 * Moralis API wrapper — Solana + EVM
 * All calls use Authorization: "Bearer <key>" (Solana gateway)
 * or X-API-Key header (deep-index EVM endpoints)
 */

const MORALIS_KEY = () => process.env.MORALIS_API_KEY;

const SOL_BASE = "https://solana-gateway.moralis.io";
const EVM_BASE = "https://deep-index.moralis.io/api/v2.2";

const CHAIN_MAP = {
  ethereum: "eth",
  base: "base",
  bsc: "bsc",
  polygon: "polygon",
};

/** Helper: fetch with Bearer auth (Solana gateway) */
async function solFetch(path) {
  const res = await fetch(`${SOL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${MORALIS_KEY()}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return res.json();
}

/** Helper: fetch with X-API-Key auth (EVM deep-index) */
async function evmFetch(path) {
  const res = await fetch(`${EVM_BASE}${path}`, {
    headers: { "X-API-Key": MORALIS_KEY() },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return res.json();
}

/** 200ms delay between batch calls to respect rate limits */
function delay(ms = 200) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────
// SOLANA
// ─────────────────────────────────────────────

async function getSolanaTokenMetadata(address) {
  try {
    return await solFetch(`/token/mainnet/${address}/metadata`);
    // { name, symbol, decimals, totalSupply, fullyDilutedValuation, links }
  } catch (err) {
    console.error(`[Moralis] getSolanaTokenMetadata(${address}):`, err.message);
    return null;
  }
}

async function getSolanaTokenPrice(address) {
  try {
    return await solFetch(`/token/mainnet/${address}/price`);
    // { usdPrice, usdPrice24hrPercentChange, exchangeName, exchangeAddress }
  } catch (err) {
    console.error(`[Moralis] getSolanaTokenPrice(${address}):`, err.message);
    return null;
  }
}

/**
 * Returns buy/sell pressure from last 100 swaps (descending).
 */
async function getSolanaTokenBuySellPressure(address) {
  try {
    const data = await solFetch(
      `/token/mainnet/${address}/swaps?limit=100&order=DESC`
    );
    const swaps = data?.result ?? data ?? [];
    if (!Array.isArray(swaps)) return { buys: 0, sells: 0, totalTxns: 0, buyPressurePct: "50" };

    let buys = 0;
    let sells = 0;
    for (const s of swaps) {
      if (s.transactionType === "buy" || s.type === "buy") buys++;
      else if (s.transactionType === "sell" || s.type === "sell") sells++;
    }
    const total = buys + sells;
    if (total === 0) {
      return { buys: 0, sells: 0, totalTxns: 0, buyPressurePct: null }; // null = insufficient data
    }
    return {
      buys,
      sells,
      totalTxns: total,
      buyPressurePct: ((buys / total) * 100).toFixed(0),
    };
  } catch (err) {
    console.error(`[Moralis] getSolanaTokenBuySellPressure(${address}):`, err.message);
    return { buys: 0, sells: 0, totalTxns: 0, buyPressurePct: null };
  }
}

async function getSolanaTopHolders(address) {
  try {
    const data = await solFetch(`/token/mainnet/${address}/top-holders?limit=10`);
    const items = data?.result ?? data ?? [];
    return Array.isArray(items) ? items : [];
    // [{ ownerAddress, balanceFormatted, percentageRelativeToTotalSupply }]
  } catch (err) {
    console.error(`[Moralis] getSolanaTopHolders(${address}):`, err.message);
    return [];
  }
}

/**
 * Get Solana token creator (top-holders heuristic — largest early holder).
 * For pump.fun tokens, prefer the creator field directly from pump.fun API.
 */
async function getSolanaTokenCreator(address) {
  try {
    const holders = await getSolanaTopHolders(address);
    if (!holders.length) return null;
    return holders[0].ownerAddress ?? null;
  } catch {
    return null;
  }
}

async function getWalletTokens(walletAddress) {
  try {
    const data = await solFetch(`/account/mainnet/${walletAddress}/tokens`);
    return Array.isArray(data) ? data : (data?.result ?? []);
    // [{ mint, name, symbol, amount, usdValue }]
  } catch (err) {
    console.error(`[Moralis] getWalletTokens(${walletAddress}):`, err.message);
    return [];
  }
}

async function getWalletRecentTrades(walletAddress) {
  try {
    const data = await solFetch(
      `/account/mainnet/${walletAddress}/swaps?limit=20&order=DESC`
    );
    const items = data?.result ?? data ?? [];
    return Array.isArray(items) ? items : [];
    // [{ transactionHash, blockTimestamp, tokenIn, tokenOut, type }]
  } catch (err) {
    console.error(`[Moralis] getWalletRecentTrades(${walletAddress}):`, err.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// EVM
// ─────────────────────────────────────────────

async function getEVMTokenBuySellPressure(address, chain) {
  try {
    const c = CHAIN_MAP[chain] ?? chain;
    const data = await evmFetch(
      `/erc20/${address}/swaps?chain=${c}&limit=100&order=DESC`
    );
    const swaps = data?.result ?? data ?? [];
    if (!Array.isArray(swaps)) return { buys: 0, sells: 0, totalTxns: 0, buyPressurePct: null };

    let buys = 0;
    let sells = 0;
    for (const s of swaps) {
      if (s.transactionType === "buy" || s.type === "buy") buys++;
      else if (s.transactionType === "sell" || s.type === "sell") sells++;
    }
    const total = buys + sells;
    if (total === 0) {
      return { buys: 0, sells: 0, totalTxns: 0, buyPressurePct: null };
    }
    return {
      buys,
      sells,
      totalTxns: total,
      buyPressurePct: ((buys / total) * 100).toFixed(0),
    };
  } catch (err) {
    console.error(`[Moralis] getEVMTokenBuySellPressure(${address}, ${chain}):`, err.message);
    return { buys: 0, sells: 0, totalTxns: 0, buyPressurePct: null };
  }
}

/**
 * Returns the likely dev/deployer address (first owner in list).
 */
async function getEVMDevWallet(address, chain) {
  try {
    const c = CHAIN_MAP[chain] ?? chain;
    const data = await evmFetch(`/erc20/${address}/owners?chain=${c}&limit=20`);
    const items = data?.result ?? data ?? [];
    return Array.isArray(items) && items.length ? items[0] : null;
  } catch (err) {
    console.error(`[Moralis] getEVMDevWallet(${address}, ${chain}):`, err.message);
    return null;
  }
}

async function getEVMWalletTokenBalance(walletAddress, tokenAddress, chain) {
  try {
    const c = CHAIN_MAP[chain] ?? chain;
    const data = await evmFetch(
      `/${walletAddress}/erc20?chain=${c}&token_addresses[]=${tokenAddress}`
    );
    const items = data?.result ?? data ?? [];
    if (!Array.isArray(items) || !items.length) return null;
    return { balance: items[0].balance, balanceFormatted: items[0].balance_formatted };
  } catch (err) {
    console.error(`[Moralis] getEVMWalletTokenBalance:`, err.message);
    return null;
  }
}

module.exports = {
  delay,
  getSolanaTokenMetadata,
  getSolanaTokenPrice,
  getSolanaTokenBuySellPressure,
  getSolanaTopHolders,
  getSolanaTokenCreator,
  getWalletTokens,
  getWalletRecentTrades,
  getEVMTokenBuySellPressure,
  getEVMDevWallet,
  getEVMWalletTokenBalance,
};
