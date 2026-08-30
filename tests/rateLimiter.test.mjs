import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateLimiter,
  setMaxAcquireWaitMsForTests,
  resetRateLimiterForTests,
  pauseRateLimiterUntilForTests,
} from '../rateLimiter.js';

test('acquire times out instead of sleeping through a long pause', async () => {
  resetRateLimiterForTests();
  setMaxAcquireWaitMsForTests(80);
  pauseRateLimiterUntilForTests(Date.now() + 60_000);
  const t0 = Date.now();
  await assert.rejects(
    () => rateLimiter.fetch('https://example.invalid/rate-test'),
    /acquire timed out/,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, 'acquire wait was ' + elapsed + 'ms');
  resetRateLimiterForTests();
});
