import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractVolumeWindowsFromPair,
  windowsFrom5mCandles,
} from '../../alertCards/windows.js';

test('extractVolumeWindowsFromPair uses h1 and m5 proxies', () => {
  const pair = {
    volume: { h1: 1000, m5: 50 },
    priceChange: { h1: 10, m5: 2 },
  };
  const w = extractVolumeWindowsFromPair(pair);
  assert.equal(w[0].label, '1h');
  assert.equal(w[0].vol, 1000);
  assert.equal(w[0].pct, 10);
  assert.equal(w[1].vol, 300); // m5 * 6
  assert.equal(w[2].vol, 150); // m5 * 3
});

test('windowsFrom5mCandles aggregates last N bars', () => {
  const candles = [];
  for (let i = 0; i < 12; i++) {
    candles.push({ o: 100, c: 110, v: 10 });
  }
  const w = windowsFrom5mCandles(candles);
  assert.equal(w[0].vol, 120);
  assert.ok(Math.abs(w[0].pct - 10) < 0.01);
  assert.equal(w[1].vol, 60);
  assert.equal(w[2].vol, 30);
});
