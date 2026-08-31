/** Channel alert send — respects alertGate; shared by poller + v3 signals. */
import { shouldSilenceAlerts, getAlertSilenceStatus } from './alertGate.js';
import { notifyWatchSubscribers } from './subscriptions.js';
import { bumpAlertSent } from './cycleStats.js';
import { logValuationAudit } from './valuationAudit.js';
import { renderEmbedForTelegram, sendTelegramMessage } from './notifier.js';
import { isBlockedChannel } from './blockedChannels.js';
import { withTimeout } from './asyncTimeout.js';

const DISCORD_SEND_TIMEOUT_MS = Number(process.env.DISCORD_SEND_TIMEOUT_MS) || 20_000;

export async function sendChannelAlert(client, channelId, embed, label = 'alert', files = null, opts = {}) {
  if (isBlockedChannel(channelId)) {
    return false;
  }
  // First-call confirms (token CA / NFT collection URL) still post during comeback.
  if (!opts.bypassSilence && shouldSilenceAlerts()) {
    const st = getAlertSilenceStatus();
    const title = embed?.data?.title || label;
    console.log('[silence/' + st.reason + '] skipped: ' + title);
    return false;
  }
  if (process.env.PLATFORM === 'telegram') {
    const payload = renderEmbedForTelegram(embed);
    if (files && files.length && files[0]?.attachment) {
      payload.photoBuffer = files[0].attachment;
      payload.photoName = files[0].name || 'chart.png';
    }
    // HTML mentions from xradar/xfeed pings — prepended so the card still posts without them.
    if (opts.content) {
      payload.text = opts.content + (payload.text ? '\n' + payload.text : '');
    }
    const ok = await sendTelegramMessage(channelId, payload);
    if (ok) bumpAlertSent();
    return ok;
  }
  try {
    const channel = await withTimeout(
      client.channels.fetch(channelId),
      DISCORD_SEND_TIMEOUT_MS,
      'channel.fetch ' + channelId,
    );
    const payload = files && files.length ? { embeds: [embed], files } : { embeds: [embed] };
    // Optional @mentions (xradar/xfeed pings). Cards still send when content is omitted.
    if (opts.content) {
      payload.content = opts.content;
      if (opts.allowedMentions) payload.allowedMentions = opts.allowedMentions;
    }
    await withTimeout(
      channel.send(payload),
      DISCORD_SEND_TIMEOUT_MS,
      'channel.send ' + channelId,
    );
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
  const snap = entry?.lastValuation || null;
  logValuationAudit(alertKind || label, entry?.symbol || mint, snap);

  const sent = entry?.alertChannelId
    ? await sendChannelAlert(client, entry.alertChannelId, embed, label, files)
    : false;
  if (sent && entry && process.env.PLATFORM !== 'telegram') {
    notifyWatchSubscribers(client, db, mint, embed, alertKind, entry.postedByUserId).catch((e) =>
      console.error('[subscriptions] watch notify:', e.message),
    );
  }
  return sent;
}
