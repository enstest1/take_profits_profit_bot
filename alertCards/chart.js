/**
 * Milestone chart attachment — 900×400 price chart from GeckoTerminal OHLCV.
 * Degrades to null (text-only card) when pool/candles/canvas unavailable.
 */
import { fetchCandles, resolveTopPool } from '../fib/geckoTerminal.js';
import { renderPriceChart } from '../fib/chartRender.js';
import { AttachmentBuilder } from 'discord.js';
import { CHART_ATTACHMENT_NAME } from './assets.js';
import { windowsFrom5mCandles } from './windows.js';

/**
 * Fetch 5m + 1h candles, render chart PNG, return refined volume windows.
 * @returns {Promise<{ chartFile: import('discord.js').AttachmentBuilder|null, windows5m: object[]|null, candles5m: object[]|null }>}
 */
export async function buildMilestoneChart({ chainId, address, symbol, callMcap, currentMcap, pairAddress }) {
  let pool = pairAddress || null;
  if (!pool) {
    const r = await resolveTopPool(chainId, address);
    if (!r.error) pool = r.poolAddress;
  }
  if (!pool) {
    console.warn('[alertCards/chart] no pool for ' + symbol + ' on ' + chainId);
    return { chartFile: null, windows5m: null, candles5m: null };
  }

  const got5m = await fetchCandles(chainId, pool, '5m', { limit: 80 });
  const got1h = await fetchCandles(chainId, pool, '1h', { limit: 80 });

  const mcap = Number(currentMcap);
  let factor = null;
  if (got1h.candles?.length && Number.isFinite(mcap) && mcap > 0) {
    const lastClose = Number(got1h.candles.at(-1).c);
    if (lastClose > 0) factor = mcap / lastClose;
  }

  const toMcap = (candles) =>
    factor && candles
      ? candles.map((c) => ({
          ...c,
          o: c.o * factor,
          h: c.h * factor,
          l: c.l * factor,
          c: c.c * factor,
        }))
      : candles;

  const candles1h = toMcap(got1h.candles);
  const candles5m = got5m.candles || null;
  const windows5m = windowsFrom5mCandles(candles5m);

  if (!candles1h?.length) {
    return { chartFile: null, windows5m, candles5m };
  }

  const callVal = Number(callMcap);
  const curVal = Number.isFinite(mcap) && mcap > 0 ? mcap : candles1h.at(-1).c;

  const png = await renderPriceChart({
    candles: candles1h,
    symbol: symbol || '',
    timeframe: '1h',
    callValue: Number.isFinite(callVal) && callVal > 0 ? callVal : null,
    currentValue: curVal,
  });

  if (!png) {
    return { chartFile: null, windows5m, candles5m };
  }

  return {
    chartFile: new AttachmentBuilder(png, { name: CHART_ATTACHMENT_NAME }),
    windows5m,
    candles5m,
  };
}
