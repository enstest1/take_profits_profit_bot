/**
 * xradar/listSync.js — push /xwatch handles onto the X list xfeed polls.
 *
 * One Discord command should do both jobs: follow-radar and posts/comments.
 * The list is dest-specific: personal /xwatch → Bitcernals list, TP /xwatch →
 * the Take Profits list from XFEED_ROUTES. Never clone one community onto the other.
 *
 * List mutations never throw into the slash command — follow-radar still
 * records the handle if X list-add fails (private list, expired cookies, etc.).
 */

import { addListMember, removeListMember } from './xClient.js';
import { DEST_PERSONAL, getRadarDestinations } from './config.js';
import { parseFeedRoutes } from '../xfeed/config.js';

/** @param {NodeJS.ProcessEnv} [env] */
export function targetFeedListId(env = process.env) {
  const dedicated = env.XFEED_SYNC_LIST_ID?.trim();
  if (dedicated) return dedicated;
  return String(env.XFEED_LIST_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0] || '';
}

/**
 * X list for this radar dest: match XFEED_ROUTES by dest channel.
 * Personal falls back to XFEED_SYNC_LIST_ID when routes are missing.
 * @param {string} destId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function listIdForDest(destId, env = process.env) {
  const dest = getRadarDestinations(env).find((d) => d.id === destId);
  const channelId = dest?.channelId || '';
  const hit = parseFeedRoutes(env).find((r) => r.channelId === channelId);
  if (hit?.listId) return hit.listId;
  if (destId === DEST_PERSONAL) return targetFeedListId(env);
  return '';
}

/** Human line for the /xwatch reply. */
export function describeListSync(result) {
  if (!result) return '';
  if (result.skipped === 'no_list') {
    return 'Not added to the posts list — set XFEED_LIST_IDS to the list your X cookies own.';
  }
  if (result.skipped === 'no_user_id') {
    return 'Not added to the posts list — X did not return a user id.';
  }
  if (result.ok && result.removed) return 'Removed from the X list for posts/comments.';
  if (result.ok && result.already) return 'Already on the X list for posts/comments.';
  if (result.ok && result.missing) return 'Was not on the X list.';
  if (result.ok) return 'Added to the X list for posts/comments.';
  return 'Follow radar updated, but the X list change failed: ' + (result.error || 'unknown');
}

/**
 * Add a resolved X profile to the dest's feed list.
 * @returns {Promise<{ok?: boolean, already?: boolean, skipped?: string, error?: string, listId?: string}>}
 */
export async function syncHandleToFeedList(profile, dest = DEST_PERSONAL) {
  const listId = listIdForDest(dest);
  if (!listId) return { skipped: 'no_list' };
  const userId = profile?.id;
  if (!userId) return { skipped: 'no_user_id' };
  const handle = profile.username || userId;
  try {
    const out = await addListMember(listId, userId);
    console.log('[xradar] list ' + listId + ' dest=' + dest + (out.already ? ' already had @' : ' added @') + handle);
    return { ok: true, already: Boolean(out.already), listId };
  } catch (e) {
    console.error('[xradar] list add failed for @' + handle + ' dest=' + dest + ':', e.message);
    return { ok: false, error: e.message, listId };
  }
}

/** Remove a resolved X profile from the dest's feed list. */
export async function unsyncHandleFromFeedList(profile, dest = DEST_PERSONAL) {
  const listId = listIdForDest(dest);
  if (!listId) return { skipped: 'no_list' };
  const userId = profile?.id;
  if (!userId) return { skipped: 'no_user_id' };
  const handle = profile.username || userId;
  try {
    const out = await removeListMember(listId, userId);
    console.log('[xradar] list ' + listId + ' dest=' + dest + (out.missing ? ' did not have @' : ' removed @') + handle);
    return { ok: true, removed: !out.missing, missing: Boolean(out.missing), listId };
  } catch (e) {
    console.error('[xradar] list remove failed for @' + handle + ' dest=' + dest + ':', e.message);
    return { ok: false, error: e.message, listId };
  }
}
