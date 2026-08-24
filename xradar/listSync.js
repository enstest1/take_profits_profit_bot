/**
 * xradar/listSync.js — push /xwatch handles onto the X list xfeed polls.
 *
 * One Discord command should do both jobs: follow-radar (db.xRadar.users) and
 * posts/comments (the cookie account's X list). The list the cookie account
 * owns is XFEED_SYNC_LIST_ID, else the first id in XFEED_LIST_IDS.
 *
 * List mutations never throw into the slash command — follow-radar still
 * records the handle if X list-add fails (private list, expired cookies, etc.).
 */

import { addListMember, removeListMember } from './xClient.js';

/** @param {NodeJS.ProcessEnv} [env] */
export function targetFeedListId(env = process.env) {
  const dedicated = env.XFEED_SYNC_LIST_ID?.trim();
  if (dedicated) return dedicated;
  return String(env.XFEED_LIST_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0] || '';
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
 * Add a resolved X profile to the feed list.
 * @returns {Promise<{ok?: boolean, already?: boolean, skipped?: string, error?: string, listId?: string}>}
 */
export async function syncHandleToFeedList(profile) {
  const listId = targetFeedListId();
  if (!listId) return { skipped: 'no_list' };
  const userId = profile?.id;
  if (!userId) return { skipped: 'no_user_id' };
  const handle = profile.username || userId;
  try {
    const out = await addListMember(listId, userId);
    console.log('[xradar] list ' + listId + (out.already ? ' already had @' : ' added @') + handle);
    return { ok: true, already: Boolean(out.already), listId };
  } catch (e) {
    console.error('[xradar] list add failed for @' + handle + ':', e.message);
    return { ok: false, error: e.message, listId };
  }
}

/** Remove a resolved X profile from the feed list. */
export async function unsyncHandleFromFeedList(profile) {
  const listId = targetFeedListId();
  if (!listId) return { skipped: 'no_list' };
  const userId = profile?.id;
  if (!userId) return { skipped: 'no_user_id' };
  const handle = profile.username || userId;
  try {
    const out = await removeListMember(listId, userId);
    console.log('[xradar] list ' + listId + (out.missing ? ' did not have @' : ' removed @') + handle);
    return { ok: true, removed: !out.missing, missing: Boolean(out.missing), listId };
  } catch (e) {
    console.error('[xradar] list remove failed for @' + handle + ':', e.message);
    return { ok: false, error: e.message, listId };
  }
}
