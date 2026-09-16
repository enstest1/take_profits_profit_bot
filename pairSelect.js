/**
 * Shared DexScreener pair picker.
 *
 * Highest-liquidity-wins jumps across Meteora/Raydium pools and will happily
 * take a quote-side pair whose priceUsd is the *other* token. That is the main
 * source of wrong 1x–Nx cards. Prefer: pinned pool → token-as-base → native
 * quote → recent volume, not ghost liquidity.
 */

/** Wrapped natives / stables we treat as a "real" quote (lowercased). */
const NATIVE_QUOTES = {
  solana: new Set([
    'so11111111111111111111111111111111111111112', // WSOL
    'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v', // USDC
    'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb', // USDT
  ]),
  base: new Set([
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  ]),
  ethereum: new Set([
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  ]),
  bsc: new Set([
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
    '0x55d398326f99059ff775485246999027b3197955', // USDT
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  ]),
  robinhood: new Set([
    '0x4200000000000000000000000000000000000006',
  ]),
  ink: new Set([
    '0x4200000000000000000000000000000000000006',
  ]),
  hype: new Set([
    '0x5555555555555555555555555555555555555555',
  ]),
  arc: new Set([
    '0x3600000000000000000000000000000000000000', // native USDC (Arc gas)
  ]),
};

export function addrEq(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

export function tokenIsBase(pair, tokenAddress) {
  return addrEq(pair?.baseToken?.address, tokenAddress);
}

export function tokenIsQuote(pair, tokenAddress) {
  return addrEq(pair?.quoteToken?.address, tokenAddress);
}

export function pairInvolvesToken(pair, tokenAddress) {
  return tokenIsBase(pair, tokenAddress) || tokenIsQuote(pair, tokenAddress);
}

/** The side that is NOT the tracked token — should be SOL/WETH/USDC when possible. */
function otherSideAddress(pair, tokenAddress) {
  if (tokenIsBase(pair, tokenAddress)) return pair?.quoteToken?.address;
  if (tokenIsQuote(pair, tokenAddress)) return pair?.baseToken?.address;
  return null;
}

export function isNativeQuotePair(pair, tokenAddress, chainId) {
  const natives = NATIVE_QUOTES[String(chainId || '').toLowerCase()];
  if (!natives || !natives.size) return false;
  const other = otherSideAddress(pair, tokenAddress);
  return other ? natives.has(String(other).toLowerCase()) : false;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Alive enough to keep using a pinned pool (avoid sticky-dead Meteora ghosts).
 * @param {object} pair
 */
export function pairIsLive(pair) {
  if (!pair) return false;
  const price = num(pair.priceUsd);
  if (!(price > 0)) return false;
  const liq = num(pair.liquidity?.usd);
  const vol = num(pair.volume?.m5) + num(pair.volume?.h1);
  return liq > 50 || vol > 0;
}

/**
 * Higher is better. Quote-side pairs score far below any base-side pair so we
 * never take priceUsd of the wrong token when a TOKEN/SOL pool exists.
 */
export function scorePair(pair, tokenAddress, chainId) {
  if (!pairInvolvesToken(pair, tokenAddress)) return -Infinity;
  const base = tokenIsBase(pair, tokenAddress);
  let s = base ? 1e12 : 0;
  if (isNativeQuotePair(pair, tokenAddress, chainId)) s += 1e9;
  const liq = num(pair.liquidity?.usd);
  const m5 = num(pair.volume?.m5);
  const h1 = num(pair.volume?.h1);
  const h24 = num(pair.volume?.h24);
  // Recent flow beats leftover concentrated liquidity on a dead Meteora bin.
  s += m5 * 80 + h1 * 15 + h24 + liq * 0.05;
  return s;
}

/**
 * Pick the pair we should price this tick.
 * @param {object[]} pairs
 * @param {string} tokenAddress
 * @param {{ chainId?: string, pinnedPair?: string }} [opts]
 * @returns {object|null}
 */
export function selectBestPair(pairs, tokenAddress, opts = {}) {
  const list = (pairs || []).filter((p) => pairInvolvesToken(p, tokenAddress));
  if (!list.length) return null;

  const pinnedAddr = opts.pinnedPair ? String(opts.pinnedPair) : '';
  if (pinnedAddr) {
    const pinned = list.find((p) => addrEq(p.pairAddress, pinnedAddr));
    if (pinned && pairIsLive(pinned) && tokenIsBase(pinned, tokenAddress)) return pinned;
  }

  const asBase = list.filter((p) => tokenIsBase(p, tokenAddress));
  const pool = asBase.length ? asBase : [];
  // Quote-only: do not invent a USD price from the other token's priceUsd.
  if (!pool.length) {
    console.warn(
      '[pair] ' +
        String(tokenAddress).slice(0, 8) +
        '… has no base-side pair on ' +
        (opts.chainId || '?') +
        ' — skip rather than invert',
    );
    return null;
  }

  pool.sort((a, b) => scorePair(b, tokenAddress, opts.chainId) - scorePair(a, tokenAddress, opts.chainId));
  return pool[0] || null;
}

/**
 * Address of OUR token on a pair (base or quote), preserving Dex casing.
 * Pool-only rows (no match) fall back to base — pool-in → token-out.
 */
export function tokenAddressFromPair(pair, requestedAddress) {
  if (requestedAddress && tokenIsBase(pair, requestedAddress)) return pair.baseToken.address;
  if (requestedAddress && tokenIsQuote(pair, requestedAddress)) return pair.quoteToken.address;
  return pair?.baseToken?.address || null;
}

export function isNativeAsset(address, chainId) {
  const natives = NATIVE_QUOTES[String(chainId || '').toLowerCase()];
  if (!natives || !natives.size) return false;
  return natives.has(String(address || '').toLowerCase());
}

/**
 * Pool URL / pair-contract in → the meme mint out.
 * If Dex listed SOL as base (inverted Meteora row), return the quote instead.
 */
export function trackedTokenFromPool(pair, chainId) {
  const base = pair?.baseToken?.address;
  const quote = pair?.quoteToken?.address;
  if (base && isNativeAsset(base, chainId) && quote && !isNativeAsset(quote, chainId)) return quote;
  return base || quote || null;
}
