/** Multi-channel confluence — reposts stay silent but count toward alert. */
import { EmbedBuilder } from 'discord.js';
import { CFG } from './config.js';
import { sendChannelAlert } from '../channelAlert.js';
import { saveDB } from '../dbStore.js';

export async function recordChannelSighting(client, db, mint, channelId, now = Date.now()) {
  const entry = db.tokens[mint];
  if (!entry) return;

  entry.callChannels = entry.callChannels || [
    { channelId: entry.alertChannelId, at: entry.postedAt },
  ];
  if (!entry.callChannels.some((c) => c.channelId === channelId)) {
    entry.callChannels.push({ channelId, at: now });
    entry.callChannels = entry.callChannels.slice(-10);
  }

  const inWindow = entry.callChannels.filter((c) => now - c.at <= CFG.CONFLUENCE_WINDOW_MS);
  const uniqueChannels = new Set(inWindow.map((c) => c.channelId));

  if (uniqueChannels.size >= CFG.CONFLUENCE_MIN_CHANNELS && !entry.confluenceAlertFired) {
    entry.confluenceAlertFired = true;
    const live = entry.lastPrice && entry.priceAtCall
      ? Number(entry.lastPrice) / Number(entry.priceAtCall)
      : null;
    const spanMins = inWindow.length
      ? Math.round((now - Math.min(...inWindow.map((c) => c.at))) / 60000)
      : 0;

    const embed = new EmbedBuilder()
      .setColor(0xff6600)
      .setTitle('🔥 CONFLUENCE — ' + entry.name + ' (' + entry.symbol + ')')
      .setDescription(
        'Called in ' + uniqueChannels.size + ' channels within ' + spanMins + ' min\n' +
        'OG call: @' + entry.postedBy +
        (live != null ? ' · currently ' + live.toFixed(1) + 'x' : ''),
      )
      .setTimestamp();

    const sent = await sendChannelAlert(client, entry.alertChannelId, embed, 'confluence');
    if (sent) {
      saveDB(db);
      console.log('[confluence] ' + entry.symbol + ' ' + uniqueChannels.size + ' channels');
    }
  }
}
