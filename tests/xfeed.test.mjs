import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPost, hasCashtagOrCA, extractCA, isReply, isRetweet } from '../xfeed/filter.js';
import { buildTweetCard, fmtCount, clip, tweetUrl } from '../xfeed/card.js';
import { parseFeedRoutes } from '../xfeed/config.js';

const NOW = 1_800_000_000_000;
const base = {
  minLikes: 0, minRetweets: 0, minViews: 0, maxAgeMin: 30,
  includeReplies: true, includeRetweets: false,
  requireCashtagOrCA: false, keywords: [],
};
const tw = (over = {}) => ({
  id: '123', username: 'kol', name: 'KOL', text: 'gm trenches',
  likes: 0, retweets: 0, replies: 0, views: 0,
  timestamp: Math.floor(NOW / 1000), ...over,
});

test('default config posts an ordinary tweet', () => {
  assert.equal(shouldPost(tw(), base, NOW).ok, true);
});

test('tweets older than maxAgeMin are dropped', () => {
  const old = tw({ timestamp: Math.floor(NOW / 1000) - 60 * 60 });
  const v = shouldPost(old, base, NOW);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'too_old');
});

test('replies included by default, excludable by config', () => {
  const reply = tw({ isReply: true });
  assert.equal(shouldPost(reply, base, NOW).ok, true);
  assert.equal(shouldPost(reply, { ...base, includeReplies: false }, NOW).reason, 'reply');
});

test('retweets excluded by default, includable by config', () => {
  const rt = tw({ isRetweet: true });
  assert.equal(shouldPost(rt, base, NOW).reason, 'retweet');
  assert.equal(shouldPost(rt, { ...base, includeRetweets: true }, NOW).ok, true);
});

test('engagement floors apply only when set above zero', () => {
  assert.equal(shouldPost(tw({ likes: 2 }), base, NOW).ok, true, 'zero threshold = no filtering');
  assert.equal(shouldPost(tw({ likes: 2 }), { ...base, minLikes: 10 }, NOW).reason, 'likes');
  assert.equal(shouldPost(tw({ likes: 20 }), { ...base, minLikes: 10 }, NOW).ok, true);
});

test('CA requirement matches both EVM and Solana addresses and cashtags', () => {
  const cfg = { ...base, requireCashtagOrCA: true };
  assert.equal(shouldPost(tw(), cfg, NOW).reason, 'no_ca');
  assert.equal(shouldPost(tw({ text: 'ape $WIF now' }), cfg, NOW).ok, true);
  assert.equal(shouldPost(tw({ text: 'ca 0x45242320dbb855eea8fd36804c6487e10e97fcf9' }), cfg, NOW).ok, true);
  assert.equal(shouldPost(tw({ text: 'sol 5fjVdV3yXKLUVqnzqtwSbD67vaAskaLPhJXvbsgLiCPW' }), cfg, NOW).ok, true);
});

test('keyword filter requires at least one match, case-insensitively', () => {
  const cfg = { ...base, keywords: ['pumpfun', 'robinhood'] };
  assert.equal(shouldPost(tw({ text: 'new Robinhood chain launch' }), cfg, NOW).ok, true);
  assert.equal(shouldPost(tw({ text: 'gm' }), cfg, NOW).reason, 'keyword');
});

test('malformed tweets are rejected rather than throwing', () => {
  assert.equal(shouldPost(null, base, NOW).ok, false);
  assert.equal(shouldPost({ id: '1' }, base, NOW).reason, 'no_text');
  assert.equal(shouldPost({ text: 'hi' }, base, NOW).reason, 'no_id');
});

test('extractCA pulls the first contract address out of a tweet', () => {
  assert.equal(extractCA('buy 0x45242320dbb855eea8fd36804c6487e10e97fcf9 now'), '0x45242320dbb855eea8fd36804c6487e10e97fcf9');
  assert.equal(extractCA('no address here'), null);
});

test('reply/retweet detection handles both field shapes', () => {
  assert.equal(isReply({ inReplyToStatusId: '9' }), true);
  assert.equal(isRetweet({ retweetedStatus: {} }), true);
  assert.equal(isReply({}), false);
});

test('card shows handle, text, engagement and a working link', () => {
  const d = buildTweetCard(tw({ text: '$BONK sending', likes: 1200, views: 45000 })).data;
  assert.match(d.author.name, /@kol/);
  assert.match(d.description, /\$BONK sending/);
  assert.match(d.description, /1\.2K/);
  assert.match(d.description, /45\.0K/);
  assert.match(d.description, /x\.com\/kol\/status\/123/);
});

test('a contract address in the tweet is surfaced in backticks for copy/track', () => {
  const ca = '0x45242320dbb855eea8fd36804c6487e10e97fcf9';
  const d = buildTweetCard(tw({ text: 'ape this ' + ca })).data;
  assert.match(d.description, new RegExp('`' + ca + '`'));
});

test('long tweets are clipped so the embed cannot overflow', () => {
  const d = buildTweetCard(tw({ text: 'x'.repeat(2000) })).data;
  assert.ok(d.description.length < 1200);
  assert.ok(d.description.includes('…'));
  assert.equal(clip('short', 100), 'short');
});

test('count formatting compacts thousands and millions', () => {
  assert.equal(fmtCount(0), '0');
  assert.equal(fmtCount(999), '999');
  assert.equal(fmtCount(1500), '1.5K');
  assert.equal(fmtCount(2_400_000), '2.4M');
});

test('X logo is a public URL so Telegram renders it', () => {
  const d = buildTweetCard(tw()).data;
  assert.ok(d.thumbnail.url.startsWith('https://'));
  assert.equal(tweetUrl(tw()), 'https://x.com/kol/status/123');
});

test('parseFeedRoutes reads listId:channelId pairs and falls back to LIST_IDS + CHANNEL_ID', () => {
  assert.deepEqual(parseFeedRoutes({}), []);
  assert.deepEqual(
    parseFeedRoutes({ XFEED_ROUTES: '111:aaa,222:bbb' }),
    [{ listId: '111', channelId: 'aaa' }, { listId: '222', channelId: 'bbb' }],
  );
  assert.deepEqual(
    parseFeedRoutes({ XFEED_LIST_IDS: '111,222', XFEED_CHANNEL_ID: 'chan' }),
    [{ listId: '111', channelId: 'chan' }, { listId: '222', channelId: 'chan' }],
  );
  assert.deepEqual(
    parseFeedRoutes({
      XFEED_ROUTES: '999:personal',
      XFEED_LIST_IDS: '111',
      XFEED_CHANNEL_ID: 'chan',
    }),
    [{ listId: '999', channelId: 'personal' }],
    'XFEED_ROUTES wins over the legacy pair',
  );
});
