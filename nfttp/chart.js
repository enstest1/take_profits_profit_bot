/**
 * nfttp/chart.js — OpenSea floor history → same 900×400 trencher PNG.
 */

import { AttachmentBuilder } from 'discord.js';
import { renderPriceChart } from '../fib/chartRender.js';
import { CHART_ATTACHMENT_NAME } from '../alertCards/assets.js';
import { fetchFloorCandles } from './opensea.js';

function fmtFloorAxis(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const num = Number(n);
  const abs = Math.abs(num);
  if (abs >= 100) return num.toFixed(0);
  if (abs >= 1) return num.toFixed(2).replace(/\.?0+$/, '');
  if (abs >= 0.01) return num.toFixed(3).replace(/\.?0+$/, '');
  return num.toFixed(4).replace(/\.?0+$/, '');
}

/**
 * @returns {Promise<{ chartFile: import('discord.js').AttachmentBuilder|null, candles: object[] }>}
 */
export async function buildNftFloorChart({ slug, ticker, callFloor, currentFloor, floorSymbol = 'ETH' }) {
  const { candles } = await fetchFloorCandles(slug, { timeframe: 'one_hour', resolution: 80 });
  if (!candles.length) {
    return { chartFile: null, candles: [] };
  }

  const png = await renderPriceChart({
    candles,
    symbol: ticker || slug,
    timeframe: '1h floor',
    callValue: Number.isFinite(Number(callFloor)) && Number(callFloor) > 0 ? Number(callFloor) : null,
    currentValue:
      Number.isFinite(Number(currentFloor)) && Number(currentFloor) > 0
        ? Number(currentFloor)
        : candles.at(-1).c,
    formatValue: (v) => fmtFloorAxis(v) + ' ' + (floorSymbol || 'ETH'),
    minSpanPad: 0.0001,
  });

  if (!png) return { chartFile: null, candles };
  return {
    chartFile: new AttachmentBuilder(png, { name: CHART_ATTACHMENT_NAME }),
    candles,
  };
}
