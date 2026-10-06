import { IMMUTABLE } from '../config.js';
import { allEntries, findEntry, findRepairedTwin } from '../lib/entries.js';

export function checkOgImmutability(prevSnap, currSnap, raise) {
  if (!prevSnap || !currSnap) return;
  for (const [key, prev] of allEntries(prevSnap)) {
    let curr = findEntry(currSnap, key);
    if (!curr) {
      const twin = findRepairedTwin(currSnap, key, prev);
      if (twin) continue;
      continue;
    }
    for (const field of IMMUTABLE) {
      if (String(prev[field]) === String(curr[field])) continue;
      if (
        field === 'priceAtCall' &&
        prev[field] == null &&
        curr.priceAtCallBackfilled === true &&
        prev.priceAtCallBackfilled !== true
      ) {
        continue;
      }
      // One-time anchor fix: first live tick was a different pool than the paste.
      // Not a reset after a milestone — milestonesFired must still be empty.
      if (
        field === 'priceAtCall' &&
        curr.priceAtCallRebased === true &&
        prev.priceAtCallRebased !== true &&
        (!Array.isArray(curr.milestonesFired) || curr.milestonesFired.length === 0) &&
        !curr.gainAlertFired &&
        !curr.takeProfitFired
      ) {
        continue;
      }
      raise(
        'REG-1',
        'CRITICAL',
        key,
        (curr.symbol || key.slice(0, 12)) + ' — immutable `' + field + '` changed (OG call integrity)',
        { field, before: prev[field], after: curr[field] },
      );
    }
  }
}
