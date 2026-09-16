/**
 * xradar/tgParse.js — parse `/xwatch …` text commands for Telegram.
 *
 * Discord uses slash options; Telegram is one line:
 *   /xwatch pelpa333
 *   /xwatch pelpa333 posts
 *   /xwatch pelpa333 ping posts
 *   /xwatch ping pelpa333 follows replies
 *   /xwatch ping pelpa333 off
 */

const EVENT_WORDS = {
  posts: 'post',
  post: 'post',
  follows: 'follow',
  follow: 'follow',
  replies: 'reply',
  reply: 'reply',
  comments: 'reply',
  comment: 'reply',
};

const SUBS = new Set(['add', 'remove', 'list', 'ping']);

/**
 * @param {string[]} args tokens after `/xwatch`
 * @returns {{ sub: string, handle: string, ping: boolean, off: boolean, flags: { post: boolean|null, follow: boolean|null, reply: boolean|null } }}
 */
export function parseTgXwatch(args) {
  const tokens = (args || []).map((s) => String(s || '').trim()).filter(Boolean);
  const first = (tokens[0] || '').replace(/^@/, '').toLowerCase();
  // Bare `/xwatch pelpa333` is add-everything. Only `list`/`ping`/`remove`/`add` are verbs.
  const sub = !tokens.length ? 'list' : SUBS.has(first) ? first : 'add';
  const rest = SUBS.has(first) ? tokens.slice(1) : tokens;

  const flags = { post: null, follow: null, reply: null };
  let ping = false;
  let off = false;
  const handles = [];

  for (const raw of rest) {
    const w = raw.replace(/^@/, '').toLowerCase();
    if (w === 'ping') {
      ping = true;
      continue;
    }
    if (w === 'off') {
      off = true;
      continue;
    }
    if (EVENT_WORDS[w]) {
      flags[EVENT_WORDS[w]] = true;
      continue;
    }
    handles.push(w);
  }

  return { sub, handle: handles[0] || '', ping, off, flags };
}

/** True when Telegram's slash menu fired /xwatch with no handle — prompt instead of listing. */
export function xwatchNeedsHandlePrompt(args) {
  if (!args?.length) return true;
  const parsed = parseTgXwatch(args);
  if (parsed.sub === 'list') return false;
  return !parsed.handle;
}

/** Prefix stored while we wait for a ForceReply handle (empty menu → add). */
export function xwatchPendingPrefix(args) {
  if (!args?.length) return ['add'];
  return args;
}

/** Combine the pending prefix with the user's reply text. */
export function xwatchArgsFromPendingReply(prefix, text) {
  const tokens = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].replace(/^@/, '').toLowerCase();
  if (SUBS.has(first)) return tokens;
  return [...(prefix || ['add']), ...tokens];
}

/**
 * Who to ping: an inline text_mention, else the replied-to user, else the author.
 * @param {object} msg Telegram message
 */
export function pingTargetFromTelegramMessage(msg) {
  for (const e of msg?.entities || []) {
    if (e.type === 'text_mention' && e.user?.id) return String(e.user.id);
  }
  const replyFrom = msg?.reply_to_message?.from;
  if (replyFrom?.id && !replyFrom.is_bot) return String(replyFrom.id);
  return String(msg?.from?.id || '');
}
