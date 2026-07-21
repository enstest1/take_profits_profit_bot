/** Shared /calls embed builder — Discord replies with it; Telegram renders via notifier. */
import { EmbedBuilder } from 'discord.js';
import { loadDB, ensureDBSchema } from './dbStore.js';
import { chainBadge } from './chains.js';
import { lifecyclePrefix } from './signals/lifecycle.js';
import { fmtTime } from './tracker.js';

/**
 * @returns {EmbedBuilder|null} null when nothing is tracked
 */
export function buildCallsEmbed() {
  const db = ensureDBSchema(loadDB());
  const entries = Object.values(db.tokens || {})
    .sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
  if (entries.length === 0) return null;

  const STALE_MS = 15 * 60 * 1000;
  const lines = entries.slice(0, 40).map((entry) => {
    const last = entry.lastPrice ? Number(entry.lastPrice) : null;
    const call = entry.priceAtCall ? Number(entry.priceAtCall) : null;
    let multStr = '—';
    if (last && call && call > 0) {
      const mult = last / call;
      const stale = Date.now() - (entry.lastChecked || 0) > STALE_MS ? ' ⏳' : '';
      const backfillMark = entry.priceAtCallBackfilled ? ' ~' : '';
      multStr =
        (mult >= 2 ? '🚀 **' : mult >= 1 ? '📈 ' : '📉 ') +
        mult.toFixed(2) + 'x' +
        (mult >= 2 ? '**' : '') +
        stale + backfillMark;
    }
    const peakNote =
      entry.athLedger?.peakMultiple > 1.2
        ? ' · peaked ' + entry.athLedger.peakMultiple.toFixed(1) + 'x'
        : '';
    return chainBadge(entry.chain) + lifecyclePrefix(entry) + ' **' + entry.name + ' (' + entry.symbol + ')** — ' + multStr +
           peakNote +
           '\n└ **' + entry.postedBy + '** · ' + fmtTime(entry.postedAt);
  });

  const footer =
    'showing newest 40 of ' + entries.length +
    ' · ⏳ = stale (>15m since last poll)' +
    (entries.some((e) => e.priceAtCallBackfilled) ? ' · ~ = backfilled call price' : '');

  return new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle('Tracked Tokens')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: footer })
    .setTimestamp();
}
