/**
 * Discord channels where the bot must not post, reply, or autotrack.
 * Default: general/log channel that should stay human-only.
 */

const DEFAULT_BLOCKED = ['1536177376508121088'];

/** @returns {string[]} */
export function blockedChannelIds() {
  const raw = process.env.BLOCKED_CHANNEL_IDS?.trim();
  if (raw === 'none' || raw === 'off') return [];
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_BLOCKED.slice();
}

/** @param {string|null|undefined} channelId */
export function isBlockedChannel(channelId) {
  if (channelId == null || channelId === '') return false;
  return blockedChannelIds().includes(String(channelId));
}
