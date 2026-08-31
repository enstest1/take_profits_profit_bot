/**
 * xradar/pings.js — per-handle Discord @ pings.
 *
 * Cards always post. Pings are extra: each watched X account can @ one or more
 * Discord users only on the events they opted into (posts, replies/comments,
 * follows). No ping config = silent cards, same as today.
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

/**
 * Merge one Discord user's event flags onto a ping map.
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

/** Discord user ids that should be mentioned for this event. */
export function pingIdsForEvent(watchedUser, event) {
  const ids = watchedUser?.pings?.[event];
  return Array.isArray(ids) ? [...new Set(ids.map(String).filter(Boolean))] : [];
}

/**
 * Payload for sendChannelAlert opts. Empty object when nobody opted in —
 * the card still posts, just without an @.
 * @param {string[]} userIds
 */
export function mentionPayload(userIds) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  if (!ids.length) return {};
  return {
    content: ids.map((id) => '<@' + id + '>').join(' '),
    allowedMentions: { users: ids, parse: [] },
  };
}

/** Human line for /xwatch replies and the list embed. */
export function summarizePings(pings) {
  const parts = [];
  for (const k of PING_EVENTS) {
    const ids = [...new Set((pings?.[k] || []).map(String).filter(Boolean))];
    if (!ids.length) continue;
    parts.push(EVENT_LABEL[k] + ' ' + ids.map((id) => '<@' + id + '>').join(' '));
  }
  return parts.length ? parts.join(' · ') : '';
}

/** True when at least one boolean flag was actually passed (not left blank). */
export function anyPingFlagSet(flags) {
  return PING_EVENTS.some((k) => flags?.[k] === true || flags?.[k] === false);
}
