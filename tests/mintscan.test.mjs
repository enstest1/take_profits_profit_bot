import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMintEvents, tierFor, windowMintCount, pruneWindow, safeQty, parse1155BatchTotal,
  TOPIC_ERC721_TRANSFER, TOPIC_ERC1155_SINGLE, ZERO_TOPIC,
} from '../mintscan/mintParse.js';
import { buildMintCard, marketLines, formatEth } from '../mintscan/card.js';
import { CHAIN_PRESETS } from '../mintscan/config.js';

const addrTopic = (a) => '0x' + '0'.repeat(24) + a.replace(/^0x/, '');
const MINTER = '0x1111111111111111111111111111111111111111';

const log721 = (over = {}) => ({
  address: '0xCONTRACT'.padEnd(42, '0'),
  topics: [TOPIC_ERC721_TRANSFER, ZERO_TOPIC, addrTopic(MINTER), addrTopic('0x01')],
  data: '0x',
  blockNumber: '0x64',
  transactionHash: '0xtx',
  ...over,
});

test('ERC-721 mint (from = zero) is detected', () => {
  const out = parseMintEvents([log721()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].minter, MINTER);
  assert.equal(out[0].qty, 1);
  assert.equal(out[0].block, 100);
});

test('ERC-721 transfer that is NOT a mint is ignored', () => {
  const out = parseMintEvents([log721({ topics: [TOPIC_ERC721_TRANSFER, addrTopic(MINTER), addrTopic('0x02'), addrTopic('0x01')] })]);
  assert.equal(out.length, 0);
});

test('ERC-20 Transfer (3 topics, same topic0) is not counted as an NFT mint', () => {
  const out = parseMintEvents([log721({ topics: [TOPIC_ERC721_TRANSFER, ZERO_TOPIC, addrTopic(MINTER)] })]);
  assert.equal(out.length, 0, 'ERC-20 must be excluded by topic count');
});

test('ERC-1155 single mint reads its quantity from data', () => {
  const qty = 5n;
  const data = '0x' + '0'.repeat(64) + qty.toString(16).padStart(64, '0');
  const out = parseMintEvents([{
    address: '0xc'.padEnd(42, '0'),
    topics: [TOPIC_ERC1155_SINGLE, addrTopic('0x9'), ZERO_TOPIC, addrTopic(MINTER)],
    data, blockNumber: '0xa', transactionHash: '0xtx',
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].qty, 5);
});

test('quantities are capped so a bad parse cannot blow up memory', () => {
  assert.equal(safeQty(1e9), 500);
  assert.equal(safeQty(-3), 1);
  assert.equal(safeQty(NaN), 1);
});

test('malformed 1155 batch data degrades to 1 instead of throwing', () => {
  assert.equal(parse1155BatchTotal('0xdeadbeef'), 1);
  assert.equal(parse1155BatchTotal(''), 1);
});

test('tiering respects both mint count and unique-minter floor', () => {
  const cfg = { warmMints: 25, hotMints: 60, moonMints: 120, minUnique: 15 };
  assert.equal(tierFor(130, 20, cfg), 'MOONING');
  assert.equal(tierFor(70, 20, cfg), 'HOT');
  assert.equal(tierFor(30, 20, cfg), 'WARM');
  assert.equal(tierFor(10, 20, cfg), null);
  assert.equal(tierFor(500, 3, cfg), null, 'a few wallets spamming must not tier up');
});

test('window pruning drops old chunks and stale minters', () => {
  const w = { chunks: [{ block: 1, qty: 5 }, { block: 10, qty: 3 }], minters: { a: 1, b: 10 }, sampleTx: '0x' };
  assert.equal(windowMintCount(w), 8);
  pruneWindow(w, 5);
  assert.equal(windowMintCount(w), 3);
  assert.deepEqual(Object.keys(w.minters), ['b']);
});

const alert = (over = {}) => ({
  tier: 'HOT', contract: '0xabc0000000000000000000000000000000000001',
  collectionName: 'Glitch Demon', openSeaSlug: 'glitch-demon', twitterUsername: 'glitchdemon',
  imageUrl: 'https://img.example/x.png', totalSupply: 197, maxSupply: 1000, mintPct: 19.7,
  mintPriceEth: 0.001, floorPriceEth: 0.0033, numOwners: 388,
  mints: 99, perMin: 19.8, unique: 20, sampleTx: '0xdeadbeef', windowBlocks: 1200, ...over,
});

test('card shows tier, velocity, unique minters and the CA', () => {
  const d = buildMintCard(alert(), CHAIN_PRESETS.robinhood).data;
  assert.match(d.title, /Glitch Demon/);
  assert.match(d.description, /HOT/);
  assert.match(d.description, /99\*\* mints/);
  assert.match(d.description, /19\.8\/min/);
  assert.match(d.description, /20\*\* unique/);
  assert.match(d.description, /0xabc0000000000000000000000000000000000001/);
});

test('links point at the configured chain explorer, not Etherscan', () => {
  const d = buildMintCard(alert(), CHAIN_PRESETS.robinhood).data;
  assert.match(d.description, /robinhoodchain\.blockscout\.com\/address\//);
  assert.match(d.description, /robinhoodchain\.blockscout\.com\/tx\//);
  assert.doesNotMatch(d.description, /etherscan/);
});

test('OpenSea and X links appear only when known', () => {
  const withAll = buildMintCard(alert(), CHAIN_PRESETS.robinhood).data.description;
  assert.match(withAll, /opensea\.io\/collection\/glitch-demon/);
  assert.match(withAll, /x\.com\/glitchdemon/);
  const bare = buildMintCard(alert({ openSeaSlug: null, twitterUsername: null }), CHAIN_PRESETS.robinhood).data.description;
  assert.doesNotMatch(bare, /opensea\.io/);
  assert.doesNotMatch(bare, /x\.com/);
  assert.match(bare, /Contract/, 'explorer link always present');
});

test('unknown market data is omitted rather than shown as null', () => {
  const lines = marketLines({ totalSupply: null, maxSupply: null, mintPct: null, mintPriceEth: null, floorPriceEth: null, numOwners: null });
  assert.equal(lines.length, 0);
});

test('eth formatting scales with magnitude', () => {
  assert.equal(formatEth(0.00001), '0.000010 ETH');
  assert.equal(formatEth(0.05), '0.0500 ETH');
  assert.equal(formatEth(2.5), '2.50 ETH');
  assert.equal(formatEth(null), null);
});

test('tier colour and emoji differ across tiers', () => {
  const warm = buildMintCard(alert({ tier: 'WARM' }), CHAIN_PRESETS.robinhood).data;
  const moon = buildMintCard(alert({ tier: 'MOONING' }), CHAIN_PRESETS.robinhood).data;
  assert.notEqual(warm.color, moon.color);
  assert.match(moon.title, /🚀/);
});
