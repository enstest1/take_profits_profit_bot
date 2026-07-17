import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { update, currentBar, reset } from '../minuteBars.js';

const M = 60_000;
const T = 1_700_000_000_000 - (1_700_000_000_000 % M); // aligned minute start

beforeEach(() => reset());

test('samples within one minute build o/h/l/c without closing', () => {
  assert.equal(update('k', 100, T + 1_000), null);
  assert.equal(update('k', 130, T + 20_000), null);
  assert.equal(update('k', 90, T + 40_000), null);
  assert.equal(update('k', 110, T + 59_000), null);
  const bar = currentBar('k');
  assert.deepEqual({ o: bar.o, h: bar.h, l: bar.l, c: bar.c }, { o: 100, h: 130, l: 90, c: 110 });
});

test('first sample of a new minute returns the closed previous bar', () => {
  update('k', 100, T + 1_000);
  update('k', 120, T + 30_000);
  const closed = update('k', 105, T + M + 2_000);
  assert.ok(closed);
  assert.equal(closed.start, T);
  assert.equal(closed.c, 120);
  assert.equal(currentBar('k').o, 105);
});

test('keys are independent and reset(key) clears one stream', () => {
  update('a', 1, T + 1_000);
  update('b', 2, T + 1_000);
  reset('a');
  assert.equal(currentBar('a'), null);
  assert.ok(currentBar('b'));
});

test('non-finite samples are ignored', () => {
  assert.equal(update('k', NaN, T + 1_000), null);
  assert.equal(currentBar('k'), null);
});
