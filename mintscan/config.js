/**
 * mintscan/config.js — chain + tuning config for the mint scanner.
 *
 * Ported from take_profi_bot/src/mint-scanner/config.ts, made chain-aware.
 * Default chain is Robinhood (Arbitrum Orbit L2, chain id 4663, ETH gas).
 *
 * Every threshold is env-overridable so the scanner can be tuned live on
 * Railway without a deploy.
 */

function envInt(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return fallback;
}

/** Comma-separated MINT_SCANNER_CHANNEL_IDS, else single MINT_SCANNER_CHANNEL_ID. */
function parseMintScannerChannelIds() {
  const multi = process.env.MINT_SCANNER_CHANNEL_IDS?.trim();
  if (multi) {
    return multi
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = process.env.MINT_SCANNER_CHANNEL_ID?.trim();
  return single ? [single] : [];
}

/**
 * Chain registry. Robinhood Chain is an Arbitrum Orbit L2 — same EVM log
 * format as Ethereum, so the scanner logic is unchanged; only endpoints,
 * explorer, and marketplace slugs differ.
 *
 * NOTE ON BLOCK TIMES: thresholds below are "mints per window", and the window
 * is measured in BLOCKS. Robinhood/Arbitrum blocks are ~0.25s vs Ethereum's
 * ~12s, so an Ethereum-tuned window of 25 blocks (~5 min) is ~6 seconds here.
 * WINDOW_BLOCKS therefore defaults per chain, not globally.
 */
export const CHAIN_PRESETS = {
  robinhood: {
    id: 'robinhood',
    label: 'Robinhood',
    chainId: 4663,
    // Public RPC is rate-limited; Alchemy is Robinhood's recommended provider.
    publicRpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    alchemyHost: 'robinhood-mainnet',
    explorerBase: 'https://robinhoodchain.blockscout.com',
    openSeaChain: 'robinhood',
    // ~0.25s blocks → 1200 blocks ≈ 5 minutes
    defaultWindowBlocks: 1200,
    defaultMaxBlocksPerTick: 4000,
  },
  ethereum: {
    id: 'ethereum',
    label: 'Ethereum',
    chainId: 1,
    publicRpcUrls: ['https://cloudflare-eth.com', 'https://ethereum.publicnode.com'],
    alchemyHost: 'eth-mainnet',
    explorerBase: 'https://etherscan.io',
    openSeaChain: 'ethereum',
    defaultWindowBlocks: 25,
    defaultMaxBlocksPerTick: 80,
  },
  base: {
    id: 'base',
    label: 'Base',
    chainId: 8453,
    publicRpcUrls: ['https://mainnet.base.org'],
    alchemyHost: 'base-mainnet',
    explorerBase: 'https://basescan.org',
    openSeaChain: 'base',
    defaultWindowBlocks: 150,
    defaultMaxBlocksPerTick: 600,
  },
};

export function getChain() {
  const id = (process.env.MINT_SCANNER_CHAIN || 'robinhood').trim().toLowerCase();
  const preset = CHAIN_PRESETS[id];
  if (!preset) {
    throw new Error(
      'MINT_SCANNER_CHAIN="' + id + '" unknown — expected one of: ' + Object.keys(CHAIN_PRESETS).join(', '),
    );
  }
  return preset;
}

export function getMintScannerConfig() {
  const chain = getChain();
  return {
    chain,
    enabled: envBool('MINT_SCANNER_ENABLED', false),
    intervalSec: envInt('MINT_SCANNER_INTERVAL_SEC', 45),
    maxBlocksPerTick: envInt('MINT_SCANNER_MAX_BLOCKS_PER_TICK', chain.defaultMaxBlocksPerTick),
    windowBlocks: envInt('MINT_SCANNER_WINDOW_BLOCKS', chain.defaultWindowBlocks),
    warmMints: envInt('MINT_SCANNER_WARM_MINTS', 25),
    hotMints: envInt('MINT_SCANNER_HOT_MINTS', 60),
    moonMints: envInt('MINT_SCANNER_MOON_MINTS', 120),
    minUnique: envInt('MINT_SCANNER_MIN_UNIQUE', 15),
    /**
     * Discord alerts only fire once a collection is this % of max supply.
     * Sub-threshold tier hits are still recorded as near-misses for review.
     */
    minMintPct: envInt('MINT_SCANNER_MIN_MINT_PCT', 40),
    logNearMisses: envBool('MINT_SCANNER_LOG_NEAR_MISSES', true),
    blockFactory: envBool('MINT_SCANNER_BLOCK_FACTORY', true),
    cardEditIntervalSec: envInt('MINT_SCANNER_CARD_EDIT_INTERVAL_SEC', 60),
    rpcTimeoutMs: envInt('MINT_SCANNER_RPC_TIMEOUT_MS', 8000),
    debug: envBool('MINT_SCANNER_DEBUG', false),
    /** @deprecated use channelIds — kept for logs/backward compat */
    channelId: parseMintScannerChannelIds()[0] || '',
    channelIds: parseMintScannerChannelIds(),
    /**
     * Require an OpenSea listing before alerting. This is the primary spam
     * filter — without it every junk factory contract alerts. Defaults on when
     * an OpenSea key is present.
     */
    requireOpenSea: (() => {
      const raw = process.env.MINT_SCANNER_REQUIRE_OPENSEA?.trim().toLowerCase();
      if (raw === '1' || raw === 'true' || raw === 'yes') return true;
      if (raw === '0' || raw === 'false' || raw === 'no') return false;
      return Boolean(process.env.OPENSEA_API_KEY?.trim());
    })(),
  };
}

export function getBlocklistSlugPrefixes() {
  const env = process.env.MINT_SCANNER_BLOCKLIST_SLUG_PREFIXES?.trim();
  if (env === 'none' || env === 'off') return [];
  if (env) return env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ['bobverse'];
}
