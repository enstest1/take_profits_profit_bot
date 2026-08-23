import { CHAINS, parseStorageKey } from '../chains.js';

/** GMGN chain slug — differs from our registry id for solana (`sol`). */
function gmgnChainSlug(chainId) {
  const id = String(chainId || 'solana').toLowerCase();
  if (id === 'solana') return 'sol';
  if (id === 'ethereum') return 'eth';
  // GMGN mirrors DexScreener's HyperEVM slug, not our registry id.
  if (id === 'hype') return 'hyperevm';
  return CHAINS[id]?.dexScreenerSlug || id;
}

/**
 * GMGN token page.
 * @example https://gmgn.ai/robinhood/token/0x91554e79...
 */
export function gmgnUrl(chainId, address) {
  const slug = gmgnChainSlug(chainId);
  const addr = CHAINS[String(chainId || '').toLowerCase()]?.kind === 'evm'
    ? String(address).toLowerCase()
    : address;
  return 'https://gmgn.ai/' + slug + '/token/' + addr;
}

/**
 * DexScreener page for a token.
 * @example https://dexscreener.com/robinhood/0x91554e79...
 */
export function dexScreenerUrl(chainId, address) {
  const slug = CHAINS[String(chainId || '').toLowerCase()]?.dexScreenerSlug || chainId;
  const addr = CHAINS[chainId]?.kind === 'evm' ? String(address).toLowerCase() : address;
  return 'https://dexscreener.com/' + slug + '/' + addr;
}

/**
 * BasedBot token page.
 * @example https://basedbot.app/token/robinhood/0x91554e79...
 */
export function basedBotUrl(chainId, address) {
  const id = String(chainId || 'solana').toLowerCase();
  const addr = CHAINS[id]?.kind === 'evm' ? String(address).toLowerCase() : address;
  return 'https://basedbot.app/token/' + id + '/' + addr;
}

/**
 * FOMO family token page.
 * @example https://fomo.family/tokens/robinhood/0x020bfc...
 */
export function fomoUrl(chainId, address) {
  const id = String(chainId || 'solana').toLowerCase();
  const addr = CHAINS[id]?.kind === 'evm' ? String(address).toLowerCase() : address;
  return 'https://fomo.family/tokens/' + id + '/' + addr;
}

/** Markdown link row for embed description. */
export function buildTradeLinksMarkdown(chainId, address) {
  return (
    '[DEX](' +
    dexScreenerUrl(chainId, address) +
    ') · [GMGN](' +
    gmgnUrl(chainId, address) +
    ') · [BasedBot](' +
    basedBotUrl(chainId, address) +
    ') · [FOMO](' +
    fomoUrl(chainId, address) +
    ')'
  );
}

/** Resolve chain + bare address from a storage key. */
export function linksForStorageKey(storageKey) {
  const { chainId, address } = parseStorageKey(storageKey);
  const chain = chainId === 'legacy-evm' ? 'base' : chainId;
  return { chainId: chain, address, markdown: buildTradeLinksMarkdown(chain, address) };
}
