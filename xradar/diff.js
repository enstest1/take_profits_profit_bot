/**
 * xradar/diff.js — pure following-set comparison. No I/O.
 *
 * First snapshot (no previous ids) is a baseline: record, don't alert.
 * After that, anyone on the newest following page who isn't in the snapshot
 * is a new follow. We only look at one page, so a burst of >pageCount follows
 * between ticks can miss the oldest of that burst — acceptable for radar.
 */

/**
 * @param {Record<string, true>|null|undefined} prevIds
 * @param {{ id: string }[]} currentUsers newest-first following page
 * @returns {{ baseline: boolean, newcomers: object[] }}
 */
export function diffFollowing(prevIds, currentUsers) {
  const users = (currentUsers || []).filter((u) => u && u.id);
  if (!prevIds || Object.keys(prevIds).length === 0) {
    return { baseline: true, newcomers: [] };
  }
  const newcomers = users.filter((u) => !prevIds[String(u.id)]);
  return { baseline: false, newcomers };
}

/** Cap so a wiped-and-refollowed account cannot dump 20 cards in one tick. */
export function capNewcomers(newcomers, max) {
  if (!max || max <= 0) return newcomers || [];
  return (newcomers || []).slice(0, max);
}
