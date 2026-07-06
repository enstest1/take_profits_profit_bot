#!/usr/bin/env node
import assert from 'assert';
import { normalizeXHandle, xHistoryLine, indexXAccount } from '../xSocial.js';

assert.equal(normalizeXHandle('@Pelp333'), 'pelp333');
assert.equal(normalizeXHandle('https://x.com/pelp333?s=21'), 'pelp333');
assert.equal(normalizeXHandle('twitter.com/pelp333/'), 'pelp333');
assert.equal(normalizeXHandle('x.com/status'), null);
assert.equal(normalizeXHandle('x.com/i/spaces/abc'), null);

const db = { tokens: {}, archived: {}, xAccounts: {} };
indexXAccount(db, 'scammer', 'mint1');
db.tokens.mint1 = { symbol: 'DEAD', peakMultiple: 0.2 };
const line = xHistoryLine(db, 'scammer', 'mint2');
assert.ok(line.includes('☠️'), 'all rugged should use skull prefix');

console.log('✅ xSocial tests passed');
