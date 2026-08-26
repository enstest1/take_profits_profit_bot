// archive.js — channel discovery, resumable full-history backfill (threads
// included), and live message sync for the knowledge bot.

import { isBlockedChannel } from '../blockedChannels.js';
import {
  upsertChannel,
  setBackfillCursor,
  markBackfillDone,
  getChannelRow,
  insertMessagesBatch,
  insertMessage,
  markMessageEdited,
  markMessageDeleted,
} from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_DELAY_MS = 450; // REST kindness between history pages
const PAGE_SIZE = 100;
/** Discord epoch — snowflake >> 22 is milliseconds after this. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/**
 * First-run backfill cap. Default 72h so we do not page years of history
 * on the same token as the profit bot. `0` = unlimited (full history later).
 * @param {string|undefined} raw
 * @returns {number}
 */
export function parseBackfillMaxAgeHours(raw = process.env.KB_BACKFILL_MAX_AGE_HOURS) {
  if (raw == null || String(raw).trim() === '') return 72;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 72;
  return n;
}

/**
 * Unix-ms floor for backfill inserts. `0` means no floor (full history).
 * @returns {number}
 */
export function backfillCutoffMs() {
  const hours = parseBackfillMaxAgeHours();
  if (hours === 0) return 0;
  return Date.now() - hours * 3600 * 1000;
}

/**
 * @param {string} id Discord snowflake
 * @returns {number} created-at unix ms, or 0 if unparseable
 */
export function snowflakeToMs(id) {
  try {
    return Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH_MS));
  } catch {
    return 0;
  }
}

/**
 * Skip paging when the channel's last message is already older than the lookback.
 * Unknown lastMessageId still gets a fetch (fail open).
 * @param {{ lastMessageId?: string|null }} ch
 * @param {number} cutoffMs
 * @returns {boolean}
 */
export function channelQuietBefore(ch, cutoffMs) {
  if (!cutoffMs) return false;
  const lastId = ch?.lastMessageId;
  if (!lastId) return false;
  const ts = snowflakeToMs(lastId);
  return ts > 0 && ts < cutoffMs;
}

/**
 * `arr` is newest → oldest. Stop at the first message older than the floor.
 * @param {Array<{ createdTimestamp?: number, created_ts?: number }>} arr
 * @param {number} cutoffMs
 * @returns {{ keep: typeof arr, hitFloor: boolean }}
 */
export function sliceToLookback(arr, cutoffMs) {
  if (!cutoffMs) return { keep: arr, hitFloor: false };
  const keep = [];
  for (const m of arr) {
    const ts = m.createdTimestamp ?? m.created_ts ?? 0;
    if (ts < cutoffMs) return { keep, hitFloor: true };
    keep.push(m);
  }
  return { keep, hitFloor: false };
}

/**
 * Guild to archive. Standalone bot uses KB_GUILD_ID; profit-bot wiring copies GUILD_ID.
 * @returns {string}
 */
export function kbGuildId() {
  return (process.env.KB_GUILD_ID || process.env.GUILD_ID || '').trim();
}

function includeList() {
  const raw = (process.env.KB_CHANNEL_IDS || 'all').trim();
  return raw.toLowerCase() === 'all' ? 'all' : raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function excludeSet() {
  return new Set(
    (process.env.KB_EXCLUDE_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
}

export function msgToRow(m) {
  const embeds = m.embeds?.length
    ? JSON.stringify(
        m.embeds.slice(0, 4).map((e) => ({ t: e.title || null, d: e.description || null, u: e.url || null })),
      )
    : null;
  const attachments = m.attachments?.size
    ? JSON.stringify([...m.attachments.values()].map((a) => a.name))
    : null;
  return {
    msg_id: m.id,
    channel_id: m.channelId,
    guild_id: m.guildId || null,
    author_id: m.author?.id || null,
    author_name: m.author?.username || 'unknown',
    is_bot: m.author?.bot ? 1 : 0,
    content: m.content || '',
    embeds,
    attachments,
    reply_to: m.reference?.messageId || null,
    created_ts: m.createdTimestamp,
  };
}

// Discover every text-capable channel + thread the bot should archive.
export async function discoverChannels(client) {
  const guildId = kbGuildId();
  if (!guildId) throw new Error('KB_GUILD_ID / GUILD_ID is not set');
  const guild = await client.guilds.fetch(guildId);
  const all = await guild.channels.fetch();
  const inc = includeList();
  const exc = excludeSet();
  const targets = [];

  for (const ch of all.values()) {
    if (!ch) continue;
    if (exc.has(ch.id) || isBlockedChannel(ch.id)) continue;
    const included = inc === 'all' || inc.includes(ch.id) || (ch.parentId && inc.includes(ch.parentId));

    // Plain text-ish channels with message history
    if (ch.isTextBased?.() && typeof ch.messages?.fetch === 'function') {
      if (included) targets.push({ channel: ch, name: '#' + ch.name, parent: null });
    }

    // Threads (text channels + forum posts). Private archived threads are skipped.
    if (ch.threads?.fetchActive) {
      try {
        const active = await ch.threads.fetchActive();
        const archived = await ch.threads.fetchArchived({ limit: 100 }).catch(() => ({ threads: new Map() }));
        for (const th of [...active.threads.values(), ...archived.threads.values()]) {
          if (exc.has(th.id) || isBlockedChannel(th.id)) continue;
          if (inc !== 'all' && !inc.includes(th.id) && !inc.includes(ch.id)) continue;
          targets.push({ channel: th, name: '#' + ch.name + ' › ' + th.name, parent: ch.name });
        }
      } catch (e) {
        console.log('[archive] thread listing failed for #' + ch.name + ': ' + e.message);
      }
    }
  }

  for (const t of targets) {
    upsertChannel({
      channel_id: t.channel.id,
      guild_id: guildId,
      name: t.name,
      parent_name: t.parent,
    });
  }
  console.log('[archive] discovered ' + targets.length + ' channels/threads to archive');
  return targets;
}

/**
 * Backfill one channel from now backward until empty history or the lookback floor.
 * Hitting the 72h cap still marks the channel done so extraction can start.
 */
async function backfillChannel(target, onProgress) {
  const ch = target.channel;
  const row = getChannelRow(ch.id);
  if (row?.backfill_done) return 0;

  const cutoff = backfillCutoffMs();

  // Last snowflake already older than the window — no REST paging.
  if (channelQuietBefore(ch, cutoff)) {
    markBackfillDone(ch.id);
    console.log('[archive] skip (quiet > lookback): ' + target.name);
    return 0;
  }

  let before = row?.oldest_fetched_id || undefined;
  // Resume cursor already past the floor — treat as done, do not walk into 2024.
  if (before && cutoff && snowflakeToMs(before) < cutoff) {
    markBackfillDone(ch.id);
    console.log('[archive] skip (cursor older than lookback): ' + target.name);
    return 0;
  }

  let total = 0;

  while (true) {
    let batch;
    try {
      batch = await ch.messages.fetch({ limit: PAGE_SIZE, ...(before ? { before } : {}) });
    } catch (e) {
      console.error('[archive] fetch failed in ' + target.name + ': ' + e.message + ' — will resume later');
      return total; // resumable: cursor already saved
    }
    if (batch.size === 0) break;

    const arr = [...batch.values()]; // newest -> oldest
    const { keep, hitFloor } = sliceToLookback(arr, cutoff);
    if (keep.length) {
      insertMessagesBatch(keep.map(msgToRow));
      total += keep.length;
    }
    before = arr[arr.length - 1].id;
    setBackfillCursor(ch.id, before);
    onProgress?.(target.name, total);
    if (hitFloor) break;
    await sleep(PAGE_DELAY_MS);
  }

  markBackfillDone(ch.id);
  console.log('[archive] backfill done: ' + target.name + ' (+' + total + ' this run)');
  return total;
}

let backfillRunning = false;

export async function runBackfill(client, onProgress) {
  if (backfillRunning) throw new Error('backfill already running');
  backfillRunning = true;
  try {
    const hours = parseBackfillMaxAgeHours();
    const cutoff = backfillCutoffMs();
    if (hours === 0) {
      console.log('[archive] lookback unlimited (KB_BACKFILL_MAX_AGE_HOURS=0) — full history');
    } else {
      console.log(
        '[archive] lookback ' + hours + 'h — messages before ' +
          new Date(cutoff).toISOString() + ' are skipped (set 0 for full history later)',
      );
    }
    const targets = await discoverChannels(client);
    let grand = 0;
    for (const t of targets) {
      grand += await backfillChannel(t, onProgress);
    }
    console.log('[archive] backfill pass complete — ' + grand + ' new messages stored');
    return grand;
  } finally {
    backfillRunning = false;
  }
}

export function isBackfillRunning() {
  return backfillRunning;
}

// Live sync keeps the archive current and honest (edits + deletions tracked).
export function attachLiveSync(client) {
  client.on('messageCreate', (m) => {
    if (!m.guild || m.guildId !== kbGuildId()) return;
    if (isBlockedChannel(m.channelId)) return;
    if (!getChannelRow(m.channelId)) return; // only archived channels
    try {
      insertMessage(msgToRow(m));
    } catch (e) {
      console.error('[archive] live insert failed: ' + e.message);
    }
  });
  client.on('messageUpdate', (_old, m) => {
    if (!m?.guild || !m.content) return;
    try {
      markMessageEdited(m.id, m.content, Date.now());
    } catch { /* partials without content are fine to skip */ }
  });
  client.on('messageDelete', (m) => {
    if (!m?.id) return;
    try {
      markMessageDeleted(m.id);
    } catch { /* ignore */ }
  });
  console.log('[archive] live sync attached');
}
