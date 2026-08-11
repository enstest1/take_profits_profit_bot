/**
 * Volume / price-change windows for trencher milestone cards.
 * DexScreener exposes m5, h1, h6, h24 — not native 30m/15m buckets.
 * When 5m OHLCV is available (chart path), we compute exact windows from candles.
 */

/**
 * Extract 1h / 30m / 15m windows from a DexScreener pair payload.
 * 30m and 15m are proxies when candle data is unavailable (documented in ALERT_CARDS.md).
 * @param {object} pair DexScreener pair object
 * @returns {{ label: string, vol: number|null, pct: number|null }[]}
 */
export function extractVolumeWindowsFromPair(pair) {
  const vol = pair?.volume || {};
  const pc = pair?.priceChange || {};
  const h1Vol = vol.h1 != null ? Number(vol.h1) : null;
  const m5Vol = vol.m5 != null ? Number(vol.m5) : null;
  const h1Pct = pc.h1 != null ? Number(pc.h1) : null;
  const m5Pct = pc.m5 != null ? Number(pc.m5) : null;

  return [
    { label: '1h', vol: h1Vol, pct: h1Pct },
    {
      label: '30m',
      vol: m5Vol != null ? m5Vol * 6 : h1Vol != null ? h1Vol / 2 : null,
      pct: m5Pct != null ? m5Pct * 6 : h1Pct != null ? h1Pct / 2 : null,
    },
    {
      label: '15m',
      vol: m5Vol != null ? m5Vol * 3 : h1Vol != null ? h1Vol / 4 : null,
      pct: m5Pct != null ? m5Pct * 3 : h1Pct != null ? h1Pct / 4 : null,
    },
  ];
}

/**
 * Aggregate volume + % move over the last N 5-minute candles (chronological).
 * @param {object[]} candles OHLCV rows sorted oldest → newest
 * @param {number} bars Number of 5m bars in the window
 */
function windowFromCandles(candles, bars) {
  const slice = candles.slice(-bars);
  if (!slice.length) return { vol: null, pct: null };
  const vol = slice.reduce((s, c) => s + (Number(c.v) || 0), 0);
  const open = Number(slice[0].o);
  const close = Number(slice[slice.length - 1].c);
  const pct = open > 0 && Number.isFinite(close) ? ((close - open) / open) * 100 : null;
  return { vol, pct };
}

/**
 * Precise 1h / 30m / 15m windows from 5m OHLCV (12 / 6 / 3 bars).
 * @param {object[]} candles
 * @returns {{ label: string, vol: number|null, pct: number|null }[]}
 */
export function windowsFrom5mCandles(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const w12 = windowFromCandles(candles, 12);
  const w6 = windowFromCandles(candles, 6);
  const w3 = windowFromCandles(candles, 3);
  return [
    { label: '1h', ...w12 },
    { label: '30m', ...w6 },
    { label: '15m', ...w3 },
  ];
}

/** Prefer candle-derived windows; fall back to DexScreener pair proxies. */
export function resolveVolumeWindows({ pair, candles5m, liveWindows }) {
  const fromCandles = windowsFrom5mCandles(candles5m);
  if (fromCandles) return fromCandles;
  if (Array.isArray(liveWindows) && liveWindows.length) return liveWindows;
  if (pair) return extractVolumeWindowsFromPair(pair);
  return extractVolumeWindowsFromPair({});
}
