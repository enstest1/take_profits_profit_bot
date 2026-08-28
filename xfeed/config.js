/**
 * xfeed/config.js — live X post/reply feed settings.
 *
 * Posts/comments come from X lists. Each list posts to the Discord channel in
 * XFEED_ROUTES (listId:channelId). Legacy fallback: every XFEED_LIST_IDS entry
 * goes to XFEED_CHANNEL_ID.
 *
 * /xwatch syncs handles onto the dest's XFEED_ROUTES list so Discord users do
 * not edit the list by hand. Follow cards are xradar/, not this module.
 */

import { parseHandleList, scannerChannelId } from '../xradar/config.js';

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

/**
 * Parse `listId:channelId,listId:channelId`. Same list may appear twice to fan
 * out to two channels on one bot (rare — usually each community is its own bot).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseFeedRoutes(env = process.env) {
  const routes = [];
  for (const part of String(env.XFEED_ROUTES || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const colon = s.indexOf(':');
    if (colon <= 0) continue;
    const listId = s.slice(0, colon).trim();
    const channelId = s.slice(colon + 1).trim();
    if (listId && channelId) routes.push({ listId, channelId });
  }
  if (routes.length) return routes;

  const channelId =
    env.XFEED_CHANNEL_ID?.trim() ||
    env.X_SCANNER_CHANNEL_ID?.trim() ||
    '';
  const listIds = String(env.XFEED_LIST_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!channelId) return [];
  return listIds.map((listId) => ({ listId, channelId }));
}

export function getXFeedConfig() {
  const routes = parseFeedRoutes();
  const listIds = [...new Set(routes.map((r) => r.listId))];

  return {
    enabled: envBool('XFEED_ENABLED', false),
    channelId: scannerChannelId('XFEED_CHANNEL_ID'),
    routes,
    listIds,

    /** Extra handles to poll even if they are not on a list. */
    handles: parseHandleList(process.env.XFEED_HANDLES),
    /** Also poll /xwatch timelines. Default off — the list is the post source. */
    watchRadarHandles: envBool('XFEED_WATCH_RADAR_HANDLES', false),

    pollSec: envInt('XFEED_POLL_SEC', 120),
    tweetsPerPoll: envInt('XFEED_TWEETS_PER_POLL', 40),
    maxAgeMin: envInt('XFEED_MAX_AGE_MIN', 30),
    maxPerCycle: envInt('XFEED_MAX_PER_CYCLE', 15),

    includeReplies: envBool('XFEED_INCLUDE_REPLIES', true),
    includeRetweets: envBool('XFEED_INCLUDE_RETWEETS', false),
    minLikes: envInt('XFEED_MIN_LIKES', 0),
    minRetweets: envInt('XFEED_MIN_RETWEETS', 0),
    minViews: envInt('XFEED_MIN_VIEWS', 0),
    requireCashtagOrCA: envBool('XFEED_REQUIRE_CA', false),
    keywords: (process.env.XFEED_KEYWORDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}
