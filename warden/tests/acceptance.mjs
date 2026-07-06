#!/usr/bin/env node
/** Warden v2 acceptance tests — run: node warden/tests/acceptance.mjs */
import assert from 'assert';
import { checkOgImmutability } from '../checks/ogImmutability.js';
import { checkKeyHygiene } from '../checks/keyHygiene.js';
import { checkSchemaBounds } from '../checks/schemaBounds.js';
import { routeRequest } from '../../httpServer.js';
import http from 'http';

function snap(tokens = {}, archived = {}) {
  return { tokens, archived };
}

function collect(fn, prev, curr) {
  const issues = [];
  const raise = (id, sev, key, msg, diff) => issues.push({ id, sev, key, msg, diff });
  fn(prev, curr, raise);
  return issues;
}

// Test 5: repair twin
{
  const prev = snap({
    abcdefgh1234567890abcdefghijklmnopq: {
      address: 'abcdefgh1234567890abcdefghijklmnopq',
      postedBy: 'u',
      postedAt: 1,
      priceAtCall: '1',
    },
  });
  const curr = snap({
    Abcdefgh1234567890abcdefghijklmnopQ: {
      address: 'Abcdefgh1234567890abcdefghijklmnopQ',
      postedBy: 'u',
      postedAt: 1,
      priceAtCall: '1',
    },
  });
  const issues = collect(checkOgImmutability, prev, curr);
  assert.equal(issues.length, 0, 'repair twin should not alert');
}

// Test 8b: legit all-lowercase pump.fun mint — not REG-2
{
  const key = 'mgwxsefhmcuxxgj1vh9hdtrtjjmkmg1zdnbbq2vpump';
  const db = snap({
    [key]: {
      address: key,
      chain: 'solana',
      alertChannelId: '1',
      postedAt: Date.now() - 1e6,
      lastChecked: Date.now(),
      dexUrl: 'https://dexscreener.com/solana/' + key,
    },
  });
  const issues = [];
  checkKeyHygiene(db, (id, sev) => issues.push({ id, sev }), { legacyFrozen: [], frozenBroken: [], prevSnap: null });
  assert.equal(issues.filter((i) => i.id === 'REG-2').length, 0, 'lowercase pump mint should not REG-2');
}

// Test 8c: truly mangled mint — mixed case in dexUrl
{
  const key = 'mgwxsefhmcuxxgj1vh9hdtrtjjmkmg1zdnbbq2vpump';
  const canonical = 'MgWxsefhmcuxxgj1vh9hdtrtjjmkmg1zdnbbq2vpump';
  const db = snap({
    [key]: {
      address: key,
      alertChannelId: '1',
      dexUrl: 'https://dexscreener.com/solana/' + canonical,
    },
  });
  const issues = [];
  checkKeyHygiene(db, (id, sev) => issues.push({ id, sev }), { legacyFrozen: [], frozenBroken: [], prevSnap: null });
  assert.ok(issues.some((i) => i.id === 'REG-2'), 'mangled mint with mixed-case dexUrl should REG-2');
}

// Test 8: valid robinhood
{
  const key = 'robinhood:0xabc1234567890123456789012345678901234';
  const db = snap({
    [key]: {
      address: '0xabc1234567890123456789012345678901234',
      chain: 'robinhood',
      alertChannelId: '1',
      postedAt: Date.now() - 1e6,
      lastChecked: Date.now(),
    },
  });
  const issues = [];
  checkKeyHygiene(db, (id, sev) => issues.push({ id, sev }), { legacyFrozen: [], prevSnap: null });
  assert.equal(issues.length, 0, 'valid robinhood should be silent');
}

// Test 9: uppercase robinhood suffix
{
  const key = 'robinhood:0xABC1234567890123456789012345678901234';
  const db = snap({
    [key]: { address: '0xabc1234567890123456789012345678901234', chain: 'robinhood', alertChannelId: '1' },
  });
  const issues = [];
  checkKeyHygiene(db, (id, sev) => issues.push({ id, sev }), { legacyFrozen: [] });
  assert.ok(issues.some((i) => i.id === 'C3'), 'uppercase robinhood suffix should CRITICAL');
}

// Test 4: OG mutation
{
  const key = 'MintKey123';
  const prev = snap({ [key]: { postedAt: 100, postedBy: 'a', priceAtCall: '1' } });
  const curr = snap({ [key]: { postedAt: 200, postedBy: 'a', priceAtCall: '1' } });
  const issues = collect(checkOgImmutability, prev, curr);
  assert.ok(issues.some((i) => i.id === 'REG-1'), 'postedAt mutation should REG-1');
}

// Test 10: velocityWindow bloat
{
  const key = 'k';
  const db = snap({ [key]: { alertChannelId: '1', velocityWindow: new Array(40).fill(1) } });
  const issues = [];
  checkSchemaBounds(db, (id, sev) => issues.push({ id, sev }));
  assert.ok(issues.some((i) => i.id === 'C5b'));
}

// Test 1-3: HTTP routes
{
  const orig = process.env.WARDEN_TOKEN;
  process.env.WARDEN_TOKEN = 'test-token-secret';
  const server = http.createServer((req, res) => routeRequest(req, res, null, () => ({ tokens: {} })));
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;

  let res = await fetch(base + '/warden/status');
  assert.equal(res.status, 401);

  res = await fetch(base + '/warden/status', { headers: { authorization: 'Bearer test-token-secret' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('gitSha' in body);

  res = await fetch(base + '/warden/snapshot', { headers: { authorization: 'Bearer test-token-secret' } });
  const hash = res.headers.get('etag');
  res = await fetch(base + '/warden/snapshot', {
    headers: { authorization: 'Bearer test-token-secret', 'if-none-match': hash },
  });
  assert.equal(res.status, 304);

  server.close();
  process.env.WARDEN_TOKEN = orig;
}

console.log('✅ All Warden acceptance tests passed');
