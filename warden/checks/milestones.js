import { allEntries } from '../lib/entries.js';

export function checkMilestones(prevSnap, currSnap, raise) {
  if (!prevSnap || !currSnap) return;
  for (const [key, prev] of allEntries(prevSnap)) {
    const curr = currSnap.tokens?.[key] ?? currSnap.archived?.[key];
    if (!curr) continue;

    const callPx = Number(curr.priceAtCall);
    if (!callPx || !Number.isFinite(callPx)) continue;

    const prevM = Array.isArray(prev.milestonesFired) ? [...prev.milestonesFired].sort((a, b) => a - b) : [];
    const currM = Array.isArray(curr.milestonesFired) ? [...curr.milestonesFired].sort((a, b) => a - b) : [];

    const resetChanged =
      String(prev.lastMilestoneResetAt || '') !== String(curr.lastMilestoneResetAt || '');

    if (currM.length < prevM.length && !resetChanged) {
      raise('C4', 'CRITICAL', key, 'milestonesFired shrank without trench reset', {
        before: prevM,
        after: currM,
      });
    }

    const peak = Number(curr.peakMultiple) || 1;
    const highest = currM.length ? currM[currM.length - 1] : 0;
    if (highest > Math.floor(peak) + 1) {
      raise('C4', 'WARN', key, 'Highest milestone tier exceeds peakMultiple floor', {
        milestonesFired: currM,
        peakMultiple: peak,
      });
    }

    const lastPx = Number(curr.lastPrice);
    if (lastPx > 0 && callPx > 0) {
      const implied = lastPx / callPx;
      if (peak < implied * 0.95 && !resetChanged) {
        raise('C4', 'WARN', key, 'peakMultiple stale vs lastPrice/priceAtCall', {
          peakMultiple: peak,
          implied,
        });
      }
    }

    const prevPeak = Number(prev.peakMultiple) || 1;
    const currPeak = Number(curr.peakMultiple) || 1;
    if (currPeak < prevPeak && !resetChanged) {
      raise('C4', 'WARN', key, 'peakMultiple decreased outside trench reset', {
        before: prevPeak,
        after: currPeak,
      });
    }
  }
}
