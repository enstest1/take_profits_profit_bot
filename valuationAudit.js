/**
 * Valuation audit — log DexScreener mcap/fdv snapshot whenever alerts fire.
 * DexScreener does not expose block number or explicit supply fields; we derive
 * circulating ≈ marketCap/price and total ≈ fdv/price when both sides exist.
 */

export function valuationFromPair(pair) {
  if (!pair) return null;
  const price = pair.priceUsd != null ? Number(pair.priceUsd) : null;
  const marketCap = pair.marketCap != null ? Number(pair.marketCap) : null;
  const fdv = pair.fdv != null ? Number(pair.fdv) : null;
  const circ =
    marketCap != null && price != null && Number.isFinite(price) && price > 0
      ? marketCap / price
      : null;
  const total =
    fdv != null && price != null && Number.isFinite(price) && price > 0 ? fdv / price : null;
  return {
    timestamp: new Date().toISOString(),
    blockNumber: null, // DexScreener pair payload has no block number
    poolAddress: pair.pairAddress || null,
    tokenPrice: Number.isFinite(price) ? price : null,
    circulatingSupply: circ,
    totalSupply: total,
    dexScreenerMarketCap: Number.isFinite(marketCap) ? marketCap : null,
    dexScreenerFdv: Number.isFinite(fdv) ? fdv : null,
  };
}

/** Attach audit fields onto a live/token object built from a DexScreener pair. */
export function enrichLiveFromPair(live, pair) {
  if (!live || !pair) return live;
  const v = valuationFromPair(pair);
  if (!v) return live;
  live.fdv = v.dexScreenerFdv;
  live.pairAddress = v.poolAddress;
  live.circulatingSupply = v.circulatingSupply;
  live.totalSupply = v.totalSupply;
  live.valuation = v;
  return live;
}

/** Snapshot from an already-normalized live object (poll path). */
export function valuationFromLive(live) {
  if (!live) return null;
  if (live.valuation) return { ...live.valuation, timestamp: new Date().toISOString() };
  const price = live.price != null ? Number(live.price) : null;
  const marketCap = live.marketCap != null ? Number(live.marketCap) : null;
  const fdv = live.fdv != null ? Number(live.fdv) : null;
  const circ =
    live.circulatingSupply != null
      ? Number(live.circulatingSupply)
      : marketCap != null && price != null && price > 0
        ? marketCap / price
        : null;
  const total =
    live.totalSupply != null
      ? Number(live.totalSupply)
      : fdv != null && price != null && price > 0
        ? fdv / price
        : null;
  return {
    timestamp: new Date().toISOString(),
    blockNumber: null,
    poolAddress: live.pairAddress || null,
    tokenPrice: Number.isFinite(price) ? price : null,
    circulatingSupply: Number.isFinite(circ) ? circ : null,
    totalSupply: Number.isFinite(total) ? total : null,
    dexScreenerMarketCap: Number.isFinite(marketCap) ? marketCap : null,
    dexScreenerFdv: Number.isFinite(fdv) ? fdv : null,
  };
}

export function stampEntryValuation(entry, live) {
  if (!entry || !live) return;
  entry.lastValuation = valuationFromLive(live);
}

export function logValuationAudit(reason, symbolOrKey, valuation) {
  if (!valuation) {
    console.log('[mcap-audit] ' + reason + ' ' + symbolOrKey + ' — no valuation snapshot');
    return;
  }
  console.log(
    '[mcap-audit] ' +
      JSON.stringify({
        reason,
        symbol: symbolOrKey,
        timestamp: valuation.timestamp,
        blockNumber: valuation.blockNumber,
        poolAddress: valuation.poolAddress,
        tokenPrice: valuation.tokenPrice,
        circulatingSupply: valuation.circulatingSupply,
        totalSupply: valuation.totalSupply,
        dexScreenerMarketCap: valuation.dexScreenerMarketCap,
        dexScreenerFdv: valuation.dexScreenerFdv,
      }),
  );
}
