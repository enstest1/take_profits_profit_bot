/** Weekly recap — DB-only, scheduled Sunday UTC. */
import { EmbedBuilder } from 'discord.js';
import { CFG } from './signals/config.js';
import { rebuildCallerStats } from './callerStats.js';
import { sendChannelAlert } from './channelAlert.js';

const SUMMARY_CHANNEL_ID = process.env.SUMMARY_CHANNEL_ID || '1452152164699869298';

function weekRangeLabel(now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 7);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return fmt(start) + ' – ' + fmt(end);
}

function callsThisWeek(db, now = Date.now()) {
  const since = now - 7 * 24 * 60 * 60 * 1000;
  return Object.entries(db.tokens || {}).filter(([, e]) => (e.postedAt || 0) >= since);
}

export async function postWeeklyRecap(client, db) {
  rebuildCallerStats(db);
  const now = Date.now();
  const weekCalls = callsThisWeek(db, now);
  const sections = [];
  sections.push('📅 WEEKLY RECAP — ' + weekRangeLabel());

  if (weekCalls.length === 0) {
    sections.push('📊 Week totals: 0 calls');
    const embed = new EmbedBuilder()
      .setColor(0x7c3aed)
      .setDescription(sections.join('\n'))
      .setTimestamp();
    await sendChannelAlert(client, SUMMARY_CHANNEL_ID, embed, 'weekly-recap');
    return;
  }

  let best = null;
  let bestPeak = 0;
  let fastest2x = null;
  let fastestMins = Infinity;
  let biggestRoundTrip = null;

  for (const [, e] of weekCalls) {
    const peak = Number(e.peakMultiple) || 1;
    if (peak > bestPeak) {
      bestPeak = peak;
      best = e;
    }
    if (peak >= 2 && e.athLedger?.minsToPeak != null && e.athLedger.minsToPeak < fastestMins) {
      fastestMins = e.athLedger.minsToPeak;
      fastest2x = e;
    }
    const live = e.lastPrice && e.priceAtCall ? Number(e.lastPrice) / Number(e.priceAtCall) : null;
    if (peak >= 3 && live != null && live < 0.5) {
      if (!biggestRoundTrip || peak > (Number(biggestRoundTrip.peakMultiple) || 0)) {
        biggestRoundTrip = { entry: e, live };
      }
    }
  }

  if (best) {
    const mins = best.athLedger?.minsToPeak;
    sections.push(
      '👑 Call of the week: $' + best.symbol + ' by @' + best.postedBy + ' — ' +
      bestPeak.toFixed(1) + 'x' +
      (mins != null ? ', peaked in ' + Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : ''),
    );
  }
  if (fastest2x) {
    sections.push(
      '⚡ Fastest 2x: $' + fastest2x.symbol + ' by @' + fastest2x.postedBy +
      ' — 2x in ' + fastestMins + ' min',
    );
  }
  if (biggestRoundTrip) {
    sections.push(
      '🎢 Biggest round trip: $' + biggestRoundTrip.entry.symbol + ' — peaked ' +
      (Number(biggestRoundTrip.entry.peakMultiple) || 0).toFixed(1) + 'x, now ' +
      biggestRoundTrip.live.toFixed(1) + 'x. F.',
    );
  }

  const callers = Object.entries(db.callers || {})
    .filter(([, c]) => c.totalCalls >= 3)
    .sort((a, b) => (b[1].hits2x / b[1].totalCalls) - (a[1].hits2x / a[1].totalCalls))
    .slice(0, 5);
  if (callers.length) {
    sections.push(
      '🏆 Leaderboard: ' +
      callers.map(([id, c]) => '@' + c.name.split('#')[0] + ' ' +
        Math.round((c.hits2x / c.totalCalls) * 100) + '%').join(' · '),
    );
  }

  const tagGroups = {};
  for (const [, e] of weekCalls) {
    const tags = e.tags?.length ? e.tags : ['untagged'];
    for (const t of tags) {
      if (t === 'untagged' && (!e.tags || !e.tags.length)) {
        tagGroups.untagged = tagGroups.untagged || [];
        tagGroups.untagged.push(e);
      } else if (t !== 'untagged') {
        tagGroups[t] = tagGroups[t] || [];
        tagGroups[t].push(e);
      }
    }
  }
  const metaLines = [];
  for (const [tag, entries] of Object.entries(tagGroups)) {
    if (tag === 'untagged' && entries.length < 5) continue;
    const hits = entries.filter((e) => (Number(e.peakMultiple) || 1) >= 2).length;
    const avg =
      entries.reduce((s, e) => s + (Number(e.peakMultiple) || 1), 0) / entries.length;
    metaLines.push(
      tag + ' — ' + entries.length + ' calls, ' +
      Math.round((hits / entries.length) * 100) + '% hit, ' + avg.toFixed(1) + 'x avg',
    );
  }
  if (metaLines.length) sections.push('🏷️ Meta report: ' + metaLines.join(' · '));

  const hit2x = weekCalls.filter(([, e]) => (Number(e.peakMultiple) || 1) >= 2).length;
  const rugged = weekCalls.filter(([, e]) => {
    const age = now - (e.postedAt || 0);
    return age > CFG.CALLER_RUG_AGE_MS && (Number(e.peakMultiple) || 1) < 0.5;
  }).length;
  sections.push('📊 Week totals: ' + weekCalls.length + ' calls · ' + hit2x + ' hit 2x+ · ' + rugged + ' rugged');

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setDescription(sections.join('\n').slice(0, 4000))
    .setTimestamp();
  await sendChannelAlert(client, SUMMARY_CHANNEL_ID, embed, 'weekly-recap');
  console.log('[recap] weekly posted');
}

let lastRecapWeek = null;

export function checkWeeklyRecap(client, db) {
  const now = new Date();
  if (now.getUTCDay() !== CFG.RECAP_DAY_UTC) return;
  if (now.getUTCHours() !== 12 || now.getUTCMinutes() >= 5) return;
  const weekKey = now.toISOString().slice(0, 10);
  if (lastRecapWeek === weekKey) return;
  lastRecapWeek = weekKey;
  postWeeklyRecap(client, db).catch((e) => console.error('[recap] error:', e.message));
}
