/**
 * xfeed/store.js — "what have we already posted" state, in dbStore.
 *
 * db.xFeed = { seen: { "<tweetId>": postedAtMs }, lastPollAt: number }
 *
 * Dedup is by tweet id rather than timestamp: list timelines return tweets
 * out of order and can back-fill, so a high-water-mark alone would drop posts.
 * Ids are pruned after PRUNE_AFTER_MS so state can't grow forever.
 */

import { loadDB, saveDB, ensureDBSchema } from '../dbStore.js';

const PRUNE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h — far longer than any poll window

function read() {
  const db = ensureDBSchema(loadDB());
  if (!db.xFeed) db.xFeed = { seen: {}, lastPollAt: 0 };
  if (!db.xFeed.seen) db.xFeed.seen = {};
  return db;
}

function update(mutator) {
  const db = read();
  const out = mutator(db.xFeed, db);
  saveDB(db);
  return out;
}

export function isSeen(id) {
  return Boolean(read().xFeed.seen[String(id)]);
}

/** Mark a batch as posted and prune anything old, in one write. */
export function markSeen(ids) {
  update((xf) => {
    const now = Date.now();
    for (const id of ids) xf.seen[String(id)] = now;
    for (const [id, at] of Object.entries(xf.seen)) {
      if (now - at > PRUNE_AFTER_MS) delete xf.seen[id];
    }
    xf.lastPollAt = now;
  });
}

export function seenCount() {
  return Object.keys(read().xFeed.seen).length;
}

/** True the first time this instance ever polls (used to suppress a backfill flood). */
export function isFirstRun() {
  return !read().xFeed.lastPollAt;
}
