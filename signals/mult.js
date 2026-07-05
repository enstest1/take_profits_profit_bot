/** Shared multiple vs call price — used by lifecycle + signal alerts. */
export function currentMultipleFromLive(entry, live) {
  const livePrice =
    live?.price == null || live.price === '' ? null : Number(live.price);
  const callPx =
    entry?.priceAtCall == null || entry.priceAtCall === ''
      ? null
      : Number(entry.priceAtCall);
  if (
    livePrice == null ||
    !Number.isFinite(livePrice) ||
    livePrice <= 0 ||
    callPx == null ||
    !Number.isFinite(callPx) ||
    callPx <= 0
  ) {
    return null;
  }
  const multPrice = livePrice / callPx;
  const mcapCall =
    entry.mcapAtCall == null || entry.mcapAtCall === '' ? null : Number(entry.mcapAtCall);
  const mcapLive =
    live.marketCap == null || live.marketCap === '' ? null : Number(live.marketCap);
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
  if (multMcap != null && Number.isFinite(multMcap) && multMcap > 0) {
    return Math.max(multPrice, multMcap);
  }
  return multPrice;
}
