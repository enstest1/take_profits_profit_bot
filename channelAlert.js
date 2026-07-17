/** Channel alert send — respects alertGate; shared by poller + v3 signals. */
import { shouldSilenceAlerts, getAlertSilenceStatus } from './alertGate.js';
import { notifyWatchSubscribers } from './subscriptions.js';
import { bumpAlertSent } from './cycleStats.js';

export async function sendChannelAlert(client, channelId, embed, label = 'alert', files = null) {
  if (shouldSilenceAlerts()) {
    const st = getAlertSilenceStatus();
    const title = embed?.data?.title || label;
    console.log('[silence/' + st.reason + '] skipped: ' + title);
    return false;
  }
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(files && files.length ? { embeds: [embed], files } : { embeds: [embed] });
    bumpAlertSent();
    return true;
  } catch (e) {
    console.error('[alert] send failed to channel ' + channelId + ':', e.message);
    return false;
  }
}

/** Send channel alert + optional watch-token DMs. */
export async function sendTokenAlert(client, db, mint, embed, alertKind, label = 'alert', files = null) {
  const entry = db.tokens[mint];
  if (entry?.canary) {
    console.log('[canary] suppressed alert for ' + mint);
    return false;
  }
  const sent = entry?.alertChannelId
    ? await sendChannelAlert(client, entry.alertChannelId, embed, label, files)
    : false;
  if (sent && entry) {
    notifyWatchSubscribers(client, db, mint, embed, alertKind, entry.postedByUserId).catch((e) =>
      console.error('[subscriptions] watch notify:', e.message),
    );
  }
  return sent;
}
