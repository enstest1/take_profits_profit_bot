/** Liquidity divergence — price up but liquidity down vs call baseline.
 *  Evaluation stays in code for later; Discord alerts are off by default
 *  (set LIQ_DIVERGENCE_ALERTS=1 to re-enable messages). */
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
  return '$' + num.toFixed(0);
}

function alertsEnabled() {
  const v = process.env.LIQ_DIVERGENCE_ALERTS;
  return v === '1' || v === 'true' || v === 'yes';
}

export async function evaluateLiquidityDivergence(
  client,
  db,
  mint,
  entry,
  live,
  currentMult,
  now = Date.now(),
) {
  const liveLiq = Number(live.liquidity);
  if (!Number.isFinite(liveLiq) || liveLiq <= 0) return false;

  if (entry.liquidityAtCall == null && liveLiq > 0) {
    entry.liquidityAtCall = liveLiq;
    return false;
  }

  const base = Number(entry.liquidityAtCall);
  if (!Number.isFinite(base) || base <= 0) return false;
  if (currentMult == null || currentMult < CFG.LIQ_DIVERGENCE_MIN_MULT) return false;
  if (liveLiq > base * (1 - CFG.LIQ_DIVERGENCE_DROP_PCT)) return false;
  if (now - (entry.liqDivergenceAlertAt || 0) <= CFG.LIQ_DIVERGENCE_COOLDOWN_MS) return false;

  const dropPct = Math.round((1 - liveLiq / base) * 100);

  // Keep detection + cooldown bookkeeping; skip Discord unless explicitly re-enabled.
  if (!alertsEnabled()) {
    entry.liqDivergenceAlertAt = now;
    saveDB(db);
    console.log('[liqdiv] silent ' + entry.symbol + ' -' + dropPct + '% liq (alerts off)');
    return false;
  }

  const embed = new EmbedBuilder()
    .setColor(0xff9900)
    .setTitle(
      '⚠️ LIQUIDITY DIVERGENCE — ' + lifecyclePrefix(entry) + entry.name + ' (' + entry.symbol + ')',
    )
    .setDescription(
      'Price ' + currentMult.toFixed(1) + 'x from call but liquidity down ' + dropPct +
      '% since call (' + fmtUsd(base) + ' → ' + fmtUsd(liveLiq) + ')\n' +
      'Possible distribution / rug-in-progress. Not financial advice — check the chart.',
    )
    .setTimestamp();

  const sent = await sendTokenAlert(client, db, mint, embed, 'liqdiv', 'liq-divergence');
  if (sent) {
    entry.liqDivergenceAlertAt = now;
    saveDB(db);
    console.log('[liqdiv] ' + entry.symbol + ' -' + dropPct + '% liq');
  }
  return sent;
}
