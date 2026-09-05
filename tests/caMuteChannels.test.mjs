/**
 * Token-CA mute — #nft-land keeps the NFT volume bot, not memecoin track/cards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CA_MUTE_CHANNEL_IDS,
  caMuteChannelIds,
  isCaMutedChannel,
} from '../caMuteChannels.js';

const NFT_LAND = '1358929055604408465';
const TRENCHES = '1452152164699869298';

function withEnv(value, fn) {
  const prev = process.env.CA_MUTE_CHANNEL_IDS;
  if (value === undefined) delete process.env.CA_MUTE_CHANNEL_IDS;
  else process.env.CA_MUTE_CHANNEL_IDS = value;
  try {
    fn();
  } finally {
    if (prev != null) process.env.CA_MUTE_CHANNEL_IDS = prev;
    else delete process.env.CA_MUTE_CHANNEL_IDS;
  }
}

test('default mute is TP4APH #nft-land only', () => {
  withEnv(undefined, () => {
    assert.deepEqual(DEFAULT_CA_MUTE_CHANNEL_IDS, [NFT_LAND]);
    assert.deepEqual(caMuteChannelIds(), [NFT_LAND]);
    assert.ok(isCaMutedChannel(NFT_LAND));
    assert.ok(!isCaMutedChannel(TRENCHES));
    assert.ok(!isCaMutedChannel(null));
  });
});

test('CA_MUTE_CHANNEL_IDS=none disables the default', () => {
  withEnv('none', () => {
    assert.deepEqual(caMuteChannelIds(), []);
    assert.ok(!isCaMutedChannel(NFT_LAND));
  });
});

test('CA_MUTE_CHANNEL_IDS overrides the default list', () => {
  withEnv('111,222', () => {
    assert.deepEqual(caMuteChannelIds(), ['111', '222']);
    assert.ok(isCaMutedChannel('111'));
    assert.ok(!isCaMutedChannel(NFT_LAND));
  });
});
