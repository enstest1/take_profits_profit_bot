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
