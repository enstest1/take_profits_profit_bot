import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLivePumpCap, pumpSpotPrice } from '../pumpfunApi.js';

test('applyLivePumpCap replaces the frozen curve price and drops the pin', () => {
  const token = {
    price: '0.00004975',
    marketCap: 49757,
    pairAddress: 'curve',
    dexId: 'pumpfun',
  };
  const ok = applyLivePumpCap(token, {
    usd_market_cap: 195_000,
    total_supply: 1_000_000_000_000_000,
    base_decimals: 6,
  });
  assert.equal(ok, true);
  assert.equal(token.marketCap, 195_000);
  assert.equal(token.pairAddress, null);
  assert.equal(token.priceSource, 'pump-curve');
  assert.ok(Math.abs(Number(token.price) - 0.000195) < 1e-12);
});

test('pumpSpotPrice uses the live cap when the curve reserves are stale', () => {
  const price = pumpSpotPrice({
    usd_market_cap: 195_000,
    total_supply: 1_000_000_000_000_000,
    base_decimals: 6,
  });
  assert.ok(Math.abs(price - 0.000195) < 1e-12);
});
