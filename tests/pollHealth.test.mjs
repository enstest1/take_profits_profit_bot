import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pollHealth,
  recordCycle,
  resetCycleStatsForTests,
  BOOT_GRACE_MS,
} from '../cycleStats.js';
import { routeRequest } from '../httpServer.js';

test('pollHealth is ok during boot grace with no cycle yet', () => {
  resetCycleStatsForTests({ bootAt: Date.now(), lastCycleAt: 0 });
  const h = pollHealth();
  assert.equal(h.ok, true);
  assert.equal(h.reason, 'booting');
});

test('pollHealth fails after grace if no cycle completed', () => {
  resetCycleStatsForTests({
    bootAt: Date.now() - BOOT_GRACE_MS - 1000,
    lastCycleAt: 0,
  });
  const h = pollHealth();
  assert.equal(h.ok, false);
  assert.equal(h.reason, 'no-cycle');
});

test('pollHealth is stale after 3x poll interval', () => {
  const interval = 180_000;
  resetCycleStatsForTests({
    bootAt: Date.now() - 60_000,
    lastCycleAt: Date.now() - interval * 3 - 1000,
    pollIntervalMs: interval,
  });
  const h = pollHealth();
  assert.equal(h.ok, false);
  assert.equal(h.reason, 'stale');
});

test('recordCycle makes pollHealth ok', () => {
  resetCycleStatsForTests({
    bootAt: Date.now() - BOOT_GRACE_MS - 1000,
    lastCycleAt: 0,
  });
  recordCycle({ ms: 10, scheduledSol: 1, scheduledRh: 0, broken: 0, rate429Streak: 0 });
  const h = pollHealth();
  assert.equal(h.ok, true);
  assert.equal(h.reason, 'ok');
});

test('/health is 503 when poller is stale', () => {
  resetCycleStatsForTests({
    bootAt: Date.now() - BOOT_GRACE_MS - 1000,
    lastCycleAt: Date.now() - 20 * 60 * 1000,
    pollIntervalMs: 180_000,
  });
  let status = 0;
  let body = '';
  const res = {
    writeHead(code) { status = code; },
    end(s) { body = s; },
  };
  routeRequest({ url: '/health', method: 'GET', headers: {} }, res, {}, () => ({}));
  assert.equal(status, 503);
  assert.equal(body, 'stale');
});

test('/health is 200 when poller is fresh', () => {
  resetCycleStatsForTests({ bootAt: Date.now() - 1000, lastCycleAt: 0 });
  recordCycle({ ms: 5, scheduledSol: 0, scheduledRh: 0, broken: 0, rate429Streak: 0 });
  let status = 0;
  let body = '';
  const res = {
    writeHead(code) { status = code; },
    end(s) { body = s; },
  };
  routeRequest({ url: '/health', method: 'GET', headers: {} }, res, {}, () => ({}));
  assert.equal(status, 200);
  assert.equal(body, 'ok');
});
