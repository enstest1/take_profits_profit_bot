import { MASS_DELETE_PCT } from '../config.js';
import { countActive, countArchived, repairTwinKeys } from '../lib/entries.js';

export function checkMassDeletion(prevSnap, currSnap, raise) {
  if (!prevSnap || !currSnap) return;
  const prevActive = countActive(prevSnap);
  const currActive = countActive(currSnap);
  if (prevActive === 0) return;

  const twins = repairTwinKeys(prevSnap, currSnap);
  const twinCount = twins.size;
  const prevArch = countArchived(prevSnap);
  const currArch = countArchived(currSnap);
  const archDelta = currArch - prevArch;
  const activeDrop = prevActive - currActive - twinCount;

  if (activeDrop <= 0) return;
  const dropPct = activeDrop / prevActive;
  if (dropPct <= MASS_DELETE_PCT) return;
  if (archDelta >= activeDrop * 0.8) return;

  raise('REG-7', 'CRITICAL', 'global', 'Mass deletion: active tokens dropped ' + Math.round(dropPct * 100) + '% without matching archive growth', {
    before: prevActive,
    after: currActive,
    archivedDelta: archDelta,
    repairTwins: twinCount,
  });
}
