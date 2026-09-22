import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBestPair, trackedTokenFromPool, scorePair } from '../pairSelect.js';
import { multiplesFromLive } from '../signals/mult.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const MINT = 'Mint11111111111111111111111111111111111111';

function pair({
  base = MINT,
  quote = WSOL,
  liq = 1000,
  priceUsd = '0.001',
  pairAddress = 'pool1',
  vol = {},
} = {}) {
  return {
    pairAddress,
    priceUsd,
    baseToken: { address: base, symbol: 'MEME' },
    quoteToken: { address: quote, symbol: 'SOL' },
    liquidity: { usd: liq },
    volume: { m5: vol.m5 || 0, h1: vol.h1 || 0, h24: vol.h24 || 0 },
  };
}

test('selectBestPair prefers TOKEN/SOL over a higher-liq quote-side pair', () => {
  const quoteSide = pair({
    base: WSOL,
    quote: MINT,
    liq: 500_000,
    pairAddress: 'ghost',
    vol: { h24: 10 },
  });
  const baseSide = pair({
    liq: 8_000,
    pairAddress: 'real',
    vol: { m5: 400, h1: 2000 },
  });
  const picked = selectBestPair([quoteSide, baseSide], MINT, { chainId: 'solana' });
  assert.equal(picked.pairAddress, 'real');
});

test('selectBestPair keeps a live pinned pool', () => {
  const pinned = pair({ liq: 2_000, pairAddress: 'pin', vol: { m5: 50 } });
  const louder = pair({ liq: 90_000, pairAddress: 'new', vol: { m5: 9000 } });
  const picked = selectBestPair([pinned, louder], MINT, {
    chainId: 'solana',
    pinnedPair: 'pin',
  });
  assert.equal(picked.pairAddress, 'pin');
});

test('selectBestPair ignores quote-only rows instead of using the other token price', () => {
  const quoteOnly = pair({ base: WSOL, quote: MINT, liq: 80_000, pairAddress: 'inv' });
  assert.equal(selectBestPair([quoteOnly], MINT, { chainId: 'solana' }), null);
});

test('priced Meteora AMM beats unpriced meteoradbc bonding-curve row', () => {
  const dbc = pair({
    pairAddress: 'dbc',
    priceUsd: null,
    liq: 0,
    vol: {},
  });
  dbc.dexId = 'meteoradbc';
  dbc.priceNative = '0.0001360';
  const amm = pair({
    pairAddress: 'amm',
    priceUsd: '0.00000546',
    liq: 2_000,
    vol: { m5: 400, h1: 2_000 },
  });
  amm.dexId = 'meteora';
  const picked = selectBestPair([dbc, amm], MINT, { chainId: 'solana' });
  assert.equal(picked.pairAddress, 'amm');
});

test('selectBestPair still returns a DBC-only row so Jupiter can price it', () => {
  const dbc = pair({ pairAddress: 'dbc-only', priceUsd: null, liq: 0 });
  const picked = selectBestPair([dbc], MINT, { chainId: 'solana' });
  assert.equal(picked.pairAddress, 'dbc-only');
});

test('recent volume beats a dead high-liq Meteora ghost', () => {
  const ghost = pair({ liq: 2_000_000, pairAddress: 'ghost', vol: { h24: 12 } });
  const live = pair({ liq: 40_000, pairAddress: 'live', vol: { m5: 12_000, h1: 40_000 } });
  assert.ok(scorePair(live, MINT, 'solana') > scorePair(ghost, MINT, 'solana'));
  const picked = selectBestPair([ghost, live], MINT, { chainId: 'solana' });
  assert.equal(picked.pairAddress, 'live');
});

test('Arc native USDC quote is recognized', () => {
  const ARC_USDC = '0x3600000000000000000000000000000000000000';
  const ARCAT = '0x07704B06981eA962b87296362a1281484d160000';
  const p = {
    pairAddress: 'arc-pool',
    priceUsd: '0.002',
    baseToken: { address: ARCAT, symbol: 'ARCAT' },
    quoteToken: { address: ARC_USDC, symbol: 'USDC' },
    liquidity: { usd: 200000 },
    volume: { m5: 20000, h1: 500000, h24: 2e6 },
  };
  const picked = selectBestPair([p], ARCAT, { chainId: 'arc' });
  assert.equal(picked.pairAddress, 'arc-pool');
});

test('trackedTokenFromPool returns the meme when SOL is listed as base', () => {
  const inverted = pair({ base: WSOL, quote: MINT });
  assert.equal(trackedTokenFromPool(inverted, 'solana'), MINT);
  const normal = pair({ base: MINT, quote: WSOL });
  assert.equal(trackedTokenFromPool(normal, 'solana'), MINT);
});

test('multiplesFromLive uses price when mcap is a glitch 3x apart', () => {
  const { currentMultiple } = multiplesFromLive(
    { priceAtCall: '1', mcapAtCall: '1000' },
    { price: '2', marketCap: '20000' },
  );
  assert.equal(currentMultiple, 2);
});

test('multiplesFromLive still takes the higher when price and mcap nearly agree', () => {
  const { currentMultiple } = multiplesFromLive(
    { priceAtCall: '1', mcapAtCall: '1000' },
    { price: '2', marketCap: '2200' },
  );
  assert.equal(currentMultiple, 2.2);
});
