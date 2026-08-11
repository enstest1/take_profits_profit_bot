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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startXFeed(client) {
  const cfg = getXFeedConfig();

  if (!cfg.enabled) {
    console.log('[xfeed] disabled (XFEED_ENABLED not true)');
    return;
  }
  if (!cfg.channelId) {
    console.error('[xfeed] XFEED_CHANNEL_ID not set — refusing to start');
    return;
  }
  if (!cfg.listIds.length) {
    console.error('[xfeed] XFEED_LIST_IDS is empty — refusing to start');
    return;
  }

  startXFeedPoller(async (items) => {
    for (const { tweet, listId } of items) {
      try {
        const embed = buildTweetCard(tweet, { listLabel: 'X list ' + listId });
        await sendChannelAlert(client, cfg.channelId, embed, 'xfeed');
        await sleep(1200);
      } catch (e) {
        console.error('[xfeed] post failed for ' + tweet.id + ':', e.message);
      }
    }
  });
}
