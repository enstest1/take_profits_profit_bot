#!/usr/bin/env node
/**
 * Push every already-watched /xwatch handle onto the X list xfeed polls.
 *
 * Use this once after wiring list-sync, so accounts added before /xwatch
 * started updating the list also get posts/comments. Live adds go through
 * /xwatch from then on.
 *
 *   XFEED_LIST_IDS=<id> node scripts/sync-xwatch-to-list.mjs
 *   XFEED_LIST_IDS=<id> node scripts/sync-xwatch-to-list.mjs --dry-run
 */

import { listWatched } from '../xradar/store.js';
import { getUserByScreenName } from '../xradar/xClient.js';
import { syncHandleToFeedList, targetFeedListId } from '../xradar/listSync.js';

const dry = process.argv.includes('--dry-run');
const listId = targetFeedListId();

if (!listId) {
  console.error('Set XFEED_LIST_IDS (or XFEED_SYNC_LIST_ID) to the list your X cookies own.');
  process.exit(1);
}

const watched = listWatched();
const handles = Object.keys(watched);
console.log('[sync-list] ' + (dry ? 'dry-run ' : '') + handles.length + ' watched handle(s) → list ' + listId);

let added = 0;
let already = 0;
let failed = 0;

for (const handle of handles) {
  let profile = watched[handle];
  if (!profile?.id) {
    try {
      profile = await getUserByScreenName(handle);
    } catch (e) {
      console.error('[sync-list] @' + handle + ' lookup failed: ' + e.message);
      failed += 1;
      continue;
    }
  }

  if (dry) {
    console.log('[sync-list] would add @' + (profile.username || handle) + ' (' + profile.id + ')');
    continue;
  }

  const result = await syncHandleToFeedList(profile);
  if (result.ok && result.already) already += 1;
  else if (result.ok) added += 1;
  else {
    failed += 1;
    console.error('[sync-list] @' + handle + ' — ' + (result.error || result.skipped));
  }

  await new Promise((r) => setTimeout(r, 800));
}

console.log('[sync-list] done — added ' + added + ', already ' + already + ', failed ' + failed);
