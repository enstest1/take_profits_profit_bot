/**
 * fib/swingDetector.js — pure impulse detection. No I/O, no Discord, fully unit-testable.
 *
 * Contract (stable interface — swap the algorithm without touching callers):
 *   detectImpulse(candles, opts) → { ok:true, low:{v,t}, high:{v,t}, highConfirmed, reason }
 *                                | { ok:false, error, reason }
 *
 * candles: chronological [{ t, o, h, l, c }] in the SAME metric the tracker will use
 *          (caller converts price→marketCap via supplyFactor BEFORE calling).
 *
 * Baseline algorithm (v1):
 *   1. Noise floor: ATR%(14). ZigZag reversal threshold = max(opts.reversalPct, atrPct × opts.atrMult).
 *   2. ZigZag walk marks alternating pivot highs/lows.
 *   3. Latest qualifying impulse = most recent CONFIRMED pivot low whose run-up to the
 *      max high after it gains ≥ opts.minImpulsePct.
 *   4. Swing high = max high after that low. Confirmed when opts.pivotStrength candles have
 *      printed after it, OR price has already retraced to/below the 0.786 level.
 *   5. Launch fallback: with < minCandles history (fresh tokens), anchor low = lowest low,
 *      high = highest high, if the gain still clears minImpulsePct.
 */

export function atrPercent(candles, period = 14) {
  if (!candles || candles.length < 2) return 0;
  const n = Math.min(period, candles.length - 1);
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const prevClose = candles[i - 1].c;
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - prevClose),
      Math.abs(candles[i].l - prevClose),
    );
    const ref = candles[i].c || prevClose || 1;
    sum += tr / ref;
  }
  return sum / n;
}

/** ZigZag pivots: [{ idx, t, v, kind:'low'|'high' }]. Seeds the initial extreme as the
 *  first pivot (a base low before a pump IS a pivot low), then alternates on reversals. */
export function zigzagPivots(candles, reversalFrac) {
  const pivots = [];
  if (!candles || candles.length < 3) return pivots;

  let dir = 0; // 0 unknown, 1 up-leg (tracking a high), -1 down-leg (tracking a low)
  let minV = candles[0].l;
  let minI = 0;
  let maxV = candles[0].h;
  let maxI = 0;

  for (let i = 1; i < candles.length; i++) {
    const hi = candles[i].h;
    const lo = candles[i].l;

    if (dir === 0) {
      if (lo < minV) {
        minV = lo;
        minI = i;
      }
      if (hi > maxV) {
        maxV = hi;
        maxI = i;
      }
      if (minV > 0 && (hi - minV) / minV >= reversalFrac) {
        pivots.push({ idx: minI, t: candles[minI].t, v: minV, kind: 'low' });
        dir = 1;
        maxV = hi;
        maxI = i;
      } else if (maxV > 0 && (maxV - lo) / maxV >= reversalFrac) {
        pivots.push({ idx: maxI, t: candles[maxI].t, v: maxV, kind: 'high' });
        dir = -1;
        minV = lo;
        minI = i;
      }
      continue;
    }

    if (dir === 1) {
      if (hi > maxV) {
        maxV = hi;
        maxI = i;
      }
      if (maxV > 0 && (maxV - lo) / maxV >= reversalFrac) {
        pivots.push({ idx: maxI, t: candles[maxI].t, v: maxV, kind: 'high' });
        dir = -1;
        minV = lo;
        minI = i;
      }
    } else {
      if (lo < minV) {
        minV = lo;
        minI = i;
      }
      if (minV > 0 && (hi - minV) / minV >= reversalFrac) {
        pivots.push({ idx: minI, t: candles[minI].t, v: minV, kind: 'low' });
        dir = 1;
        maxV = hi;
        maxI = i;
      }
    }
  }
  return pivots;
}

function fmtX(mult) {
  return (Math.round(mult * 10) / 10).toFixed(1) + 'x';
}

export function detectImpulse(candles, opts = {}) {
  const o = {
    minImpulsePct: opts.minImpulsePct ?? 1.0,
    minCandles: opts.minCandles ?? 20,
    pivotStrength: opts.pivotStrength ?? 3,
    reversalPct: opts.reversalPct ?? 0.3,
    atrMult: opts.atrMult ?? 3,
    anchorOrigin: opts.anchorOrigin ?? true,
    goldenUpper: opts.goldenUpper ?? 0.786,
    launchFallback: opts.launchFallback ?? true,
  };

  if (!candles || candles.length < 3) {
    return { ok: false, error: 'insufficient_history', reason: 'Fewer than 3 candles available.' };
  }

  const last = candles[candles.length - 1];

  // --- Launch fallback for very fresh tokens ---
  if (candles.length < o.minCandles) {
    if (!o.launchFallback) {
      return {
        ok: false,
        error: 'insufficient_history',
        reason: candles.length + ' candles < required ' + o.minCandles + ' (launch fallback disabled).',
      };
    }
    let loI = 0;
    let hiI = 0;
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].l < candles[loI].l) loI = i;
      if (candles[i].h > candles[hiI].h) hiI = i;
    }
    if (hiI <= loI) {
      // High printed before the low — no bullish structure yet.
      return { ok: false, error: 'no_impulse', reason: 'Launch fallback: high precedes low — no bullish leg yet.' };
    }
    const low = candles[loI].l;
    const high = candles[hiI].h;
    const gain = low > 0 ? high / low - 1 : 0;
    if (gain < o.minImpulsePct) {
      return {
        ok: false,
        error: 'no_impulse',
        reason:
          'Launch fallback: best leg ' + fmtX(gain + 1) + ' < min impulse ' + fmtX(o.minImpulsePct + 1) + '.',
      };
    }
    const candlesAfterHigh = candles.length - 1 - hiI;
    const g786 = low + (high - low) * o.goldenUpper;
    const highConfirmed = candlesAfterHigh >= o.pivotStrength || last.c <= g786;
    return {
      ok: true,
      low: { v: low, t: candles[loI].t },
      high: { v: high, t: candles[hiI].t },
      highConfirmed,
      reason:
        'launch-fallback: only ' + candles.length + ' candles; low=lowest low, high=highest high, impulse ' +
        fmtX(gain + 1) + (highConfirmed ? '' : ' (high not yet confirmed)'),
    };
  }

  // --- Standard path: ATR-adjusted ZigZag ---
  const atrPct = atrPercent(candles, 14);
  // ATR raises the threshold in choppy regimes but is capped: a parabolic pump inflates
  // ATR% so much that a textbook 30-40% retrace would otherwise never register a pivot.
  const reversal = Math.max(o.reversalPct, Math.min(atrPct * o.atrMult, 0.6));
  const pivots = zigzagPivots(candles, reversal);

  const lastIdx = candles.length - 1;
  let best = null;

  // Most recent confirmed pivot low whose subsequent max-high clears the impulse filter.
  for (let p = pivots.length - 1; p >= 0; p--) {
    const piv = pivots[p];
    if (piv.kind !== 'low') continue;
    if (lastIdx - piv.idx < o.pivotStrength) continue; // pivot itself not confirmed yet
    let hiI = piv.idx;
    let hiV = candles[piv.idx].h;
    for (let i = piv.idx + 1; i <= lastIdx; i++) {
      if (candles[i].h > hiV) {
        hiV = candles[i].h;
        hiI = i;
      }
    }
    if (piv.v <= 0) continue;
    const gain = hiV / piv.v - 1;
    if (gain >= o.minImpulsePct) {
      best = { lowIdx: piv.idx, lowV: piv.v, hiIdx: hiI, hiV, gain, pIdx: p };
      break;
    }
  }

  if (!best) {
    return {
      ok: false,
      error: 'no_impulse',
      reason:
        'No confirmed pivot low with a ≥' + fmtX(o.minImpulsePct + 1) + ' leg (zigzag threshold ' +
        (reversal * 100).toFixed(1) + '%, ' + pivots.length + ' pivots).',
    };
  }

  // ---- extend to the impulse ORIGIN (manual-pull anchoring) ----
  // While the prior pivot low is strictly deeper AND the interim pivot high between
  // them was broken by the final top, the legs chain into ONE impulse (higher-lows
  // into higher-highs) — anchor where the whole move started, exactly like dragging
  // the fib from the base by hand. A prior cycle high that was never broken stops
  // the walk, so we never anchor into a dead regime.
  let originHops = 0;
  if (o.anchorOrigin) {
    let k = best.pIdx;
    while (k >= 2 && pivots[k - 1].kind === 'high' && pivots[k - 2].kind === 'low') {
      const interimHigh = pivots[k - 1];
      const priorLow = pivots[k - 2];
      if (best.hiV <= interimHigh.v) break; // unbroken prior high → older regime, hard stop
      if (priorLow.v > 0 && priorLow.v < best.lowV) {
        // deeper low inside a broken-high chain → the impulse started earlier; extend.
        // (max high after the earlier low is unchanged: everything between priorLow and
        // the old anchor tops out at interimHigh, which is below best.hiV.)
        best.lowIdx = priorLow.idx;
        best.lowV = priorLow.v;
        originHops++;
      }
      // not deeper → an intrabar/step pivot inside the same chain: step through it.
      // Giant memecoin candles emit same-candle pivot pairs; they must not end the walk.
      k -= 2;
    }
    if (originHops) best.gain = best.hiV / best.lowV - 1;
  }

  const candlesAfterHigh = lastIdx - best.hiIdx;
  const g786 = best.lowV + (best.hiV - best.lowV) * o.goldenUpper;
  const highConfirmed = candlesAfterHigh >= o.pivotStrength || last.c <= g786;

  return {
    ok: true,
    low: { v: best.lowV, t: candles[best.lowIdx].t },
    high: { v: best.hiV, t: candles[best.hiIdx].t },
    highConfirmed,
    reason:
      'zigzag(threshold ' + (reversal * 100).toFixed(1) + '% = max(' + (o.reversalPct * 100).toFixed(0) +
      '%, ATR ' + (atrPct * 100).toFixed(1) + '%×' + o.atrMult + ')): pivot low @ candle ' + best.lowIdx +
      ' → high @ candle ' + best.hiIdx + ', impulse ' + fmtX(best.gain + 1) +
      ', ' + candlesAfterHigh + ' candles since high' +
      (originHops ? ', origin-extended ' + originHops + ' leg(s) back to candle ' + best.lowIdx + ' (interim highs broken)' : '') +
      (highConfirmed ? '' : ' (high not yet confirmed)'),
  };
}
