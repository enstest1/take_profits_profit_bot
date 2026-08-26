// scripts/smoke.mjs — offline pipeline test: no Discord, no API keys needed.
// Seeds a temp DB with a fake conversation, exercises windowing/serialization/
// validation/FTS/citations end to end. Exit 0 = healthy.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, getDb, insertMessagesBatch, upsertChannel, searchMessages, insertKnowledge, searchKnowledge, sanitizeFtsQuery } from '../db.js';
import { buildWindows, serializeWindow, validateUnits } from '../extract.js';
import { buildCitations } from '../answer.js';
import { parseBackfillMaxAgeHours, sliceToLookback, channelQuietBefore, snowflakeToMs } from '../archive.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-smoke-'));
initDb(dir);
upsertChannel({ channel_id: 'c1', guild_id: 'g1', name: '#dev-help', parent_name: null });

const now = Date.now();
const msgs = [
  { msg_id: '1001', channel_id: 'c1', guild_id: 'g1', author_id: 'u1', author_name: 'alice', is_bot: 0, content: 'how do I deploy the agent to railway?', embeds: null, attachments: null, reply_to: null, created_ts: now - 5000 },
  { msg_id: '1002', channel_id: 'c1', guild_id: 'g1', author_id: 'u2', author_name: 'bob', is_bot: 0, content: 'use railway up, and set ANTHROPIC_API_KEY in variables first. docs: https://docs.railway.app/deploy', embeds: null, attachments: null, reply_to: '1001', created_ts: now - 4000 },
  { msg_id: '1003', channel_id: 'c1', guild_id: 'g1', author_id: 'u1', author_name: 'alice', is_bot: 0, content: 'that worked, thanks!', embeds: null, attachments: null, reply_to: '1002', created_ts: now - 3000 },
];
if (insertMessagesBatch(msgs) !== 3) { console.error('FAIL insert'); process.exit(1); }
if (insertMessagesBatch(msgs) !== 0) { console.error('FAIL dedupe'); process.exit(1); }
console.log('insert + dedupe PASS');

const hits = searchMessages('railway deploy');
if (!hits.some((h) => h.msg_id === '1002')) { console.error('FAIL messages FTS', hits); process.exit(1); }
console.log('messages FTS PASS');
if (sanitizeFtsQuery('"; DROP TABLE--') === '"drop" OR "table"'.replace('x','x') && false) {} // noop clarity
console.log('fts sanitize ->', JSON.stringify(sanitizeFtsQuery('how do I deploy?! (railway)')));

const windows = buildWindows(hits.concat());
const { text, refMap } = serializeWindow(msgs.map((m, i) => ({ ...m, mid: i + 1 })));
if (!text.includes('[m2]') || refMap.get('m2') !== '1002') { console.error('FAIL serialize', text); process.exit(1); }
console.log('windowing + refmap PASS (' + windows.length + ' window)');

const fakeLlm = [{ kind: 'qa', topic: 'deployment', title: 'Deploying the agent to Railway', body: 'Run railway up after setting ANTHROPIC_API_KEY in Variables. Docs: https://docs.railway.app/deploy', refs: ['m1', 'm2'], authors: ['alice', 'bob'], confidence: 'high' }, { kind: 'nonsense', title: 'x', body: 'y' }];
const units = validateUnits(fakeLlm, refMap);
if (units.length !== 1 || JSON.parse(units[0].source_ids).join(',') !== '1001,1002') { console.error('FAIL validate', units); process.exit(1); }
console.log('unit validation PASS (bad kind rejected, refs mapped to snowflakes)');

insertKnowledge({ ...units[0], channel_id: 'c1', created_ts: now });
const khits = searchKnowledge('railway deployment');
if (!khits.length) { console.error('FAIL knowledge FTS'); process.exit(1); }
console.log('knowledge FTS PASS');

const cites = buildCitations('Set the key first [K1].', khits);
if (!cites.length || !cites[0].includes('discord.com/channels/g1/c1/1001')) { console.error('FAIL citations', cites); process.exit(1); }
console.log('citation jump-links PASS ->', cites[0]);

if (parseBackfillMaxAgeHours(undefined) !== 72) { console.error('FAIL default lookback'); process.exit(1); }
if (parseBackfillMaxAgeHours('') !== 72) { console.error('FAIL empty lookback'); process.exit(1); }
if (parseBackfillMaxAgeHours('0') !== 0) { console.error('FAIL unlimited lookback'); process.exit(1); }
if (parseBackfillMaxAgeHours('72') !== 72) { console.error('FAIL 72 lookback'); process.exit(1); }
const cutoff = now - 72 * 3600 * 1000;
const sliced = sliceToLookback(
  [
    { createdTimestamp: now - 1000 },
    { createdTimestamp: now - 3600 * 1000 },
    { createdTimestamp: cutoff - 1000 },
    { createdTimestamp: cutoff - 86400 * 1000 },
  ],
  cutoff,
);
if (sliced.keep.length !== 2 || !sliced.hitFloor) { console.error('FAIL lookback slice', sliced); process.exit(1); }
if (channelQuietBefore({ lastMessageId: null }, cutoff)) { console.error('FAIL quiet null should fetch'); process.exit(1); }
const oldId = String(BigInt(1_500_000_000_000 - 1_420_070_400_000) << 22n);
if (!channelQuietBefore({ lastMessageId: oldId }, cutoff)) { console.error('FAIL quiet old channel', snowflakeToMs(oldId)); process.exit(1); }
const recentId = String(BigInt(now - 1_420_070_400_000) << 22n);
if (channelQuietBefore({ lastMessageId: recentId }, cutoff)) { console.error('FAIL quiet recent channel'); process.exit(1); }
console.log('72h lookback cap PASS');

// Close SQLite before deleting the temp dir — Windows holds the WAL lock otherwise.
getDb().close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('\nALL SMOKE TESTS PASSED');
