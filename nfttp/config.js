/**
 * nfttp/config.js — NFT take-profits flags.
 *
 * Same product loop as token TP (OG call → +75% → 1x–20x cards) but the
 * tracked metric is OpenSea floor, not DexScreener price. Unset = off.
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

function envList(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback.slice();
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** TP4APH #nft-land — default home for NFT take-profit cards. */
export const DEFAULT_NFT_TP_CHANNEL_ID = '1358929055604408465';

/** Comma-separated NFT_TP_CHANNEL_IDS, else single NFT_TP_CHANNEL_ID, else nft-land. */
function parseChannelIds() {
  const multi = process.env.NFT_TP_CHANNEL_IDS?.trim();
  if (multi) {
    return multi
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = process.env.NFT_TP_CHANNEL_ID?.trim();
  return single ? [single] : [DEFAULT_NFT_TP_CHANNEL_ID];
}

export function getNftTpConfig() {
  return {
    enabled: envBool('NFT_TP_ENABLED', false),
    /** Poll cadence — floors move slower than memecoins. */
    intervalSec: envInt('NFT_TP_INTERVAL_SEC', 120),
    /** Highest take-profit card (tier 20 = 21× floor). */
    maxTier: envInt('NFT_TP_MAX_TIER', 20),
    /** OpenSea chains tried when resolving a bare 0x contract. */
    chains: envList('NFT_TP_CHAINS', ['ethereum', 'base', 'robinhood']),
    /** If set, auto-track + alerts only in these channels. Defaults to TP4APH nft-land. */
    channelIds: parseChannelIds(),
    /**
     * Also treat bare 0x as an NFT contract. Off by default so token auto-track
     * keeps ownership of CAs in mixed trench channels.
     */
    trackContracts: envBool('NFT_TP_TRACK_CONTRACTS', false),
    debug: envBool('NFT_TP_DEBUG', false),
    timeoutMs: envInt('NFT_TP_TIMEOUT_MS', 8000),
  };
}

export function isNftTpEnabled() {
  return getNftTpConfig().enabled;
}

/** True when this Discord channel may auto-track NFT collections. */
export function isNftTpChannel(channelId) {
  const ids = getNftTpConfig().channelIds;
  if (!ids.length) return true;
  return ids.includes(String(channelId));
}

/** Cards always land here — nft-land, not the channel the slash command was typed in. */
export function nftTpAlertChannel(fallbackChannelId) {
  const ids = getNftTpConfig().channelIds;
  return ids[0] || fallbackChannelId;
}
