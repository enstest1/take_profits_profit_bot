/** Velocity alert — price acceleration within window; no extra API calls. */
import { EmbedBuilder } from 'discord.js';
import { CFG } from './config.js';
import { lifecyclePrefix } from './lifecycle.js';
import { sendTokenAlert } from '../channelAlert.js';
import { saveDB } from '../dbStore.js';

function fmtUsd(n) {
  if (!n || isNaN(Number(n))) return '—';
  const num = Number(n);
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return '$' + (num / 1e3).toFixed(1) + 'K';
  return '$' + num.toFixed(4);
}

export async function evaluateVelocity(client, db, mint, entry, live, currentMult, now = Date.now()) {
  if (currentMult == null || currentMult < 1.5) return false;

  entry.velocityWindow = (entry.velocityWindow || []).slice(-9);
  entry.velocityWindow.push({ t: now, mult: currentMult });

  const windowStart = now - CFG.VELOCITY_WINDOW_MS;
  const inWindow = entry.velocityWindow.filter((w) => w.t >= windowStart);
  if (!inWindow.length) return false;
  const base = inWindow[0];
  if (now - base.t > CFG.VELOCITY_WINDOW_MS) return false;

  if (currentMult < base.mult * (1 + CFG.VELOCITY_MIN_GAIN)) return false;
  if (now - (entry.velocityAlertAt || 0) <= CFG.VELOCITY_COOLDOWN_MS) return false;

  const pct = Math.round((currentMult / base.mult - 1) * 100);
  const mins = Math.max(1, Math.round((now - base.t) / 60000));

  const embed = new EmbedBuilder()
    .setColor(0x00ff88)
    .setTitle(
      '🚀 VELOCITY — ' + lifecyclePrefix(entry) + entry.name + ' (' + entry.symbol + ')',
    )
    .setDescription(
      '+' + pct + '% in ' + mins + ' min · now ' + currentMult.toFixed(1) + 'x from @' +
      entry.postedBy + "'s call\n" +
      'Price ' + (live.price ? '$' + Number(live.price).toFixed(8) : '—') +
      ' · Liq ' + fmtUsd(live.liquidity) +
      ' · Vol24h ' + fmtUsd(live.volume24h),
    )
    .setTimestamp();

  const sent = await sendTokenAlert(client, db, mint, embed, 'velocity', 'velocity');
  if (sent) {
    entry.velocityAlertAt = now;
    saveDB(db);
    console.log('[velocity] ' + entry.symbol + ' +' + pct + '%/' + mins + 'm');
  }
  return sent;
}
