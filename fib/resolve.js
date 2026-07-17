/**
 * fib/resolve.js — resolve a raw CA (or pool address) for /fibtrack add.
 * Reuses the bot's existing chain rules and the shared DexScreener rateLimiter.
 * Never guesses silently: EVM addresses are checked against enabled EVM chains
 * (robinhood) and Solana addresses against Solana; ambiguity or no-liquidity is
 * returned as an explicit error string for the command reply.
 */

import { rateLimiter } from '../rateLimiter.js';
import { CHAINS, enabledChains, isEvmAddress, isSolanaAddress } from '../chains.js';

function bestPair(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  return pairs.reduce((a, b) => ((a.liquidity?.usd || 0) >= (b.liquidity?.usd || 0) ? a : b));
}

async function pairsOnChain(chainId, addr) {
  const slug = CHAINS[chainId]?.dexScreenerSlug;
  if (!slug) return null;
  try {
    const res = await rateLimiter.fetch(
      'https://api.dexscreener.com/token-pairs/v1/' + slug + '/' + encodeURIComponent(addr),
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

/** If the user pasted a POOL address, flip it to the base token (mirrors resolveRobinhoodToken). */
async function poolToToken(chainId, addr) {
  const slug = CHAINS[chainId]?.dexScreenerSlug;
  if (!slug) return null;
  try {
    const res = await rateLimiter.fetch(
      'https://api.dexscreener.com/latest/dex/pairs/' + slug + '/' + encodeURIComponent(addr),
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data?.pairs?.[0] || data?.pair;
    if (!pair?.baseToken?.address) return null;
    return { tokenAddress: pair.baseToken.address, pair };
  } catch {
    return null;
  }
}

/**
 * → { ok:true, chainId, address, symbol, name, pairAddress, price, marketCap, liquidity, dexUrl }
 * | { ok:false, error }
 */
export async function resolveTokenForFib(rawInput, chainHint = null) {
  const raw = String(rawInput || '').trim();
  if (!raw) return { ok: false, error: 'No address provided.' };

  const enabled = enabledChains();
  let candidates = [];
  if (chainHint && CHAINS[chainHint]) {
    candidates = [chainHint];
  } else if (isEvmAddress(raw)) {
    candidates = enabled.filter((c) => CHAINS[c].kind === 'evm');
    if (!candidates.length) return { ok: false, error: 'EVM address but no EVM chain is enabled (set ENABLED_CHAINS).' };
  } else if (isSolanaAddress(raw)) {
    candidates = enabled.includes('solana') ? ['solana'] : [];
    if (!candidates.length) return { ok: false, error: 'Solana address but solana is not in ENABLED_CHAINS.' };
  } else {
    return { ok: false, error: 'Not a valid Solana or EVM contract address.' };
  }

  const found = [];
  for (const chainId of candidates) {
    const addr = CHAINS[chainId].kind === 'evm' ? raw.toLowerCase() : raw;
    let pairs = await pairsOnChain(chainId, addr);
    let tokenAddress = addr;
    if (!pairs?.length) {
      const flipped = await poolToToken(chainId, addr);
      if (flipped) {
        tokenAddress = CHAINS[chainId].kind === 'evm' ? flipped.tokenAddress.toLowerCase() : flipped.tokenAddress;
        pairs = [flipped.pair];
      }
    }
    const pair = bestPair(pairs);
    if (pair) found.push({ chainId, tokenAddress, pair });
  }

  if (!found.length) return { ok: false, error: 'No liquid trading pair found on ' + candidates.join('/') + '.' };
  if (found.length > 1) {
    return {
      ok: false,
      error:
        'Address exists on multiple chains (' + found.map((f) => f.chainId).join(', ') +
        ') — re-run with the chain option set.',
    };
  }

  const { chainId, tokenAddress, pair } = found[0];
  const meta = pair.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase() ? pair.baseToken : pair.quoteToken;
  return {
    ok: true,
    chainId,
    address: tokenAddress,
    symbol: meta?.symbol || '?',
    name: meta?.name || meta?.symbol || 'Unknown',
    pairAddress: pair.pairAddress || null,
    price: pair.priceUsd != null ? Number(pair.priceUsd) : null,
    marketCap: pair.marketCap ?? pair.fdv ?? null,
    liquidity: pair.liquidity?.usd || 0,
    dexUrl: pair.url || null,
  };
}
