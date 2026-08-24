/**
 * xfeed/poller.js — polls the watched X lists and emits new tweets.
 *
 * One getListTimeline call per list per cycle (cheap — a list of 400 accounts
 * costs the same as a list of 4), dedup by tweet id, filter, then hand the
 * survivors to the caller in chronological order.
 *
 * First run after a fresh volume records what it sees WITHOUT posting, so
 * standing up the feature doesn't dump 40 backfilled tweets into the channel.
 */

import { getListTimeline, getUserTimeline } from '../xradar/xClient.js';
import { getXFeedConfig } from './config.js';
import { shouldPost, isReply } from './filter.js';
import { isSeen, markSeen, isFirstRun } from './store.js';
import { loadDB, ensureDBSchema } from '../dbStore.js';

/** Handles from env plus (optionally) whoever /xwatch added. */
function watchedHandles(cfg) {
  const extra = [...(cfg.handles || [])];
  if (!cfg.watchRadarHandles) return [...new Set(extra)];
  const fromRadar = Object.keys(ensureDBSchema(loadDB()).xRadar?.users || {});
  return [...new Set([...extra, ...fromRadar])];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _running = false;
let _timer = null;

function collectTweets(tweets, cfg, dropped, collected, meta) {
  for (const t of tweets || []) {
    if (!t?.id || isSeen(t.id)) continue;
    const verdict = shouldPost(t, cfg);
    if (!verdict.ok) {
      dropped[verdict.reason] = (dropped[verdict.reason] || 0) + 1;
      // still mark as seen so a filtered tweet isn't re-evaluated forever
      collected.push({ tweet: t, post: false });
      continue;
    }
    collected.push({
      tweet: t,
      post: true,
      listId: meta.listId || '',
      channelIds: meta.channelIds || [],
      source: meta.source,
      kind: isReply(t) ? 'reply' : 'post',
    });
  }
}

/** One poll cycle. → { posted: Tweet[], stats } — never throws. */
export async function pollOnce() {
  const cfg = getXFeedConfig();
  const firstRun = isFirstRun();
  const collected = [];
  const dropped = {};

  for (const listId of cfg.listIds) {
    try {
      const tweets = await getListTimeline(listId, { count: cfg.tweetsPerPoll });
      const channelIds = cfg.routes.filter((r) => r.listId === listId).map((r) => r.channelId);
      collectTweets(tweets, cfg, dropped, collected, {
        source: 'list ' + listId,
        listId,
        channelIds,
      });
    } catch (e) {
      console.error('[xfeed] list ' + listId + ' failed:', e.message);
    }
    await sleep(800);
  }

  for (const handle of watchedHandles(cfg)) {
    try {
      const tweets = await getUserTimeline(handle, { count: cfg.tweetsPerPoll });
      collectTweets(tweets, cfg, dropped, collected, {
        source: '@' + handle,
        channelIds: cfg.channelId ? [cfg.channelId] : [],
      });
    } catch (e) {
      console.error('[xfeed] @' + handle + ' failed:', e.message);
    }
    await sleep(800);
  }

  // Always record everything we looked at, whether or not it gets posted.
  if (collected.length) markSeen(collected.map((c) => c.tweet.id));

  if (firstRun) {
    console.log('[xfeed] first run — recorded ' + collected.length + ' tweet(s) as baseline, posting none');
    return { posted: [], stats: { seen: collected.length, posted: 0, firstRun: true, dropped } };
  }

  // Oldest first so the channel reads chronologically.
  const toPost = collected
    .filter((c) => c.post)
    .sort((a, b) => (a.tweet.timestamp || 0) - (b.tweet.timestamp || 0))
    .slice(0, cfg.maxPerCycle);

  return {
    posted: toPost,
    stats: { seen: collected.length, posted: toPost.length, firstRun: false, dropped },
  };
}

export function startXFeedPoller(onTweets) {
  const cfg = getXFeedConfig();
  if (_timer) return;

  async function tick() {
    if (_running) {
      console.warn('[xfeed] previous poll still running — skipping');
      return;
    }
    _running = true;
    try {
      const { posted, stats } = await pollOnce();
      if (posted.length) await onTweets(posted);
      if (process.env.XFEED_DEBUG === 'true') {
        const drops = Object.entries(stats.dropped).map(([k, v]) => k + '=' + v).join(' ');
        console.log('[xfeed] seen ' + stats.seen + ', posted ' + stats.posted + (drops ? ' | dropped: ' + drops : ''));
      }
    } catch (e) {
      console.error('[xfeed] poll failed:', e.message);
    } finally {
      _running = false;
    }
  }

  setTimeout(() => void tick(), 20_000); // let the bot boot first
  _timer = setInterval(() => void tick(), cfg.pollSec * 1000);
  _timer.unref?.();
  console.log(
    '[xfeed] poller started — every ' + cfg.pollSec + 's · ' +
      cfg.listIds.length + ' list(s) · radar-handles=' + cfg.watchRadarHandles,
  );
}

export function stopXFeedPoller() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
