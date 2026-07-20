#!/usr/bin/env node
/**
 * scripts/fib-simulate.mjs — dry-run the fib tracker against a real token from the CLI.
 *
 *   node scripts/fib-simulate.mjs <contract_address> [chain] [timeframe]
 *   npm run fib:simulate -- 0x45242320dbb855eea8fd36804c6487e10e97fcf9 robinhood 1h
 *
 * Resolves the token on DexScreener, pulls GeckoTerminal candles, runs the swing
 * detector + engine replay, prints the full report, and writes fib-sim-<SYMBOL>.png.
 * Nothing is written to tracked.json. Requires network (run on your machine/Railway).
 */

import { writeFileSync } from 'fs';
import { FIB } from '../fib/config.js';
import { initStateShell, armCycle, liveTick, barClose } from '../fib/engine.js';
import { detectImpulse } from '../fib/swingDetector.js';
import { fetchCandles, resolveTopPool, findNetworkSlug, gtNetworkFor } from '../fib/geckoTerminal.js';
import { resolveTokenForFib } from '../fib/resolve.js';
import { pairFromDexUrl } from '../fib/store.js';
import { renderFibChart } from '../fib/chartRender.js';

const [, , rawCa, chainArg, tfArg] = process.argv;
if (!rawCa) {
  console.log('usage: node scripts/fib-simulate.mjs <contract_address> [solana|robinhood] [1m|5m|15m|1h|4h]');
  process.exit(1);
}
const tf = tfArg || FIB.DEFAULT_TIMEFRAME;

const usd = (n) =>
  n == null || !Number.isFinite(n)
    ? '—'
    : Math.abs(n) >= 1e6
      ? '$' + (n / 1e6).toFixed(2) + 'M'
      : Math.abs(n) >= 1e3
        ? '$' + (n / 1e3).toFixed(1) + 'K'
        : '$' + n.toPrecision(4);

const res = await resolveTokenForFib(rawCa, chainArg || null);
if (!res.ok) {
  console.error('resolve failed:', res.error);
  process.exit(1);
}
console.log('token   :', res.symbol, '(' + res.name + ') on', res.chainId);
console.log('mcap    :', usd(res.marketCap), '| price', res.price, '| liq', usd(res.liquidity));
if (res.marketCap != null && res.marketCap < FIB.MIN_MCAP) {
  console.log('note    : below FIB_MIN_MCAP (' + usd(FIB.MIN_MCAP) + ') — the live tracker would hold in waiting_mcap');
}

let pool = res.pairAddress || pairFromDexUrl(res.dexUrl);
if (!pool) {
  const r = await resolveTopPool(res.chainId, res.address);
  if (r.error) {
    console.error('pool resolve failed:', r.error);
    if (r.error === 'token_not_indexed' || String(r.error).startsWith('unsupported_chain')) {
      const slug = await findNetworkSlug(res.chainId);
      console.error(
        slug
          ? '→ GeckoTerminal calls this network "' + slug.id + '". Set FIB_GT_NETWORK_' + res.chainId.toUpperCase() + '=' + slug.id
          : '→ Could not find a GT network matching "' + res.chainId + '" (tried slug "' + gtNetworkFor(res.chainId) + '")',
      );
    }
    process.exit(1);
  }
  pool = r.poolAddress;
}
console.log('pool    :', pool, '| timeframe', tf);

const got = await fetchCandles(res.chainId, pool, tf, { fresh: true });
if (got.error) {
  console.error('candles failed:', got.error);
  process.exit(1);
}
console.log('candles :', got.candles.length, '(' + new Date(got.candles[0].t).toISOString() + ' → ' + new Date(got.candles.at(-1).t).toISOString() + ')');

const factor = res.marketCap && res.price ? res.marketCap / res.price : null;
const candles = factor ? got.candles.map((c) => ({ ...c, o: c.o * factor, h: c.h * factor, l: c.l * factor, c: c.c * factor })) : got.candles;
console.log('metric  :', factor ? 'marketCap (supplyFactor ' + factor.toExponential(3) + ')' : 'price (no supply factor available)');

const det = detectImpulse(candles, {
  minImpulsePct: FIB.MIN_IMPULSE_PCT,
  minCandles: FIB.MIN_CANDLES,
  pivotStrength: FIB.PIVOT_STRENGTH,
  reversalPct: FIB.REVERSAL_PCT,
  atrMult: FIB.ATR_MULT,
  goldenUpper: FIB.HIGH_CONFIRM_RATIO,
  anchorOrigin: FIB.ANCHOR_ORIGIN,
  launchFallback: true,
});
console.log('\ndetector:', det.ok ? 'IMPULSE FOUND' : det.error);
console.log('reason  :', det.reason);
if (!det.ok) process.exit(0);
if (!det.highConfirmed) console.log('note    : high not confirmed yet — the live tracker would wait before arming');

const state = initStateShell('standard', tf);
state.metric = factor ? 'marketCap' : 'price';
state.supplyFactor = factor;
state.poolAddress = pool;
armCycle(state, det, null);

console.log('\nanchors : low ' + usd(det.low.v) + ' (' + new Date(det.low.t).toISOString() + ')');
console.log('          high ' + usd(det.high.v) + ' (' + new Date(det.high.t).toISOString() + ')');
console.log('golden  : ' + usd(state.levels.goldenUpper) + ' (' + FIB.GOLDEN_UPPER + ') → ' + usd(state.levels.goldenLower) + ' (' + FIB.GOLDEN_LOWER + ')');
for (const r of Object.keys(state.levels.alerts).map(Number).sort((a, b) => b - a)) {
  console.log('level   : ' + r + ' → ' + usd(state.levels.alerts[String(r)]) + (r === state.entryRatio ? '   ← ENTRY (chart alert)' : ''));
}
if (state.targets) {
  console.log('targets : TP1 ' + usd(state.targets.tp1) + ' (1.618 ext) · TP2 ' + usd(state.targets.tp2) + ' (re-pull off entry)');
}

// Replay candles after the swing high through the engine (tf-candle approximation).
const hiIdx = candles.findIndex((c) => c.t >= det.high.t);
let prev = null;
const fired = [];
for (let i = Math.max(0, hiIdx); i < candles.length; i++) {
  const c = candles[i];
  for (const v of [c.h, c.l]) {
    fired.push(...liveTick(state, prev, v, c.t).map((e) => ({ ...e, t: c.t })));
    prev = v;
  }
  fired.push(...barClose(state, c.c, c.t).map((e) => ({ ...e, t: c.t })));
  prev = c.c;
  if (state.status === 'invalidated' || state.status === 'completed') break;
}
console.log('\nreplay  :', fired.length ? '' : 'no alerts yet (price still above the golden zone)');
for (const e of fired) console.log('  •', new Date(e.t).toISOString(), e.kind, '@', usd(e.value));
console.log('end     :', state.status);

const png = await renderFibChart({ candles, state, symbol: res.symbol, currentValue: candles.at(-1).c });
if (png) {
  const out = 'fib-sim-' + res.symbol.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) + '.png';
  writeFileSync(out, png);
  console.log('chart   :', out, '(' + png.length + ' bytes)');
} else {
  console.log('chart   : renderer unavailable (charts will be text-only — see INTEGRATION.md)');
}
