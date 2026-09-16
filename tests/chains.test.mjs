import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAINS,
  extractAddresses,
  makeStorageKey,
  chainAuthorName,
  chainIdFromDexScreenerSlug,
} from '../chains.js';

test('ink and hype are registered EVM chains', () => {
  assert.equal(CHAINS.ink.kind, 'evm');
  assert.equal(CHAINS.ink.dexScreenerSlug, 'ink');
  assert.equal(CHAINS.hype.kind, 'evm');
  assert.equal(CHAINS.hype.dexScreenerSlug, 'hyperevm');
});

test('arc and bsc (BNB) are registered EVM chains', () => {
  assert.equal(CHAINS.arc.kind, 'evm');
  assert.equal(CHAINS.arc.dexScreenerSlug, 'arc');
  assert.equal(CHAINS.bsc.kind, 'evm');
  assert.equal(CHAINS.bsc.dexScreenerSlug, 'bsc');
  assert.equal(CHAINS.bsc.label, 'BNB');
  assert.equal(chainAuthorName('arc'), 'Arc');
  assert.equal(chainAuthorName('bsc'), 'BNB');
  assert.equal(chainIdFromDexScreenerSlug('bnb'), 'bsc');
  assert.equal(chainIdFromDexScreenerSlug('hyperevm'), 'hype');
});

test('makeStorageKey prefixes ink and hype EVM addresses', () => {
  const addr = '0xAbCdEf0123456789012345678901234567890AbCd';
  assert.equal(makeStorageKey('ink', addr), 'ink:0xabcdef0123456789012345678901234567890abcd');
  assert.equal(makeStorageKey('hype', addr), 'hype:0xabcdef0123456789012345678901234567890abcd');
  assert.equal(makeStorageKey('arc', addr), 'arc:0xabcdef0123456789012345678901234567890abcd');
  assert.equal(makeStorageKey('bsc', addr), 'bsc:0xabcdef0123456789012345678901234567890abcd');
});

test('extractAddresses picks up hyperevm DexScreener links when hype is enabled', () => {
  const prev = process.env.ENABLED_CHAINS;
  process.env.ENABLED_CHAINS = 'hype';
  const body = 'check https://dexscreener.com/hyperevm/0x5555555555555555555555555555555555555555';
  const found = extractAddresses(body);
  if (prev != null) process.env.ENABLED_CHAINS = prev;
  else delete process.env.ENABLED_CHAINS;
  assert.equal(found.length, 1);
  assert.equal(found[0].chainId, 'hype');
  assert.equal(found[0].raw, '0x5555555555555555555555555555555555555555');
});

test('ethereum is a registered EVM chain', () => {
  assert.equal(CHAINS.ethereum.kind, 'evm');
  assert.equal(CHAINS.ethereum.dexScreenerSlug, 'ethereum');
});

test('makeStorageKey prefixes ethereum EVM addresses', () => {
  const addr = '0xAbCdEf0123456789012345678901234567890AbCd';
  assert.equal(makeStorageKey('ethereum', addr), 'ethereum:0xabcdef0123456789012345678901234567890abcd');
});

test('extractAddresses picks up ethereum DexScreener links when ethereum is enabled', () => {
  const prev = process.env.ENABLED_CHAINS;
  process.env.ENABLED_CHAINS = 'ethereum';
  const body = 'https://dexscreener.com/ethereum/0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const found = extractAddresses(body);
  if (prev != null) process.env.ENABLED_CHAINS = prev;
  else delete process.env.ENABLED_CHAINS;
  assert.equal(found.length, 1);
  assert.equal(found[0].chainId, 'ethereum');
});

test('extractAddresses picks up ink DexScreener links when ink is enabled', () => {
  const prev = process.env.ENABLED_CHAINS;
  process.env.ENABLED_CHAINS = 'ink';
  const body = 'https://dexscreener.com/ink/0x4200000000000000000000000000000000000006';
  const found = extractAddresses(body);
  if (prev != null) process.env.ENABLED_CHAINS = prev;
  else delete process.env.ENABLED_CHAINS;
  assert.equal(found.length, 1);
  assert.equal(found[0].chainId, 'ink');
});

test('extractAddresses picks up Arc and BSC DexScreener links when enabled', () => {
  const prev = process.env.ENABLED_CHAINS;
  process.env.ENABLED_CHAINS = 'arc,bsc';
  const arc = extractAddresses('https://dexscreener.com/arc/0x1111111111111111111111111111111111111111');
  const bsc = extractAddresses('https://dexscreener.com/bsc/0x2222222222222222222222222222222222222222');
  const bnbAlias = extractAddresses('https://dexscreener.com/bnb/0x3333333333333333333333333333333333333333');
  if (prev != null) process.env.ENABLED_CHAINS = prev;
  else delete process.env.ENABLED_CHAINS;
  assert.equal(arc[0]?.chainId, 'arc');
  assert.equal(bsc[0]?.chainId, 'bsc');
  assert.equal(bnbAlias[0]?.chainId, 'bsc');
});
