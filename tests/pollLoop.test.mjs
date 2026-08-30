import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTokenPollLoop, startPollWatchdog } from '../pollLoop.js';
import { resetCycleStatsForTests, BOOT_GRACE_MS } from '../cycleStats.js';
import { withTimeout } from '../asyncTimeout.js';

test('withTimeout rejects when the promise never settles', async () => {
  const hung = new Promise(() => {});
  await assert.rejects(() => withTimeout(hung, 30, 'unit'), /timed out after 30ms/);
});

test('runTokenPollLoop exits when a cycle exceeds the timeout', async () => {
  let exitCode = null;
  const hung = () => new Promise(() => {});
  await runTokenPollLoop({}, {
    pollTokens: hung,
    cycleTimeoutMs: 40,
    intervalMs: 10,
    minGapMs: 5,
    watchdog: false,
    exit: (code) => { exitCode = code; },
  });
  assert.equal(exitCode, 1);
});

test('runTokenPollLoop keeps going after a non-timeout error', async () => {
  let calls = 0;
  let exitCode = null;
  const poll = async () => {
    calls += 1;
    if (calls === 1) throw new Error('dex blip');
    // Second call: prove we survived, then stop the loop via the timeout path.
    throw new Error('pollTokens timed out after 1ms');
  };
  await runTokenPollLoop({}, {
    pollTokens: poll,
    cycleTimeoutMs: 200,
    intervalMs: 10,
    minGapMs: 5,
    watchdog: false,
    exit: (code) => { exitCode = code; },
  });
  assert.equal(calls, 2);
  assert.equal(exitCode, 1);
});

test('watchdog exits when pollHealth is stale', async () => {
  resetCycleStatsForTests({
    bootAt: Date.now() - BOOT_GRACE_MS - 1000,
    lastCycleAt: 0,
  });
  let exitCode = null;
  const timer = startPollWatchdog({
    everyMs: 20,
    exit: (code) => { exitCode = code; },
  });
  await new Promise((r) => setTimeout(r, 60));
  clearInterval(timer);
  assert.equal(exitCode, 1);
});
