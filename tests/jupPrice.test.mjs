import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichTokenUsdFromJupiter } from '../jupPrice.js';

test('enrichTokenUsdFromJupiter leaves an existing Dex price alone', async () => {
  const token = { address: 'Mint11111111111111111111111111111111111111', price: '0.0042', symbol: 'X' };
  const out = await enrichTokenUsdFromJupiter(token);
  assert.equal(out.price, '0.0042');
  assert.equal(out.priceSource, undefined);
});
