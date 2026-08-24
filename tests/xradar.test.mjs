import { test } from 'node:test';
import assert from 'assert/strict';
import { diffFollowing, capNewcomers } from '../xradar/diff.js';
import { buildFollowCard, clip, profileUrl } from '../xradar/card.js';
import { parseHandleList } from '../xradar/config.js';
import { targetFeedListId, describeListSync } from '../xradar/listSync.js';

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
    { username: 'kol' },
    { username: 'newbie', name: 'Newbie', bio: 'onchain', followersCount: 1200, followingCount: 10 },
  ).data;
  assert.match(d.author.name, /@kol followed/);
  assert.match(d.description, /@newbie/);
  assert.match(d.description, /Newbie/);
  assert.equal(profileUrl('newbie'), 'https://x.com/newbie');
  assert.ok(clip('x'.repeat(200)).endsWith('…'));
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
