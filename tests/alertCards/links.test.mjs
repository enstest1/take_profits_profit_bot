import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gmgnUrl, buildTradeLinksMarkdown } from '../../alertCards/links.js';
import { blockedChannelIds, isBlockedChannel } from '../../blockedChannels.js';

test('gmgnUrl uses sol slug for solana mints', () => {
  const url = gmgnUrl('solana', 'So11111111111111111111111111111111111111112');
  assert.equal(url, 'https://gmgn.ai/sol/token/So11111111111111111111111111111111111111112');
});

test('gmgnUrl lowercases EVM addresses on robinhood', () => {
  const url = gmgnUrl('robinhood', '0x91554e79a17c18990034d1ec3c4f492086d7b2cc');
  assert.equal(url, 'https://gmgn.ai/robinhood/token/0x91554e79a17c18990034d1ec3c4f492086d7b2cc');
});

test('buildTradeLinksMarkdown includes GMGN', () => {
  const md = buildTradeLinksMarkdown('robinhood', '0x91554e79a17c18990034d1ec3c4f492086d7b2cc');
  assert.match(md, /\[GMGN\]\(https:\/\/gmgn\.ai\/robinhood\/token\//);
});

test('isBlockedChannel defaults include general log channel', () => {
  const prev = process.env.BLOCKED_CHANNEL_IDS;
  delete process.env.BLOCKED_CHANNEL_IDS;
  assert.ok(isBlockedChannel('1536177376508121088'));
  assert.ok(!isBlockedChannel('1452152164699869298'));
  if (prev != null) process.env.BLOCKED_CHANNEL_IDS = prev;
  else delete process.env.BLOCKED_CHANNEL_IDS;
});

test('BLOCKED_CHANNEL_IDS=none disables default blocklist', () => {
  const prev = process.env.BLOCKED_CHANNEL_IDS;
  process.env.BLOCKED_CHANNEL_IDS = 'none';
  assert.deepEqual(blockedChannelIds(), []);
  if (prev != null) process.env.BLOCKED_CHANNEL_IDS = prev;
  else delete process.env.BLOCKED_CHANNEL_IDS;
});
