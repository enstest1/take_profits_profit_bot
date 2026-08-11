#!/usr/bin/env node
/** Regenerate assets/mock/cashbird-price-chart.png — price-only, no fib overlay. */
import { writeFileSync } from 'fs';
import { fetchCandles, resolveTopPool } from '../fib/geckoTerminal.js';
import { resolveTokenForFib } from '../fib/resolve.js';
import { renderPriceChart } from '../fib/chartRender.js';

const CA = '0x91554e79a17c18990034d1ec3c4f492086d7b2cc';
const CHAIN = 'robinhood';
const TF = '1h';
const OUT = 'assets/mock/cashbird-price-chart.png';

const res = await resolveTokenForFib(CA, CHAIN);
if (!res.ok) {
  console.error('resolve failed:', res.error);
  process.exit(1);
}

let pool = res.pairAddress;
if (!pool) {
  const r = await resolveTopPool(CHAIN, res.address);
  if (r.error) {
    console.error('pool failed:', r.error);
    process.exit(1);
  }
  pool = r.poolAddress;
}

const got = await fetchCandles(CHAIN, pool, TF, { fresh: true });
if (got.error) {
  console.error('candles failed:', got.error);
  process.exit(1);
}

const factor = res.marketCap && res.price ? res.marketCap / res.price : null;
const candles = factor
  ? got.candles.map((c) => ({ ...c, o: c.o * factor, h: c.h * factor, l: c.l * factor, c: c.c * factor }))
  : got.candles;

const callMcap = 26_000;
const png = await renderPriceChart({
  candles,
  symbol: res.symbol,
  timeframe: TF,
  callValue: callMcap,
  currentValue: candles.at(-1).c,
});

if (!png) {
  console.error('renderPriceChart returned null');
  process.exit(1);
}

writeFileSync(OUT, png);
console.log('wrote', OUT, '(' + png.length + ' bytes)');
