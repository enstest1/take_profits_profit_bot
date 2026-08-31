/**
 * xradar/pings.js — per-handle Discord/Telegram @ pings.
 *
 * Cards always post. Pings are extra: each watched X account can mention one
 * or more chat users only on the events they opted into (posts, replies,
 * follows). No ping config = silent cards.
 */

export const PING_EVENTS = ['post', 'reply', 'follow'];

const EVENT_LABEL = { post: 'posts', reply: 'replies', follow: 'follows' };

function emptyPings() {
  return { post: [], reply: [], follow: [] };
}

function clonePings(pings) {
  const next = emptyPings();
  for (const k of PING_EVENTS) {
    next[k] = [...(pings?.[k] || [])].map(String).filter(Boolean);
  }
  return next;
}

function platformOf(platform) {
  return platform || process.env.PLATFORM || 'discord';
}

/** Visible mention token for this platform. Telegram needs a text_mention-style link. */
export function formatUserMention(id, platform) {
  const p = platformOf(platform);
  if (p === 'telegram') {
    return '<a href="tg://user?id=' + id + '">ping</a>';
  }
  return '<@' + id + '>';
}

/**
 * Merge one chat user's event flags onto a ping map.
 * true = add them, false = remove them, null/undefined = leave that event alone.
 * clear=true with a userId drops that user from every event; without a userId wipes all.
 *
 * @param {object|null} pings
 * @param {string} userId
 * @param {{ post?: boolean|null, reply?: boolean|null, follow?: boolean|null, clear?: boolean }} flags
 */
export function applyPingPatch(pings, userId, flags = {}) {
  const next = clonePings(pings);
  const id = String(userId || '');
  if (flags.clear) {
    if (!id) return emptyPings();
    for (const k of PING_EVENTS) next[k] = next[k].filter((x) => x !== id);
    return next;
  }
  if (!id) return next;
  for (const k of PING_EVENTS) {
    const flag = flags[k];
    if (flag === true && !next[k].includes(id)) next[k].push(id);
    if (flag === false) next[k] = next[k].filter((x) => x !== id);
  }
  return next;
}

/** Chat user ids that should be mentioned for this event. */
export function pingIdsForEvent(watchedUser, event) {
  const ids = watchedUser?.pings?.[event];
  return Array.isArray(ids) ? [...new Set(ids.map(String).filter(Boolean))] : [];
}

/**
 * Payload for sendChannelAlert opts. Empty object when nobody opted in —
 * the card still posts, just without an @.
 * @param {string[]} userIds
 * @param {string} [platform]
 */
export function mentionPayload(userIds, platform) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  if (!ids.length) return {};
  const p = platformOf(platform);
  const content = ids.map((id) => formatUserMention(id, p)).join(' ');
  if (p === 'telegram') return { content };
  return {
    content,
    allowedMentions: { users: ids, parse: [] },
  };
}

/** Human line for /xwatch replies and the list embed. */
export function summarizePings(pings, platform) {
  const parts = [];
  const p = platformOf(platform);
  for (const k of PING_EVENTS) {
    const ids = [...new Set((pings?.[k] || []).map(String).filter(Boolean))];
    if (!ids.length) continue;
    parts.push(EVENT_LABEL[k] + ' ' + ids.map((id) => formatUserMention(id, p)).join(' '));
  }
  return parts.length ? parts.join(' · ') : '';
}

/** True when at least one boolean flag was actually passed (not left blank). */
export function anyPingFlagSet(flags) {
  return PING_EVENTS.some((k) => flags?.[k] === true || flags?.[k] === false);
}
