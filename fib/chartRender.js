/**
 * fib/chartRender.js — renders the entry-alert chart PNG (candles + fib overlay),
 * Rick-style: drawn server-side from OHLCV, attached to the embed. No screenshots.
 *
 * Layout (pelpa degen spec):
 *   • time axis along the bottom, dim price scale on the right
 *   • high/low callout tags at the anchors — high tag carries the impulse multiple (x)
 *   • current value shown as a gold pill on the right axis
 *   • the FULL golden pocket (.382 → entry) as one subtle gold box; fib levels are
 *     SOLID lines — gold .382, red .236 entry; no other fills
 *   • slim volume strip under the candles; ghost symbol watermark in the plot center
 *   • fired-alert markers: G / E dots where golden and entry actually triggered
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
    try {
      const { GlobalFonts } = canvasMod;
      const fs = await import('fs');
      const { fileURLToPath } = await import('url');
      const pathMod = await import('path');
      const here = pathMod.dirname(fileURLToPath(import.meta.url));
      // Repo-bundled fonts FIRST (Railway/nixpacks containers ship no system fonts —
      // without this every label, tag, and axis value silently renders as nothing).
      const bundled = [
        pathMod.join(here, 'assets', 'DejaVuSans.ttf'),
        pathMod.join(here, 'assets', 'DejaVuSans-Bold.ttf'),
      ];
      const system = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
      ];
      let registered = false;
      for (const p of bundled) {
        if (fs.existsSync(p)) {
          GlobalFonts.registerFromPath(p, 'FibSans');
          registered = true;
        }
      }
      if (!registered) {
        for (const p of system) {
          if (fs.existsSync(p)) {
            GlobalFonts.registerFromPath(p, 'FibSans');
            registered = true;
            break;
          }
        }
      }
      if (!registered) console.warn('[fib/chart] no chart font found — labels will be missing');
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
  bg: '#0a0e14',
  grid: '#151c26',
  axis: '#4a5563',
  up: '#22c55e',
  down: '#ef4444',
  gold: '#f0b90b',
  goldFill: 'rgba(240, 185, 11, 0.07)',
  entry: '#ef4444',
  mid: '#f59e0b',
  high: '#d7dde5',
  low: '#77808d',
  target: '#3b82f6',
  anchor: '#9ca3af',
  price: '#fbbf24',
  tagBg: '#101722',
  ghost: 'rgba(154, 165, 180, 0.06)',
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

const ratioLabel = (r) => String(r).replace(/0+$/, '').replace(/\.$/, '');

function fmtTime(ms, spanMs) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  if (spanMs <= 36 * 3_600_000) return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  return d.getUTCMonth() + 1 + '/' + d.getUTCDate() + ' ' + p(d.getUTCHours()) + 'h';
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * renderFibChart({ candles, state, symbol, currentValue }) → PNG Buffer | null
 * candles: chronological [{t,o,h,l,c,v?}] in the SAME metric as state (already converted).
 */
export async function renderFibChart({ candles, state, symbol = '', currentValue = null }) {
  try {
    if (!FIB.CHART_ENABLED) return null;
    const mod = await getCanvas();
    if (!mod || !candles?.length || !state?.levels || !state?.anchors) return null;

    // ---- x-range: start at the swing-low anchor (the origin of the pull) ----
    let lowIdx = candles.findIndex((c) => c.t >= state.anchors.low.t);
    if (lowIdx < 0) lowIdx = 0;
    // show where the bottom was pulled FROM: ~20% of the post-low span (min 12 candles)
    const pre = Math.max(12, Math.round((candles.length - lowIdx) * 0.2));
    let startIdx = Math.max(0, lowIdx - pre);
    startIdx = Math.min(startIdx, Math.max(0, candles.length - 60));
    const data = candles.slice(startIdx);

    const W = 900;
    const H = 520;
    const padL = 14;
    const padR = 112;
    const padT = 42;
    const hVol = 46;
    const hTime = 20;
    const gap = 6;
    const plotW = W - padL - padR;
    const plotH = H - padT - hVol - hTime - gap * 2;
    const volTop = padT + plotH + gap;

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
    const spanPad = (yMax - yMin) * 0.07 || yMax * 0.07 || 1;
    yMin -= spanPad;
    yMax += spanPad;

    const y = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
    const x = (i) => padL + (plotW * (i + 0.5)) / data.length;
    const cw = Math.max(1.2, Math.min(11, (plotW / data.length) * 0.66));

    const canvas = mod.createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const FONT = 'FibSans, DejaVu Sans, sans-serif';

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // grid + dim right-axis price scale (skips rows that would collide with fib labels)
    const labelYs = [];
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    const gridRows = [];
    for (let g = 0; g <= 4; g++) {
      const gy = padT + (plotH * g) / 4;
      gridRows.push(gy);
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(padL + plotW, gy);
      ctx.stroke();
    }

    // ghost watermark in plot center (Rick-style)
    ctx.fillStyle = C.ghost;
    ctx.font = 'bold 58px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillText(symbol + ' · ' + state.timeframe, padL + plotW / 2, padT + plotH / 2 + 20);
    ctx.textAlign = 'left';

    // ---- the FULL golden pocket: one subtle gold box, goldenUpper → goldenLower ----
    const gu = Number(FIB.GOLDEN_UPPER);
    const gl = Number(FIB.GOLDEN_LOWER);
    if (gu !== gl) {
      const top = Math.min(y(lv.goldenUpper), y(lv.goldenLower));
      const h = Math.abs(y(lv.goldenUpper) - y(lv.goldenLower));
      ctx.fillStyle = C.goldFill;
      ctx.fillRect(padL, top, plotW, h);
    }

    const line = (v, color, width, label, { bold = false } = {}) => {
      if (v < yMin || v > yMax) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(padL, y(v));
      ctx.lineTo(padL + plotW, y(v));
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = (bold ? 'bold 12px ' : '12px ') + FONT;
      ctx.fillText(label, padL + plotW + 6, y(v) + 4);
      labelYs.push(y(v));
    };

    line(high, C.high, 1.2, '1  ' + fmtUsdShort(high));
    line(lv.goldenUpper, C.gold, 2, ratioLabel(gu) + '  ' + fmtUsdShort(lv.goldenUpper), { bold: true });
    const ratios = Object.keys(lv.alerts).map(Number).sort((a, b) => b - a);
    for (const r of ratios) {
      const isEntry = r === state.entryRatio;
      line(lv.alerts[String(r)], isEntry ? C.entry : C.mid, isEntry ? 2 : 1.4, ratioLabel(r) + '  ' + fmtUsdShort(lv.alerts[String(r)]), { bold: isEntry });
    }
    if (gu !== gl && Math.abs(lv.goldenLower - (lv.alerts[String(state.entryRatio)] ?? -1)) > (yMax - yMin) / 400) {
      line(lv.goldenLower, C.gold, 1, ratioLabel(gl));
    }
    line(low, C.low, 1, '0  ' + fmtUsdShort(low));
    if (showTp) line(state.targets.tp1, C.target, 1.5, 'TP1  ' + fmtUsdShort(state.targets.tp1));

    // dim axis values on rows that are free of fib labels
    ctx.font = '10px ' + FONT;
    ctx.fillStyle = C.axis;
    for (const gy of gridRows) {
      if (labelYs.some((ly) => Math.abs(ly - gy) < 14)) continue;
      const val = yMin + ((padT + plotH - gy) / plotH) * (yMax - yMin);
      ctx.fillText(fmtUsdShort(val), padL + plotW + 6, gy + 3);
    }

    // ---- the fib pull: grey dashed diagonal low → high with anchor handles ----
    const iLow = data.findIndex((c) => c.t >= state.anchors.low.t);
    const iHigh = data.findIndex((c) => c.t >= state.anchors.high.t);
    if (iLow >= 0 && iHigh >= iLow) {
      const x1 = x(iLow);
      const y1 = y(low);
      const x2 = x(iHigh);
      const y2 = y(high);
      ctx.strokeStyle = C.anchor;
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      // anchor handles (TradingView-style drag points)
      for (const [hx, hy] of [[x1, y1], [x2, y2]]) {
        ctx.beginPath();
        ctx.arc(hx, hy, 4, 0, Math.PI * 2);
        ctx.fillStyle = C.bg;
        ctx.fill();
        ctx.strokeStyle = C.anchor;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
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

    // volume strip
    let vMax = 0;
    for (const c of data) if (Number.isFinite(c.v) && c.v > vMax) vMax = c.v;
    if (vMax > 0) {
      for (let i = 0; i < data.length; i++) {
        const c = data[i];
        if (!Number.isFinite(c.v) || c.v <= 0) continue;
        const bh = Math.max(1, Math.sqrt(c.v / vMax) * hVol);
        ctx.fillStyle = c.c >= c.o ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)';
        ctx.fillRect(x(i) - cw / 2, volTop + hVol - bh, cw, bh);
      }
    }

    // time axis
    ctx.fillStyle = C.axis;
    ctx.font = '10px ' + FONT;
    ctx.textAlign = 'center';
    const spanMs = data[data.length - 1].t - data[0].t;
    for (let k = 0; k <= 4; k++) {
      const i = Math.round((k * (data.length - 1)) / 4);
      ctx.fillText(fmtTime(data[i].t, spanMs), x(i), volTop + hVol + 14);
    }
    ctx.textAlign = 'left';

    // fired-alert markers: where golden / entry actually triggered this cycle
    const markAt = (ts, value, color, letter) => {
      if (!ts) return;
      let mi = -1;
      for (let i = 0; i < data.length; i++) if (data[i].t <= ts) mi = i;
      if (mi < 0) return;
      const mx = x(mi);
      const my = y(value);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(mx, my, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0a0e14';
      ctx.font = 'bold 9px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillText(letter, mx, my + 3);
      ctx.textAlign = 'left';
    };
    markAt(state.fired?.golden, lv.goldenUpper, C.gold, 'G');
    markAt(state.fired?.alerts?.[String(state.entryRatio)], lv.alerts[String(state.entryRatio)], C.entry, 'E');

    // high/low callout tags (Rick-style) — high tag carries the impulse multiple
    const tag = (px, py, text, border, above) => {
      ctx.font = 'bold 12px ' + FONT;
      const tw = ctx.measureText(text).width + 14;
      const th = 20;
      let tx = Math.min(Math.max(px - tw / 2, padL + 2), padL + plotW - tw - 2);
      let ty = above ? py - th - 9 : py + 9;
      ty = Math.min(Math.max(ty, padT + 2), padT + plotH - th - 2);
      ctx.fillStyle = C.tagBg;
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.4;
      roundedRect(ctx, tx, ty, tw, th, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = border;
      ctx.beginPath();
      if (above) {
        ctx.moveTo(px - 4, ty + th);
        ctx.lineTo(px + 4, ty + th);
        ctx.lineTo(px, ty + th + 5);
      } else {
        ctx.moveTo(px - 4, ty);
        ctx.lineTo(px + 4, ty);
        ctx.lineTo(px, ty - 5);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#e5e7eb';
      ctx.textAlign = 'center';
      ctx.fillText(text, tx + tw / 2, ty + 14);
      ctx.textAlign = 'left';
    };
    const impulseX = low > 0 ? (high / low).toFixed(1) + 'x' : '';
    if (iHigh >= 0) tag(x(iHigh), y(high), fmtUsdShort(high) + (impulseX ? ' · ' + impulseX : ''), C.up, true);
    if (iLow >= 0) tag(x(iLow), y(low), fmtUsdShort(low), C.low, false);

    // current value: gold pill on the right axis
    const cur = currentValue ?? data[data.length - 1].c;
    ctx.strokeStyle = C.price;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y(cur));
    ctx.lineTo(padL + plotW, y(cur));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = 'bold 12px ' + FONT;
    const pText = fmtUsdShort(cur);
    const pw = ctx.measureText(pText).width + 12;
    const pyy = Math.min(Math.max(y(cur) - 10, padT), padT + plotH - 20);
    ctx.fillStyle = C.tagBg;
    ctx.strokeStyle = C.price;
    roundedRect(ctx, padL + plotW + 3, pyy, pw, 20, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.price;
    ctx.fillText(pText, padL + plotW + 9, pyy + 14);

    // header + watermark
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 16px ' + FONT;
    const metric = state.metric === 'price' ? 'price' : 'mcap';
    ctx.fillText(symbol + ' · ' + state.timeframe + ' · fib cycle #' + state.cycleId + ' (' + metric + ')', padL, 26);
    ctx.fillStyle = C.axis;
    ctx.font = '11px ' + FONT;
    ctx.textAlign = 'right';
    ctx.fillText('GOLDEN POCKET · TAKE PROFITS', W - 10, H - 6);
    ctx.textAlign = 'left';

    return canvas.toBuffer('image/png');
  } catch (e) {
    console.error('[fib/chart] render failed:', e.message);
    return null;
  }
}
