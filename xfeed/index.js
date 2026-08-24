/**
 * xfeed/index.js — wiring entry point.
 *
 * startXFeed(client) runs only when XFEED_ENABLED=true. Posts through
 * sendChannelAlert, so Discord and Telegram both work with no extra code.
 *
 * Cards are sent sequentially with a small gap — a burst of 15 embeds fired at
 * once will trip Discord's per-channel rate limit and, on Telegram, the ~20/min
 * group ceiling.
 */

import { getXFeedConfig } from './config.js';
import { startXFeedPoller } from './poller.js';
import { buildTweetCard } from './card.js';
import { sendChannelAlert } from '../channelAlert.js';
import { getCredentials } from '../xradar/xClient.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startXFeed(client) {
  const cfg = getXFeedConfig();

  if (!cfg.enabled) {
    console.log('[xfeed] disabled (XFEED_ENABLED not true)');
    return;
  }
  const liveRoutes = cfg.routes.filter((r) => r.listId && r.channelId);
  if (!liveRoutes.length && !cfg.watchRadarHandles && !cfg.handles.length) {
    console.error('[xfeed] no list→channel routes — set XFEED_ROUTES or XFEED_LIST_IDS + XFEED_CHANNEL_ID');
    return;
  }

  try {
    getCredentials();
  } catch (e) {
    console.error('[xfeed] ' + e.message + ' — refusing to start');
    return;
  }

  console.log(
    '[xfeed] routes: ' +
      liveRoutes.map((r) => r.listId + ' → ' + r.channelId).join(', '),
  );

  startXFeedPoller(async (items) => {
    for (const item of items) {
      const channels = [...new Set((item.channelIds || []).filter(Boolean))];
      if (!channels.length && cfg.channelId) channels.push(cfg.channelId);
      const kind = item.kind === 'reply' ? 'reply' : 'post';
      const embed = buildTweetCard(item.tweet, {
        listLabel: (item.source || 'X') + ' · ' + kind,
      });
      for (const channelId of channels) {
        try {
          await sendChannelAlert(client, channelId, embed, 'xfeed');
          await sleep(1200);
        } catch (e) {
          console.error('[xfeed] post failed for ' + item.tweet.id + ' → ' + channelId + ':', e.message);
        }
      }
    }
  });
}
