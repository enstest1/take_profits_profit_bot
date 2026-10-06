import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebaseCallAnchor, shouldIgnoreCallPin, FRESH_CALL_MS } from '../signals/callAnchor.js';

const NOW = 1_000_000_000_000;

function fresh(extra = {}) {
  return {
    postedAt: NOW - 60_000,
    priceAtCall: '0.5',
    mcapAtCall: 50_000,
    pairAddress: 'pool-cheap',
    milestonesFired: [],
    ...extra,
  };
}

test('fresh unlocked call ignores its pin; aged and locked calls keep it', () => {
  assert.equal(shouldIgnoreCallPin(fresh(), NOW), true);
  assert.equal(shouldIgnoreCallPin(fresh({ postedAt: NOW - FRESH_CALL_MS - 1 }), NOW), false);
  assert.equal(shouldIgnoreCallPin(fresh({ anchorLocked: true }), NOW), false);
  assert.equal(shouldIgnoreCallPin(fresh({ postedAt: null }), NOW), false);
});

test('pair switch before any milestone rebases onto the live pool', () => {
  const reb = rebaseCallAnchor(
    fresh(),
    { price: '1', marketCap: 100_000, pairAddress: 'pool-real' },
    NOW,
  );
  assert.equal(reb.reason, 'pair-switch');
  assert.equal(reb.priceAtCall, '1');
  assert.equal(reb.mcapAtCall, 100_000);
  assert.equal(reb.pairAddress, 'pool-real');
});

test('same pool doubling is a real 1x and is not rebased', () => {
  const reb = rebaseCallAnchor(
    fresh(),
    { price: '1', marketCap: 100_000, pairAddress: 'pool-cheap' },
    NOW,
  );
  assert.equal(reb, null);
});

test('jupiter fill is replaced by the first AMM print', () => {
  const reb = rebaseCallAnchor(
    fresh({ priceSource: 'jupiter', pairAddress: null, priceAtCall: '0.4' }),
    { price: '1', marketCap: 100_000, pairAddress: 'pool-amm' },
    NOW,
  );
  assert.equal(reb.reason, 'jupiter-amm');
  assert.equal(reb.priceAtCall, '1');
});

test('unpinned call already at 2x rebases; a small gap does not', () => {
  const doubled = rebaseCallAnchor(
    fresh({ pairAddress: null }),
    { price: '1', marketCap: 100_000, pairAddress: 'pool-amm' },
    NOW,
  );
  assert.equal(doubled.reason, 'unpinned-gap');

  const small = rebaseCallAnchor(
    fresh({ pairAddress: null, priceAtCall: '0.9' }),
    { price: '1', marketCap: 100_000, pairAddress: 'pool-amm' },
    NOW,
  );
  assert.equal(small, null);
});

test('an old call or one that already alerted does not rebase', () => {
  const live = { price: '1', marketCap: 100_000, pairAddress: 'pool-real' };
  assert.equal(
    rebaseCallAnchor(fresh({ postedAt: NOW - FRESH_CALL_MS - 5_000 }), live, NOW),
    null,
  );
  assert.equal(rebaseCallAnchor(fresh({ milestonesFired: [1] }), live, NOW), null);
  assert.equal(rebaseCallAnchor(fresh({ anchorLocked: true }), live, NOW), null);
  assert.equal(rebaseCallAnchor(fresh({ gainAlertFired: true }), live, NOW), null);
});
