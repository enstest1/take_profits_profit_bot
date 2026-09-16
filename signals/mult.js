/** Shared multiple vs call price — used by lifecycle + signal alerts + poller. */

/** When Dex mcap and price disagree this hard, mcap is usually a supply glitch. */
const MCAP_DIVERGE_RATIO = 1.25;

/**
 * @param {object} entry
 * @param {object} live
 * @returns {{
 *   livePrice: number|null,
 *   callPx: number|null,
 *   multPrice: number|null,
 *   multMcap: number|null,
 *   currentMultiple: number|null,
 * }}
 */
export function multiplesFromLive(entry, live) {
  const livePrice =
    live?.price == null || live.price === '' ? null : Number(live.price);
  const callPx =
    entry?.priceAtCall == null || entry.priceAtCall === ''
      ? null
      : Number(entry.priceAtCall);

  const priceOk =
    livePrice != null && Number.isFinite(livePrice) && livePrice > 0 &&
    callPx != null && Number.isFinite(callPx) && callPx > 0;
  const multPrice = priceOk ? livePrice / callPx : null;

  const mcapCall =
    entry?.mcapAtCall == null || entry.mcapAtCall === '' ? null : Number(entry.mcapAtCall);
  const mcapLive =
    live?.marketCap == null || live.marketCap === '' ? null : Number(live.marketCap);
  let multMcap = null;
  if (
    mcapCall != null &&
    Number.isFinite(mcapCall) &&
    mcapCall > 0 &&
    mcapLive != null &&
    Number.isFinite(mcapLive) &&
    mcapLive > 0
  ) {
    multMcap = mcapLive / mcapCall;
  }

  let currentMultiple = null;
  if (multPrice != null && multMcap != null && Number.isFinite(multMcap) && multMcap > 0) {
    const hi = Math.max(multPrice, multMcap);
    const lo = Math.min(multPrice, multMcap);
    // Small gap: Dex price can lag mcap on the same pair — keep the higher.
    // Large gap: do not fire a 20x card off a mcap glitch while price is 2x.
    if (lo > 0 && hi / lo > MCAP_DIVERGE_RATIO) {
      currentMultiple = multPrice;
    } else {
      currentMultiple = hi;
    }
  } else if (multPrice != null) {
    currentMultiple = multPrice;
  }

  return { livePrice: priceOk ? livePrice : null, callPx: priceOk ? callPx : null, multPrice, multMcap, currentMultiple };
}

export function currentMultipleFromLive(entry, live) {
  return multiplesFromLive(entry, live).currentMultiple;
}
