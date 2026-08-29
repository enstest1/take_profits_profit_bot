import assert from 'node:assert/strict';
import { MAX_MILESTONE_TIER, configuredMaxMilestoneTier, normalizeTakeProfitTiers } from '../milestones.js';

assert.equal(MAX_MILESTONE_TIER, 100);
assert.equal(configuredMaxMilestoneTier({}), 100);
assert.equal(configuredMaxMilestoneTier({ MILESTONE_MAX_TIER: '50' }), 50);
assert.equal(configuredMaxMilestoneTier({ MILESTONE_MAX_TIER: '999' }), 100);
assert.equal(configuredMaxMilestoneTier({ MILESTONE_MAX_TIER: 'nope' }), 100);

assert.deepEqual(normalizeTakeProfitTiers([1, 5, 20]), [1, 5, 20]);
assert.deepEqual(normalizeTakeProfitTiers([1, 25, 100]), [1, 25, 100]);
assert.deepEqual(normalizeTakeProfitTiers([1, 101]), [1]); // above cap stripped
assert.deepEqual(normalizeTakeProfitTiers([2, 5, 10, 20]), [1, 4, 9, 19]); // legacy gates

console.log('milestones.test.mjs OK');
