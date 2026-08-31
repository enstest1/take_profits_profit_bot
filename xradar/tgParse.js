/**
 * xradar/tgParse.js — parse `/xwatch …` text commands for Telegram.
 *
 * Discord uses slash options; Telegram is one line:
 *   /xwatch add omisnista ping posts
 *   /xwatch ping omisnista follows replies
 *   /xwatch ping omisnista off
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
  const first = (tokens[0] || 'list').replace(/^@/, '').toLowerCase();
  const sub = SUBS.has(first) ? first : 'list';
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
      ping = true;
      continue;
    }
    handles.push(w);
  }

  return { sub, handle: handles[0] || '', ping, off, flags };
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
