/** Call retest alert — token returns to OG call band after big peak. */
import { EmbedBuilder } from 'discord.js';
import { CFG } from './config.js';
import { lifecyclePrefix } from './lifecycle.js';
import { sendTokenAlert } from '../channelAlert.js';
import { saveDB } from '../dbStore.js';

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export async function evaluateRetest(client, db, mint, entry, _live, currentMult, _now = Date.now()) {
  const peak = Number(entry.peakMultiple) || 1;
  if (peak < CFG.RETEST_PEAK_MIN) return false;
  if (entry.retestAlertFired === true) return false;
  if (currentMult == null) return false;
  if (currentMult < CFG.RETEST_BAND[0] || currentMult > CFG.RETEST_BAND[1]) return false;

  const addr = entry.address || mint;

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(
      '🎯 CALL RETEST — ' + lifecyclePrefix(entry) + entry.name + ' (' + entry.symbol + ')',
    )
    .setDescription(
      'Back at OG call price (' + currentMult.toFixed(2) + 'x) after peaking ' +
      peak.toFixed(1) + 'x\n' +
      '`' + addr + '`\n' +
      'Called by @' + entry.postedBy + ' · ' + fmtDate(entry.postedAt) + ' · full round trip',
    )
    .setTimestamp();

  const sent = await sendTokenAlert(client, db, mint, embed, 'retest', 'retest');
  if (sent) {
    entry.retestAlertFired = true;
    saveDB(db);
    console.log('[retest] ' + entry.symbol + ' @ ' + currentMult.toFixed(2) + 'x');
  }
  return sent;
}

/** Reset retest flag when new ATH ≥ RETEST_PEAK_MIN (call from peak update path). */
export function maybeResetRetestOnAth(entry, storedPeak, newPeak) {
  if (newPeak <= storedPeak) return;
  if (newPeak >= CFG.RETEST_PEAK_MIN && entry.retestAlertFired === true) {
    entry.retestAlertFired = false;
  }
}
