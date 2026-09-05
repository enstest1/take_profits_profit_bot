/**
 * caMuteChannels.js — token-CA mute, not a full channel block.
 *
 * #nft-land is the NFT volume bot home. Token auto-track, token milestone
 * cards, and mint-drop cards must stay out — even when a new CA is pasted
 * or a collection drop hits the scanner. nfttp still posts here.
 *
 * Do not fold this into BLOCKED_CHANNEL_IDS: that mute kills every feature,
 * including NFT floor cards.
 */

/** TP4APH #nft-land — default token-CA mute (NFT volume bot only). */
export const DEFAULT_CA_MUTE_CHANNEL_IDS = ['1358929055604408465'];

/** @returns {string[]} */
export function caMuteChannelIds() {
  const raw = process.env.CA_MUTE_CHANNEL_IDS?.trim();
  if (raw === 'none' || raw === 'off') return [];
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_CA_MUTE_CHANNEL_IDS.slice();
}

/**
 * True when this channel must not auto-track token CAs or receive token /
 * mint-drop cards. NFT take-profits still run.
 * @param {string|null|undefined} channelId
 */
export function isCaMutedChannel(channelId) {
  if (channelId == null || channelId === '') return false;
  return caMuteChannelIds().includes(String(channelId));
}
