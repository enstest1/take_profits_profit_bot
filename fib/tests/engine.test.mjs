import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIB } from '../config.js';
import { initStateShell, armCycle, liveTick, barClose, recomputeDerived } from '../engine.js';

// TENDIES-like reference impulse (values are market cap USD). Never hardcoded in prod —
// this is just a realistic fixture: low $97.94K → high $8.03M.
const LOW = 97_940;
const HIGH = 8_030_000;
const RANGE = HIGH - LOW;
const det = (low = LOW, high = HIGH) => ({
  ok: true,
  low: { v: low, t: 1_000_000 },
  high: { v: high, t: 2_000_000 },
  highConfirmed: true,
  reason: 'test fixture',
});

const lvl = (r) => LOW + RANGE * r;

function armed(mode = 'standard', currentValue = null) {
  const s = initStateShell(mode, '1h', 1_000);
  s.metric = 'marketCap';
  const events = armCycle(s, det(), currentValue, 2_000);
  return { s, events };
}

/** Simulate evaluate.js's tick pattern: prev = persisted lastValue. */
function tick(s, value, now) {
  const prev = s.lastValue;
  return liveTick(s, prev, value, now);
}

test('armCycle computes low-anchored levels and both targets', () => {
  const { s } = armed();
  assert.equal(s.status, 'armed');
  assert.equal(s.cycleId, 1);
  assert.ok(Math.abs(s.levels.goldenUpper - lvl(0.382)) < 1e-6);
  assert.ok(Math.abs(s.levels.goldenLower - lvl(0.236)) < 1e-6);
  assert.ok(Math.abs(s.levels.alerts['0.236'] - lvl(0.236)) < 1e-6);
  assert.equal(s.levels.alerts['0.382'], undefined);
  assert.equal(s.entryRatio, 0.236);
  assert.ok(Math.abs(s.targets.tp1 - (LOW + 1.618 * RANGE)) < 1e-6);
  assert.ok(Math.abs(s.targets.tp2 - (HIGH + 1.236 * (HIGH - lvl(0.236)))) < 1e-6);
});

test('standard mode: golden needs consecutive confirming 1m closes; a recovery close cancels', () => {
  const { s } = armed('standard');
  tick(s, HIGH * 0.99, 10_000);
  let ev = tick(s, lvl(0.35), 11_000); // wick into/through the 0.382 golden
  assert.equal(ev.length, 0, 'no instant fire in standard mode');
  assert.equal(s.pending.golden, 0);

  ev = barClose(s, lvl(0.45), 12_000); // closes back above → wick filtered
  assert.equal(ev.length, 0);
  assert.equal(s.pending.golden, undefined);

  tick(s, lvl(0.45), 12_500);
  tick(s, lvl(0.35), 13_000);
  ev = barClose(s, lvl(0.35), 14_000);
  assert.equal(ev.length, 0);
  ev = barClose(s, lvl(0.34), 15_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'golden');
  assert.ok(s.fired.golden);

  tick(s, HIGH * 0.9, 16_000);
  ev = tick(s, lvl(0.33), 17_000);
  assert.equal(ev.filter((e) => e.kind === 'golden').length, 0);
});

test('fast mode: golden fires instantly on the live cross; entry is separate', () => {
  const { s } = armed('fast');
  tick(s, HIGH * 0.99, 10_000);
  let ev = tick(s, lvl(0.35), 11_000);
  assert.deepEqual(ev.map((e) => e.kind), ['golden']);
  ev = tick(s, lvl(0.20), 12_000);
  assert.deepEqual(ev.map((e) => e.kind), ['entry_touch']);
  assert.equal(ev[0].ratio, 0.236);
});

test('entry touch is instant even in standard mode and sweep-fires skipped levels in order', () => {
  const { s } = armed('standard');
  tick(s, HIGH * 0.99, 10_000);
  const ev = tick(s, lvl(0.20), 11_000);
  assert.deepEqual(ev.map((e) => e.kind), ['golden', 'entry_touch']);
  assert.equal(ev[1].ratio, 0.236);
  assert.equal(s.status, 'target_mode');
  const again = tick(s, lvl(0.19), 12_000);
  assert.equal(again.length, 0);
});

test('entry_held: consecutive closes back above entry, reset on a failed close', () => {
  const { s } = armed('standard');
  tick(s, HIGH * 0.99, 10_000);
  tick(s, lvl(0.20), 11_000);
  let ev = barClose(s, lvl(0.30), 12_000);
  assert.equal(ev.length, 0);
  ev = barClose(s, lvl(0.22), 13_000); // dipped back under entry → reset
  assert.equal(s.heldCount, 0);
  ev = barClose(s, lvl(0.30), 14_000);
  ev = barClose(s, lvl(0.31), 15_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'entry_held');
  assert.ok(s.fired.entryHeld);
});

test('target mode: reclaim → tp1 → tp2 fire in order on a gap, cycle completes', () => {
  const { s } = armed('standard');
  tick(s, HIGH * 0.99, 10_000);
  tick(s, lvl(0.20), 11_000);
  const ev = tick(s, s.targets.tp2 * 1.01, 12_000);
  assert.deepEqual(ev.map((e) => e.kind), ['reclaim', 'tp1', 'tp2']);
  assert.equal(s.status, 'completed');
});

test('invalidation: 1m close below the swing low ends the cycle', () => {
  const { s } = armed('standard');
  tick(s, lvl(0.5), 10_000);
  const ev = barClose(s, LOW * 0.98, 11_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'invalidated');
  assert.equal(s.status, 'invalidated');
  assert.equal(tick(s, lvl(0.5), 12_000).length, 0, 'no further alerts after invalidation');
});

test('pre-alert new high just extends the anchors (no event, levels move)', () => {
  const { s } = armed('standard');
  tick(s, HIGH * 0.99, 10_000);
  const ev = tick(s, HIGH * 1.4, 11_000);
  assert.equal(ev.length, 0);
  assert.ok(Math.abs(s.anchors.high.v - HIGH * 1.4) < 1e-6);
  assert.ok(s.levels.goldenUpper > lvl(0.382), 'levels recomputed upward');
});

test('post-alert new high ≤ threshold extends and KEEPS fired flags', () => {
  const { s } = armed('fast');
  tick(s, HIGH * 0.99, 10_000);
  tick(s, lvl(0.35), 11_000); // golden fired
  const ev = tick(s, HIGH * 1.1, 12_000);
  assert.equal(ev.length, 0);
  assert.ok(s.fired.golden, 'golden stays fired');
  assert.ok(Math.abs(s.anchors.high.v - HIGH * 1.1) < 1e-6);
});

test('post-alert new high > threshold requests a new cycle', () => {
  const { s } = armed('fast');
  tick(s, HIGH * 0.99, 10_000);
  tick(s, lvl(0.35), 11_000);
  const ev = tick(s, HIGH * (1 + FIB.REANCHOR_THRESHOLD) * 1.02, 12_000);
  assert.deepEqual(ev.map((e) => e.kind), ['new_cycle']);
});

test('restart resume: persisted lastValue prevents duplicate fires after a reboot', () => {
  const { s } = armed('fast');
  tick(s, HIGH * 0.99, 10_000);
  tick(s, lvl(0.35), 11_000);
  const revived = JSON.parse(JSON.stringify(s));
  const ev = liveTick(revived, revived.lastValue, lvl(0.34), 12_000);
  assert.equal(ev.length, 0, 'still inside/through golden → nothing re-fires');
});

test('arm-on-deepest: value already on the golden level announces golden only', () => {
  const { events, s } = armed('standard', lvl(0.382));
  assert.deepEqual(events.map((e) => e.kind), ['golden']);
  assert.ok(s.fired.golden);
  assert.ok(!s.fired.alerts['0.236']);
});

test('arm-on-deepest: value already below entry sweep-announces the whole ladder', () => {
  const { events, s } = armed('standard', lvl(0.1));
  assert.deepEqual(events.map((e) => e.kind), ['golden', 'entry_touch']);
  assert.equal(s.status, 'target_mode');
});

test('arm-on-deepest: value inside the pocket announces golden', () => {
  const { events, s } = armed('standard', lvl(0.30));
  assert.deepEqual(events.map((e) => e.kind), ['golden']);
  assert.ok(s.fired.golden);
  assert.ok(!s.fired.alerts['0.236']);
});

test('recomputeDerived keeps entry value in sync when the high slides', () => {
  const { s } = armed();
  s.anchors.high.v = HIGH * 2;
  recomputeDerived(s);
  assert.ok(Math.abs(s.entryValue - (LOW + (HIGH * 2 - LOW) * 0.236)) < 1e-6);
});
