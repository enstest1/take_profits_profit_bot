/**
 * xradar/index.js — follow-radar wiring entry point.
 *
 * startXRadar(client) runs only when XRADAR_ENABLED=true. Posts through
 * sendChannelAlert so Discord (and Telegram, if that service ever flips the
 * flag) both work. xfeed reuses xradar/xClient.js and reads the same
 * db.xRadar.users watch list for posts/replies.
 */

import { getCredentials } from './xClient.js';
import { getXRadarConfig } from './config.js';
import { seedHandles } from './store.js';
import { startXRadarPoller } from './monitor.js';
import { buildFollowCard } from './card.js';
import { sendChannelAlert } from '../channelAlert.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startXRadar(client) {
  const cfg = getXRadarConfig();

  if (!cfg.enabled) {
    console.log('[xradar] disabled (XRADAR_ENABLED not true)');
    return;
  }
  if (!cfg.channelId) {
    console.error('[xradar] XRADAR_CHANNEL_ID not set — refusing to start');
    return;
  }

  try {
    getCredentials();
  } catch (e) {
    console.error('[xradar] ' + e.message + ' — refusing to start');
    return;
  }

  seedHandles(cfg.handles);

  console.log('[xradar] posting follow cards to channel ' + cfg.channelId);

  startXRadarPoller(async (events) => {
    for (const { watcher, followed } of events) {
      try {
        const embed = buildFollowCard(watcher, followed);
        await sendChannelAlert(client, cfg.channelId, embed, 'xradar');
        await sleep(1200);
      } catch (e) {
        console.error('[xradar] post failed for @' + (followed?.username || '?') + ':', e.message);
      }
    }
  });
}

export { xwatchCommand, handleXwatch } from './commands.js';
