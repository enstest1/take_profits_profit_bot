import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectImpulse, zigzagPivots, atrPercent } from '../swingDetector.js';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

/** Build candles from a close path with mild wicks. */
function candlesFrom(path) {
  const out = [];
  let prev = path[0];
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    const o = prev;
    const h = Math.max(o, c) * 1.02;
    const l = Math.min(o, c) * 0.98;
    out.push({ t: T0 + i * HOUR, o, h, l, c });
    prev = c;
  }
  return out;
}

const OPTS = { minImpulsePct: 1.0, minCandles: 20, pivotStrength: 3, reversalPct: 0.3, atrMult: 3, goldenUpper: 0.786, launchFallback: true };

test('detects a clean impulse: base → 5x pump → 30% retrace', () => {
  const base = Array(12).fill(100_000);
  const pump = [140_000, 200_000, 300_000, 420_000, 500_000];
  const retrace = [470_000, 430_000, 400_000, 380_000, 360_000];
  const candles = candlesFrom([...base, ...pump, ...retrace]);
  const det = detectImpulse(candles, OPTS);
  assert.equal(det.ok, true, det.reason);
  assert.ok(det.low.v < 110_000, 'low anchored near the base, got ' + det.low.v);
  assert.ok(det.high.v > 480_000, 'high anchored near the top, got ' + det.high.v);
  assert.equal(det.highConfirmed, true);
  assert.match(det.reason, /zigzag/);
});

test('high not confirmed while price still presses the top', () => {
  const base = Array(14).fill(100_000);
  const pump = [150_000, 250_000, 400_000, 500_000, 510_000, 515_000];
  const candles = candlesFrom([...base, ...pump]);
  const det = detectImpulse(candles, OPTS);
  if (det.ok) assert.equal(det.highConfirmed, false, 'top is still printing — must not confirm');
  else assert.equal(det.error, 'no_impulse');
});

test('launch fallback anchors min→max on short history', () => {
  const candles = candlesFrom([50_000, 70_000, 95_000, 130_000, 180_000, 160_000]);
  const det = detectImpulse(candles, OPTS);
  assert.equal(det.ok, true, det.reason);
  assert.match(det.reason, /launch-fallback/);
  assert.ok(det.high.v > det.low.v * 2);
});

test('launch fallback rejects when the high precedes the low (no bullish leg)', () => {
  const candles = candlesFrom([300_000, 220_000, 160_000, 120_000, 90_000]);
  const det = detectImpulse(candles, OPTS);
  assert.equal(det.ok, false);
  assert.equal(det.error, 'no_impulse');
});

test('flat noise yields no impulse', () => {
  const path = Array.from({ length: 40 }, (_, i) => 100_000 * (1 + 0.03 * Math.sin(i)));
  const det = detectImpulse(candlesFrom(path), OPTS);
  assert.equal(det.ok, false);
  assert.equal(det.error, 'no_impulse');
});

test('atrPercent and zigzagPivots behave sanely on a spike', () => {
  const candles = candlesFrom([...Array(10).fill(100), 150, 300, 600, 500, 420, 380]);
  const atr = atrPercent(candles, 14);
  assert.ok(atr > 0 && atr < 1);
  const piv = zigzagPivots(candles, 0.3);
  assert.ok(piv.length >= 1, 'expected at least one pivot, got ' + piv.length);
});

// The two origin-extension tests pin the walk-back rule itself, so they zero out the
// ATR contribution (atrMult: 0 → flat 30% zigzag threshold) for full determinism.
const OPTS_FLAT = { ...OPTS, atrMult: 0 };

test('extends the anchor to the impulse origin when interim highs are broken', () => {
  const base = Array(12).fill(100_000);
  const leg1 = [140_000, 200_000, 280_000];
  const pull = [200_000, 165_000]; // -41% → pivot low ABOVE the base
  const leg2 = [240_000, 340_000, 480_000, 650_000, 900_000]; // breaks the 280k interim high
  const retrace = [810_000, 730_000, 660_000, 610_000];
  const det = detectImpulse(candlesFrom([...base, ...leg1, ...pull, ...leg2, ...retrace]), OPTS_FLAT);
  assert.equal(det.ok, true, det.reason);
  assert.ok(det.low.v < 110_000, 'anchored at the base origin, got ' + det.low.v);
  assert.ok(det.high.v > 850_000, 'high stays at the final top, got ' + det.high.v);
  assert.match(det.reason, /origin-extended/);
});

test('does not extend across an unbroken prior cycle high (dead regime)', () => {
  const oldCycle = [500_000, 510_000, 800_000, 1_300_000, 2_000_000, 1_400_000, 900_000, 500_000, 300_000, 200_000];
  const base = [190_000, 195_000, 188_000, 192_000];
  const pump = [270_000, 380_000, 540_000, 760_000, 1_050_000, 1_400_000]; // never breaks the 2M top
  const retrace = [1_250_000, 1_100_000, 980_000, 900_000];
  const det = detectImpulse(candlesFrom([...oldCycle, ...base, ...pump, ...retrace]), OPTS_FLAT);
  assert.equal(det.ok, true, det.reason);
  // Extension MAY hop through the pump's own intrabar pivots — what must hold is that
  // it never crosses into the dead regime: anchor stays at the post-crash base, and the
  // high stays below the old unbroken top.
  assert.ok(det.low.v > 150_000 && det.low.v < 250_000, 'anchored at the post-crash base, got ' + det.low.v);
  assert.ok(det.high.v < 2_000_000, 'high stays in the current regime, got ' + det.high.v);
});
