import { test } from 'node:test';
import assert from 'assert/strict';
import { diffFollowing, capNewcomers } from '../xradar/diff.js';
import { buildFollowCard, clip, profileUrl, pfpUrl } from '../xradar/card.js';
import { parseHandleList } from '../xradar/config.js';
import { targetFeedListId, describeListSync } from '../xradar/listSync.js';
import { parseGraphQLTweet, extractListTimelineTweets } from '../xradar/xClient.js';

const user = (id, username) => ({
  id, username, name: username, bio: 'trader', followersCount: 1000, followingCount: 50,
});

test('first snapshot is a baseline and never alerts', () => {
  const page = [user('1', 'a'), user('2', 'b')];
  const empty = diffFollowing(undefined, page);
  assert.equal(empty.baseline, true);
  assert.deepEqual(empty.newcomers, []);
  assert.equal(diffFollowing({}, page).baseline, true);
});

test('ids already in the snapshot are not newcomers', () => {
  const page = [user('1', 'a'), user('2', 'b')];
  const { baseline, newcomers } = diffFollowing({ 1: true, 2: true }, page);
  assert.equal(baseline, false);
  assert.deepEqual(newcomers, []);
});

test('new ids on the newest-first page are newcomers', () => {
  const page = [user('9', 'newbie'), user('1', 'old')];
  const { newcomers } = diffFollowing({ 1: true, 2: true }, page);
  assert.equal(newcomers.length, 1);
  assert.equal(newcomers[0].username, 'newbie');
});

test('users without an id are ignored rather than throwing', () => {
  const { newcomers } = diffFollowing({ 1: true }, [{ username: 'ghost' }, user('3', 'ok')]);
  assert.equal(newcomers.length, 1);
  assert.equal(newcomers[0].id, '3');
});

test('capNewcomers limits a follow burst', () => {
  const many = [1, 2, 3, 4, 5].map((n) => user(String(n), 'u' + n));
  assert.equal(capNewcomers(many, 2).length, 2);
  assert.equal(capNewcomers(many, 0).length, 5);
});

test('parseHandleList normalizes @, commas, and junk', () => {
  assert.deepEqual(parseHandleList('@Pelp333, https_not_a_handle, okay_user'), ['pelp333', 'okay_user']);
  assert.deepEqual(parseHandleList(''), []);
});

test('follow card names both accounts and links the new follow', () => {
  const d = buildFollowCard(
    { username: 'kol', avatarUrl: 'https://pbs.twimg.com/profile_images/1_normal.jpg' },
    {
      username: 'newbie', name: 'Newbie', bio: 'onchain',
      followersCount: 1200, followingCount: 10,
      avatarUrl: 'https://pbs.twimg.com/profile_images/2_normal.jpg',
    },
  ).data;
  assert.match(d.author.name, /@kol followed/);
  assert.match(d.description, /@newbie/);
  assert.match(d.description, /Newbie/);
  assert.equal(profileUrl('newbie'), 'https://x.com/newbie');
  assert.ok(clip('x'.repeat(200)).endsWith('…'));
  assert.match(d.thumbnail.url, /2_400x400/);
  assert.doesNotMatch(d.thumbnail.url, /apple-touch-icon/);
  assert.match(d.author.icon_url, /1_400x400/);
});

test('pfpUrl upgrades _normal avatars and falls back to unavatar', () => {
  assert.equal(
    pfpUrl({ avatarUrl: 'https://pbs.twimg.com/profile_images/ab_normal.jpg' }, 'x'),
    'https://pbs.twimg.com/profile_images/ab_400x400.jpg',
  );
  assert.equal(pfpUrl({}, 'InkersonInk'), 'https://unavatar.io/twitter/InkersonInk');
});

test('targetFeedListId prefers XFEED_SYNC_LIST_ID then the first XFEED_LIST_IDS entry', () => {
  assert.equal(targetFeedListId({}), '');
  assert.equal(targetFeedListId({ XFEED_LIST_IDS: '111,222' }), '111');
  assert.equal(targetFeedListId({ XFEED_LIST_IDS: '111', XFEED_SYNC_LIST_ID: '999' }), '999');
});

test('describeListSync explains skip, success, already, and failure', () => {
  assert.match(describeListSync({ skipped: 'no_list' }), /XFEED_LIST_IDS/);
  assert.match(describeListSync({ ok: true }), /Added to the X list/);
  assert.match(describeListSync({ ok: true, already: true }), /Already on the X list/);
  assert.match(describeListSync({ ok: false, error: 'nope' }), /nope/);
});

function gqlTweet(over = {}) {
  const { user, visibility, ...rest } = over;
  const inner = {
    rest_id: '111',
    legacy: {
      full_text: 'gm trenches $WIF',
      created_at: 'Sun Aug 23 00:00:00 +0000 2026',
      favorite_count: 12,
      retweet_count: 3,
      reply_count: 1,
      in_reply_to_status_id_str: null,
    },
    views: { count: '440' },
    core: {
      user_results: {
        result: {
          rest_id: '99',
          core: { screen_name: 'kol', name: 'KOL' },
          legacy: {},
        },
      },
    },
    ...rest,
  };
  if (user) inner.core.user_results.result = user;
  if (visibility) return { __typename: 'TweetWithVisibilityResults', tweet: inner };
  return inner;
}

test('parseGraphQLTweet maps GraphQL shape onto xfeed card fields', () => {
  const t = parseGraphQLTweet(gqlTweet());
  assert.equal(t.id, '111');
  assert.equal(t.username, 'kol');
  assert.equal(t.name, 'KOL');
  assert.match(t.text, /\$WIF/);
  assert.equal(t.likes, 12);
  assert.equal(t.views, 440);
  assert.equal(t.isReply, false);
  assert.equal(t.isRetweet, false);
  // unix seconds, not ms — xfeed does timestamp * 1000
  assert.ok(t.timestamp > 1_700_000_000 && t.timestamp < 2_000_000_000);
});

test('parseGraphQLTweet unwraps visibility wrappers and long-form note text', () => {
  const t = parseGraphQLTweet(gqlTweet({
    visibility: true,
    note_tweet: { note_tweet_results: { result: { text: 'long form body' } } },
    legacy: {
      full_text: 'truncated…',
      created_at: 'Sun Aug 23 00:00:00 +0000 2026',
      in_reply_to_status_id_str: '222',
    },
  }));
  assert.equal(t.text, 'long form body');
  assert.equal(t.isReply, true);
  assert.equal(t.inReplyToStatusId, '222');
});

test('parseGraphQLTweet marks retweets and skips tombstones', () => {
  assert.equal(parseGraphQLTweet({ __typename: 'TweetTombstone' }), null);
  const t = parseGraphQLTweet(gqlTweet({
    legacy: {
      full_text: 'RT @x: hi',
      created_at: 'Sun Aug 23 00:00:00 +0000 2026',
      retweeted_status_result: { result: gqlTweet({ rest_id: '333' }) },
    },
  }));
  assert.equal(t.isRetweet, true);
  assert.equal(t.retweetedStatus.id, '333');
});

test('extractListTimelineTweets walks list URT instructions and dedupes pins', () => {
  const tweet = gqlTweet();
  const tweets = extractListTimelineTweets({
    data: {
      list: {
        tweets_timeline: {
          timeline: {
            instructions: [
              { type: 'TimelinePinEntry', entry: { content: { itemContent: { tweet_results: { result: tweet } } } } },
              {
                type: 'TimelineAddEntries',
                entries: [
                  { entryId: 'cursor-top-1', content: { value: 'AAA' } },
                  { entryId: 'tweet-111', content: { itemContent: { tweet_results: { result: tweet } } } },
                  { entryId: 'tweet-444', content: { itemContent: { tweet_results: { result: gqlTweet({ rest_id: '444' }) } } } },
                  {
                    entryId: 'list-conversation-1',
                    content: {
                      items: [
                        { item: { itemContent: { tweet_results: { result: gqlTweet({ rest_id: '555' }) } } } },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  });
  assert.deepEqual(tweets.map((t) => t.id), ['111', '444', '555']);
});
