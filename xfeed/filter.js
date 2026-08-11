/**
 * xfeed/filter.js — pure tweet-eligibility rules. No I/O, fully testable.
 *
 * Every rule defaults to permissive so the out-of-the-box behaviour is
 * "every tweet"; each one is switched on individually from env.
 */

/** Solana base58 (32-44) or EVM 0x-hex (40) — same shapes the bot tracks. */
const CA_RE = /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;
const CASHTAG_RE = /\$[A-Za-z][A-Za-z0-9]{1,14}\b/;

export function hasCashtagOrCA(text) {
  const s = String(text || '');
  return CA_RE.test(s) || CASHTAG_RE.test(s);
}

export function isReply(tweet) {
  return Boolean(tweet?.isReply || tweet?.inReplyToStatusId);
}

export function isRetweet(tweet) {
  return Boolean(tweet?.isRetweet || tweet?.retweetedStatus);
}

/**
 * shouldPost(tweet, cfg, nowMs) → { ok:true } | { ok:false, reason }
 * Reasons are returned (not just booleans) so the debug log can explain drops.
 */
export function shouldPost(tweet, cfg, nowMs = Date.now()) {
  if (!tweet?.id) return { ok: false, reason: 'no_id' };
  if (!tweet.text) return { ok: false, reason: 'no_text' };

  const ageMin = (nowMs - (tweet.timestamp || 0) * 1000) / 60000;
  if (cfg.maxAgeMin > 0 && ageMin > cfg.maxAgeMin) return { ok: false, reason: 'too_old' };

  if (!cfg.includeReplies && isReply(tweet)) return { ok: false, reason: 'reply' };
  if (!cfg.includeRetweets && isRetweet(tweet)) return { ok: false, reason: 'retweet' };

  if (cfg.minLikes > 0 && (tweet.likes || 0) < cfg.minLikes) return { ok: false, reason: 'likes' };
  if (cfg.minRetweets > 0 && (tweet.retweets || 0) < cfg.minRetweets) return { ok: false, reason: 'retweets' };
  if (cfg.minViews > 0 && (tweet.views || 0) < cfg.minViews) return { ok: false, reason: 'views' };

  if (cfg.requireCashtagOrCA && !hasCashtagOrCA(tweet.text)) return { ok: false, reason: 'no_ca' };

  if (cfg.keywords?.length) {
    const lower = tweet.text.toLowerCase();
    if (!cfg.keywords.some((k) => lower.includes(k))) return { ok: false, reason: 'keyword' };
  }

  return { ok: true };
}

/** Extract the first CA in a tweet, if any — surfaced on the card for one-tap tracking. */
export function extractCA(text) {
  const m = String(text || '').match(CA_RE);
  return m ? m[0] : null;
}
