/**
 * Call-anchor guard for the 1x ladder.
 *
 * The paste used to lock priceAtCall from whichever Dex row answered first.
 * The next poll priced the real pool, 100k/50k came out to 2×, and tier 1
 * ("1x") fired on a token that had not moved. A pool change before any
 * milestone is a bad anchor, not a gain.
 *
 * Old calls are left alone: the window is one poll longer than the default
 * interval, and it closes once anchorLocked is set.
 */

/** Default poll is 3 min and a cycle can run long. Cover the first live tick. */
export const FRESH_CALL_MS = 12 * 60 * 1000;

/**
 * True only for a brand-new call that has not been confirmed against a live poll.
 * Aged rows and already-locked anchors keep their pinned pool.
 * @param {object} entry
 * @param {number} [now]
 * @returns {boolean}
 */
export function shouldIgnoreCallPin(entry, now = Date.now()) {
  if (!entry || entry.anchorLocked) return false;
  const posted = Number(entry.postedAt);
  if (!Number.isFinite(posted) || posted <= 0) return false;
  return now - posted >= 0 && now - posted < FRESH_CALL_MS;
}

/**
 * @param {object} entry
 * @returns {boolean}
 */
function callAlreadyAlerted(entry) {
  if (entry.gainAlertFired || entry.takeProfitFired) return true;
  return Array.isArray(entry.milestonesFired) && entry.milestonesFired.length > 0;
}

/**
 * Decide whether this live tick should replace the call instead of alerting.
 * Returns null when the tick is a real move on the same pool.
 * @param {object} entry
 * @param {object} live
 * @param {number} [now]
 * @returns {{ reason: string, priceAtCall: string, mcapAtCall: number|null, pairAddress: string|null }|null}
 */
export function rebaseCallAnchor(entry, live, now = Date.now()) {
  if (!entry || !shouldIgnoreCallPin(entry, now)) return null;
  if (callAlreadyAlerted(entry)) return null;
  // Cap was already corrected off the frozen curve. A later AMM print is the
  // move from that scan, not a new anchor.
  if (entry.priceSource === 'pump-curve') return null;

  const livePrice = Number(live?.price);
  if (!(livePrice > 0)) return null;

  const callPair = entry.pairAddress ? String(entry.pairAddress) : '';
  const livePair = live?.pairAddress ? String(live.pairAddress) : '';
  const jupiterCall = entry.priceSource === 'jupiter';
  // Jupiter was a display fill. The first AMM print is the real call.
  const jupiterToDex = jupiterCall && live?.priceSource !== 'jupiter' && !!livePair;
  const pairSwitch = !!(callPair && livePair && callPair !== livePair);

  // No pool was pinned (Jupiter, or a row that never stored priceSource) and
  // the first Dex print is already a full double. That gap is the anchor, not a 1x.
  let unpinnedGap = false;
  if (!callPair && livePair && !jupiterToDex) {
    const callPx = Number(entry.priceAtCall);
    if (callPx > 0 && livePrice / callPx >= 2) unpinnedGap = true;
  }

  if (!pairSwitch && !jupiterToDex && !unpinnedGap) return null;

  const mcap = Number(live?.marketCap);
  return {
    reason: pairSwitch ? 'pair-switch' : jupiterToDex ? 'jupiter-amm' : 'unpinned-gap',
    priceAtCall: String(livePrice),
    mcapAtCall: Number.isFinite(mcap) && mcap > 0 ? mcap : null,
    pairAddress: livePair || null,
  };
}
