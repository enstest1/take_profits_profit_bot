/**
 * xfeed/config.js — live X post/reply feed settings.
 *
 * Watches one or more X lists and posts a card per new tweet. Distinct from
 * digest/ (once-daily LLM summary of the same source) and xradar/ (follows).
 *
 * VOLUME WARNING: unfiltered, an active 400-account list can produce hundreds
 * of cards a day. The filters below all default to OFF so behaviour matches
 * "every tweet", but they exist so you can dial it back from Railway without a
 * deploy once you see real throughput.
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

export function getXFeedConfig() {
  return {
    enabled: envBool('XFEED_ENABLED', false),
    channelId: process.env.XFEED_CHANNEL_ID || '',

    /** X list ids to watch, comma separated. */
    listIds: (process.env.XFEED_LIST_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),

    pollSec: envInt('XFEED_POLL_SEC', 120),
    tweetsPerPoll: envInt('XFEED_TWEETS_PER_POLL', 40),

    /** Ignore anything older than this on the first poll after a restart. */
    maxAgeMin: envInt('XFEED_MAX_AGE_MIN', 30),

    /** Safety valve: never post more than this many cards in one poll cycle. */
    maxPerCycle: envInt('XFEED_MAX_PER_CYCLE', 15),

    // ── optional filters (all off by default = every tweet) ──
    includeReplies: envBool('XFEED_INCLUDE_REPLIES', true),
    includeRetweets: envBool('XFEED_INCLUDE_RETWEETS', false),
    minLikes: envInt('XFEED_MIN_LIKES', 0),
    minRetweets: envInt('XFEED_MIN_RETWEETS', 0),
    minViews: envInt('XFEED_MIN_VIEWS', 0),
    /** Only post tweets containing a contract address or $TICKER. */
    requireCashtagOrCA: envBool('XFEED_REQUIRE_CA', false),
    /** Comma-separated keywords; if set, a tweet must contain one of them. */
    keywords: (process.env.XFEED_KEYWORDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}
