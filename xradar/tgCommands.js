/**
 * xradar/tgCommands.js — Telegram /xwatch add|remove|list|ping
 *
 * Same dest store as Discord /xwatch, but this service's /data is Golden Pocket
 * only. XFEED_SYNC_LIST_ID=none so we never write Discord X lists from TG.
 */

import { normalizeXHandle } from '../xSocial.js';
import { getUserByScreenName } from './xClient.js';
import { addWatched, removeWatched, listWatched, getWatched, setWatchedPings } from './store.js';
import { DEST_PERSONAL } from './config.js';
import { applyPingPatch, summarizePings, anyPingFlagSet } from './pings.js';
import { syncHandleToFeedList, unsyncHandleFromFeedList } from './listSync.js';
import { parseTgXwatch, pingTargetFromTelegramMessage } from './tgParse.js';
import { sendTelegramMessage } from '../notifier.js';

const DEST = DEST_PERSONAL;

function flagsOrPostsDefault(flags, ping) {
  if (anyPingFlagSet(flags)) return flags;
  if (ping) return { post: true, follow: null, reply: null };
  return null;
}

function applyPings(handle, discordUserId, flags) {
  const current = getWatched(handle, DEST);
  if (!current) return '';
  const next = applyPingPatch(current.pings, discordUserId, flags);
  setWatchedPings(handle, DEST, next);
  const summary = summarizePings(next, 'telegram');
  return summary ? 'Pings: ' + summary : 'No pings — cards still post silently.';
}

function listLineForTg(sync) {
  if (sync?.skipped === 'no_list') {
    return 'Posts/replies come from their timeline (Telegram has no X list).';
  }
  if (sync?.ok && sync.already) return 'Already on the posts list.';
  if (sync?.ok) return 'Added to the posts list.';
  if (sync?.ok === false) return 'Follow radar updated, but list sync failed: ' + (sync.error || 'unknown');
  return '';
}

/**
 * @param {string} chatId
 * @param {object} msg Telegram message
 * @param {string[]} args tokens after /xwatch
 */
export async function handleTgXwatch(chatId, msg, args) {
  const parsed = parseTgXwatch(args);
  if (parsed.sub === 'add') return handleAdd(chatId, msg, parsed);
  if (parsed.sub === 'remove') return handleRemove(chatId, parsed);
  if (parsed.sub === 'ping') return handlePing(chatId, msg, parsed);
  return handleList(chatId);
}

async function handleAdd(chatId, msg, parsed) {
  const handle = normalizeXHandle(parsed.handle);
  if (!handle) {
    return sendTelegramMessage(chatId, {
      text: 'Usage: <code>/xwatch add handle ping posts</code>\nExample: <code>/xwatch add omisnista ping posts</code>',
    });
  }

  let profile;
  try {
    profile = await getUserByScreenName(handle);
  } catch (e) {
    console.error('[xradar] tg /xwatch add @' + handle + ' lookup failed:', e.message);
    return sendTelegramMessage(chatId, { text: 'Could not find <b>@' + handle + '</b> on X — ' + e.message });
  }

  const { added } = addWatched(handle, profile, DEST);
  const sync = await syncHandleToFeedList(profile, DEST);
  const who = profile.username || handle;
  const extra = [];
  extra.push(listLineForTg(sync));

  const resolved = flagsOrPostsDefault(parsed.flags, parsed.ping);
  if (resolved) {
    extra.push(applyPings(handle, pingTargetFromTelegramMessage(msg), resolved));
  }

  const head = added
    ? 'Watching <b>@' + who + '</b>. Cards always post.'
    : 'Already watching <b>@' + who + '</b>.';
  return sendTelegramMessage(chatId, { text: [head, ...extra.filter(Boolean)].join('\n') });
}

async function handleRemove(chatId, parsed) {
  const handle = normalizeXHandle(parsed.handle);
  if (!handle) {
    return sendTelegramMessage(chatId, { text: 'Usage: <code>/xwatch remove handle</code>' });
  }
  const cached = listWatched(DEST)[handle];
  if (!removeWatched(handle, DEST)) {
    return sendTelegramMessage(chatId, { text: "You weren't watching <b>@" + handle + '</b>.' });
  }
  let profile = cached?.id ? { id: cached.id, username: cached.username || handle } : null;
  if (!profile) {
    try {
      profile = await getUserByScreenName(handle);
    } catch (e) {
      console.warn('[xradar] tg /xwatch remove lookup failed for @' + handle + ':', e.message);
    }
  }
  if (profile) await unsyncHandleFromFeedList(profile, DEST);
  return sendTelegramMessage(chatId, { text: 'Stopped watching <b>@' + handle + '</b>.' });
}

async function handlePing(chatId, msg, parsed) {
  const handle = normalizeXHandle(parsed.handle);
  if (!handle) {
    return sendTelegramMessage(chatId, {
      text: 'Usage: <code>/xwatch ping handle posts</code> (or <code>off</code>). Reply to someone to ping them instead of you.',
    });
  }
  const watched = getWatched(handle, DEST);
  if (!watched) {
    return sendTelegramMessage(chatId, {
      text: "You aren't watching <b>@" + handle + '</b>. <code>/xwatch add ' + handle + '</code> first.',
    });
  }

  if (parsed.off) {
    const line = applyPings(handle, pingTargetFromTelegramMessage(msg), { clear: true });
    return sendTelegramMessage(chatId, { text: 'Updated <b>@' + handle + '</b>. ' + line });
  }

  if (!anyPingFlagSet(parsed.flags)) {
    const summary = summarizePings(watched.pings, 'telegram');
    return sendTelegramMessage(chatId, {
      text: summary
        ? '<b>@' + handle + '</b> pings: ' + summary
        : '<b>@' + handle + '</b> has no pings — cards still post. Add <code>posts</code> / <code>follows</code> / <code>replies</code>.',
    });
  }

  const line = applyPings(handle, pingTargetFromTelegramMessage(msg), parsed.flags);
  return sendTelegramMessage(chatId, { text: 'Updated <b>@' + handle + '</b>. ' + line });
}

async function handleList(chatId) {
  const users = listWatched(DEST);
  const handles = Object.keys(users);
  if (!handles.length) {
    return sendTelegramMessage(chatId, {
      text: 'No X accounts yet. <code>/xwatch add omisnista ping posts</code> to start.',
    });
  }
  const lines = handles.map((h) => {
    const u = users[h];
    const pings = summarizePings(u.pings, 'telegram');
    return '• <b>@' + (u.username || h) + '</b>' + (pings ? '\n  ping ' + pings : '');
  });
  return sendTelegramMessage(chatId, {
    text: '<b>X radar — ' + handles.length + ' account' + (handles.length === 1 ? '' : 's') + '</b>\n' + lines.join('\n'),
  });
}
