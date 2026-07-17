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
