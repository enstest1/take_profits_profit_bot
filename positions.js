/** Personal position tracking — /ape /mybags + poll-tier DMs. */
import { EmbedBuilder } from 'discord.js';
import { CFG } from './signals/config.js';
import { LIFECYCLE_EMOJI } from './signals/lifecycle.js';
import { sendDM } from './dmRouter.js';
import { saveDB } from './dbStore.js';
import { resolveUserInputToKey } from './chains.js';

const CALLS_STALE_MS = 15 * 60 * 1000;

export function setPosition(db, mint, userId, entryPrice) {
  const entry = db.tokens[mint];
  if (!entry) return null;
  entry.positions = entry.positions || {};
  entry.positions[userId] = {
    entry: String(entryPrice),
    at: Date.now(),
    tiersFired: [],
    deadNotified: false,
  };
  return entry.positions[userId];
}

export function resolveTrackedMint(db, rawInput) {
  return resolveUserInputToKey(db, rawInput);
}

export async function evaluatePersonalPositions(
  client,
  db,
  mint,
  entry,
  live,
  ogMult,
  now = Date.now(),
) {
  const positions = entry.positions || {};
  const livePrice = live?.price == null || live.price === '' ? null : Number(live.price);
  if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) return false;

  let anySent = false;
  for (const [userId, pos] of Object.entries(positions)) {
    const entryPx = Number(pos.entry);
    if (!Number.isFinite(entryPx) || entryPx <= 0) continue;
    const personalMult = livePrice / entryPx;
    const tiersFired = pos.tiersFired || [];
    const newTiers = CFG.POSITION_TIERS.filter(
      (t) => personalMult >= t && !tiersFired.includes(t),
    );
    if (!newTiers.length) continue;
    const tier = Math.max(...newTiers);
    pos.tiersFired = [...new Set([...tiersFired, ...newTiers])].sort((a, b) => a - b);

    const lc = entry.lifecycle ? LIFECYCLE_EMOJI[entry.lifecycle] || '' : '';
    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle('💰 Your bag: ' + entry.symbol + ' hit ' + tier + 'x from YOUR entry')
      .setDescription(
        'Your entry $' + entryPx.toFixed(8) + ' → now $' + livePrice.toFixed(8) +
        ' (' + personalMult.toFixed(1) + 'x)\n' +
        'OG call by @' + entry.postedBy + ' is at ' +
        (ogMult != null ? ogMult.toFixed(1) + 'x' : '—') +
        (lc ? ' · Lifecycle: ' + lc + ' ' + (entry.lifecycle || '') : ''),
      )
      .setTimestamp();

    const sent = await sendDM(
      client,
      userId,
      embed,
      userId + ':' + mint + ':tier' + tier,
      60_000,
    );
    if (sent) anySent = true;
  }
  if (anySent) saveDB(db);
  return anySent;
}

export function buildMyBagsLines(db, userId) {
  const rows = [];
  for (const [mint, entry] of Object.entries(db.tokens || {})) {
    const pos = entry.positions?.[userId];
    if (!pos) continue;
    const live = entry.lastPrice ? Number(entry.lastPrice) : null;
    const entryPx = Number(pos.entry);
    let multStr = '—';
    if (live && entryPx > 0) {
      const m = live / entryPx;
      const stale = Date.now() - (entry.lastChecked || 0) > CALLS_STALE_MS ? ' ⏳' : '';
      multStr = m.toFixed(1) + 'x from your entry' + stale;
    }
    const ogMult =
      entry.priceAtCall && live
        ? (live / Number(entry.priceAtCall)).toFixed(1) + 'x'
        : '—';
    const lc = entry.lifecycle ? LIFECYCLE_EMOJI[entry.lifecycle] || '🌱' : '🌱';
    rows.push({
      mult: live && entryPx > 0 ? live / entryPx : 0,
      line: lc + ' **' + entry.symbol + '** — ' + multStr + ' (OG call ' + ogMult + ')',
    });
  }
  rows.sort((a, b) => b.mult - a.mult);
  return rows;
}
