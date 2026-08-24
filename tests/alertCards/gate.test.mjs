import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAlertCardsEnabled, isAlertCardsEnabledForChannel } from '../../alertCards/index.js';

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('alert cards default on for every channel', () => {
  withEnv('ALERT_CARDS_ENABLED', undefined, () => {
    assert.equal(isAlertCardsEnabled(), true);
    assert.equal(isAlertCardsEnabledForChannel('999'), true);
    assert.equal(isAlertCardsEnabledForChannel('1452152164699869298'), true);
  });
});

test('ALERT_CARDS_ENABLED=false is the only way back to legacy cards', () => {
  withEnv('ALERT_CARDS_ENABLED', 'false', () => {
    assert.equal(isAlertCardsEnabled(), false);
    assert.equal(isAlertCardsEnabledForChannel('1452152164699869298'), false);
  });
});
