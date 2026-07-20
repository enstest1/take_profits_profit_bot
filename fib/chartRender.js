/**
 * fib/chartRender.js — renders the entry-alert chart PNG (candles + fib overlay),
 * Rick-style: drawn server-side from OHLCV, attached to the embed. No screenshots.
 *
 * Degrades gracefully: if @napi-rs/canvas (or a system font) is unavailable the
 * caller receives null and sends a text-only embed instead. Never throws.
 */

import { FIB } from './config.js';

let canvasMod = null;
let canvasTried = false;

async function getCanvas() {
  if (canvasTried) return canvasMod;
  canvasTried = true;
  try {
    canvasMod = await import('@napi-rs/canvas');
    // Best effort: register a known font so labels render on bare containers.
    try {
      const { GlobalFonts } = canvasMod;
      const fs = await import('fs');
      const paths = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) {
          GlobalFonts.registerFromPath(p, 'FibSans');
          break;
        }
      }
    } catch {
      /* label font falls back to whatever the platform has */
    }
  } catch (e) {
    console.error('[fib/chart] canvas unavailable — charts disabled:', e.message);
    canvasMod = null;
  }
  return canvasMod;
}

const C = {
  bg: '#0d1117',
  grid: '#1c2530',
  text: '#aab4c0',
  textDim: '#5c6773',
  up: '#22c55e',
  down: '#ef4444',
  golden: '#14b8a6',
  goldenFill: 'rgba(20,184,166,0.12)',
  red: '#ef4444',
  redFill: 'rgba(239,68,68,0.10)',
  mid: '#f59e0b',
  high: '#e5e7eb',
  low: '#e5e7eb',
  target: '#3b82f6',
  targetFill: 'rgba(59,130,246,0.08)',
  anchor: '#9ca3af',
  price: '#fbbf24',
};

function fmtUsdShort(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (abs >= 1) return '$' + n.toFixed(2);
  return '$' + n.toPrecision(3);
}

/**
 * renderFibChart({ candles, state, symbol, currentValue }) → PNG Buffer | null
 * candles: chronological [{t,o,h,l,c}] in the SAME metric as state (already converted).
 */
export async function renderFibChart({ candles, state, symbol = '', currentValue = null }) {
  try {
    if (!FIB.CHART_ENABLED) return null;
    const mod = await getCanvas();
    if (!mod || !candles?.length || !state?.levels || !state?.anchors) return null;

    const data = candles.slice(-FIB.CHART_CANDLES);
    const W = 900;
    const H = 500;
    const padL = 14;
    const padR = 96;
    const padT = 44;
    const padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const low = state.anchors.low.v;
    const high = state.anchors.high.v;
    const lv = state.levels;
    const showTp = state.targets && state.targets.tp1 <= high * 2.2;

    let yMin = low;
    let yMax = high;
    for (const c of data) {
      if (c.l < yMin) yMin = c.l;
      if (c.h > yMax) yMax = c.h;
    }
    if (showTp) yMax = Math.max(yMax, state.targets.tp1);
    const spanPad = (yMax - yMin) * 0.06 || yMax * 0.06 || 1;
    yMin -= spanPad;
    yMax += spanPad;

    const y = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
    const x = (i) => padL + (plotW * (i + 0.5)) / data.length;
    const cw = Math.max(2, Math.min(11, (plotW / data.length) * 0.66));

    const canvas = mod.createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const FONT = 'FibSans, DejaVu Sans, sans-serif';

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // grid
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gy = padT + (plotH * g) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(padL + plotW, gy);
      ctx.stroke();
    }

    const band = (v1, v2, fill) => {
      const top = Math.min(y(v1), y(v2));
      const h = Math.abs(y(v1) - y(v2));
      ctx.fillStyle = fill;
      ctx.fillRect(padL, top, plotW, h);
    };

    // zones: golden band, red band (entry → low), optional target band (high → tp1)
    band(lv.goldenUpper, lv.goldenLower, C.goldenFill);
    band(state.entryValue, low, C.redFill);
    if (showTp) band(high, state.targets.tp1, C.targetFill);

    const line = (v, color, dash, label) => {
      if (v < yMin || v > yMax) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(padL, y(v));
      ctx.lineTo(padL + plotW, y(v));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '12px ' + FONT;
      ctx.textAlign = 'left';
      ctx.fillText(label, padL + plotW + 6, y(v) + 4);
    };

    line(high, C.high, [2, 3], '1  ' + fmtUsdShort(high));
    {
      const gu = Number(FIB.GOLDEN_UPPER);
      const gl = Number(FIB.GOLDEN_LOWER);
      const gLabel = (r) => String(r).replace(/0+$/, '').replace(/\.$/, '');
      if (gu === gl) {
        line(lv.goldenUpper, C.golden, [6, 4], gLabel(gu) + '  ' + fmtUsdShort(lv.goldenUpper));
      } else {
        line(lv.goldenUpper, C.golden, [6, 4], gLabel(gu) + '  ' + fmtUsdShort(lv.goldenUpper));
        line(lv.goldenLower, C.golden, [6, 4], gLabel(gl) + '  ' + fmtUsdShort(lv.goldenLower));
      }
    }
    const ratios = Object.keys(lv.alerts)
      .map(Number)
      .sort((a, b) => b - a);
    for (const r of ratios) {
      const isEntry = r === state.entryRatio;
      line(lv.alerts[String(r)], isEntry ? C.red : C.mid, [6, 4], r.toFixed(3).replace(/0$/, '') + '  ' + fmtUsdShort(lv.alerts[String(r)]));
    }
    line(low, C.low, [2, 3], '0  ' + fmtUsdShort(low));
    if (showTp) line(state.targets.tp1, C.target, [8, 5], 'TP1  ' + fmtUsdShort(state.targets.tp1));

    // anchor trendline low → high (dotted diagonal, like the manual pull)
    const iLow = data.findIndex((c) => c.t >= state.anchors.low.t);
    const iHigh = data.findIndex((c) => c.t >= state.anchors.high.t);
    if (iLow >= 0 && iHigh > iLow) {
      ctx.strokeStyle = C.anchor;
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x(iLow), y(low));
      ctx.lineTo(x(iHigh), y(high));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // candles
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? C.up : C.down;
      ctx.fillStyle = up ? C.up : C.down;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(i), y(c.h));
      ctx.lineTo(x(i), y(c.l));
      ctx.stroke();
      const top = y(Math.max(c.o, c.c));
      const hgt = Math.max(1, Math.abs(y(c.o) - y(c.c)));
      ctx.fillRect(x(i) - cw / 2, top, cw, hgt);
    }

    // current value marker
    const cur = currentValue ?? data[data.length - 1].c;
    ctx.strokeStyle = C.price;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, y(cur));
    ctx.lineTo(padL + plotW, y(cur));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.price;
    ctx.font = 'bold 12px ' + FONT;
    ctx.fillText('▶ ' + fmtUsdShort(cur), padL + plotW + 6, y(cur) + 4);

    // header + watermark
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 16px ' + FONT;
    ctx.textAlign = 'left';
    const metric = state.metric === 'price' ? 'price' : 'mcap';
    ctx.fillText(symbol + ' · ' + state.timeframe + ' · fib cycle #' + state.cycleId + ' (' + metric + ')', padL, 26);
    ctx.fillStyle = C.textDim;
    ctx.font = '11px ' + FONT;
    ctx.textAlign = 'right';
    ctx.fillText('TAKE PROFITS BOT', W - 10, H - 8);

    return canvas.toBuffer('image/png');
  } catch (e) {
    console.error('[fib/chart] render failed:', e.message);
    return null;
  }
}
