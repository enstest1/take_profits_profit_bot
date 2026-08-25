/**
 * nfttp — parse, ticker, milestone ladder, card copy.
 * No OpenSea / Discord — keep this suite offline-safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNftRefs, parseNftQuery, tickerFromSlug, isOpenSeaSlug } from '../nfttp/parse.js';
import { DEFAULT_NFT_TP_CHANNEL_ID, nftTpAlertChannel } from '../nfttp/config.js';
import { evaluateNftMilestones, nftMultiple, GAIN75_MIN, RESET_COOLDOWN_MS } from '../nfttp/evaluate.js';
import { windowsFromStats, floorChangeWindows, resolveNftWindows } from '../nfttp/opensea.js';
import { fmtEth, nftMarketLinks, buildNftMilestoneAlert } from '../nfttp/cards.js';

test('default alert channel is TP4APH nft-land', () => {
  assert.equal(DEFAULT_NFT_TP_CHANNEL_ID, '1358929055604408465');
  assert.equal(nftTpAlertChannel('999'), DEFAULT_NFT_TP_CHANNEL_ID);
});

test('extracts OpenSea collection URLs (www, pro, trailing path)', () => {
  const refs = extractNftRefs(
    'ape this https://opensea.io/collection/pudgy-penguins/overview and www.opensea.io/collection/doodles-official',
  );
  assert.deepEqual(
    refs.map((r) => r.slug),
    ['pudgy-penguins', 'doodles-official'],
  );
});

test('extracts item/asset URLs as chain+contract', () => {
  const refs = extractNftRefs(
    'https://opensea.io/item/ethereum/0xbd3531da5cf5857e7cfaa92426877b022e612cf8/12',
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, 'contract');
  assert.equal(refs[0].chain, 'ethereum');
  assert.equal(refs[0].address.toLowerCase(), '0xbd3531da5cf5857e7cfaa92426877b022e612cf8');
});

test('bare 0x is ignored unless trackContracts is on', () => {
  const addr = '0xbd3531da5cf5857e7cfaa92426877b022e612cf8';
  assert.equal(extractNftRefs(addr).length, 0);
  assert.equal(extractNftRefs(addr, { trackContracts: true }).length, 1);
});

test('parseNftQuery accepts slug, url, and 0x', () => {
  assert.equal(parseNftQuery('pudgy-penguins').slug, 'pudgy-penguins');
  assert.equal(parseNftQuery('https://opensea.io/collection/azuki').slug, 'azuki');
  assert.equal(parseNftQuery('0xbd3531da5cf5857e7cfaa92426877b022e612cf8').kind, 'contract');
  assert.equal(parseNftQuery('not a collection!!!'), null);
  assert.equal(isOpenSeaSlug('pudgy-penguins'), true);
  assert.equal(isOpenSeaSlug('Pudgy Penguins'), false);
});

test('tickerFromSlug prefers first hyphen token', () => {
  assert.equal(tickerFromSlug('pudgy-penguins', 'Pudgy Penguins'), 'PUDGY');
  assert.equal(tickerFromSlug('azuki', 'Azuki'), 'AZUKI');
  assert.equal(tickerFromSlug('boredapeyachtclub', 'Bored Ape Yacht Club'), 'BAYC');
});

test('+75% only fires between 1.75× and 2× vs OG floor', () => {
  const entry = { floorAtCall: 1, milestonesFired: [], gainAlertFired: false };
  const miss = evaluateNftMilestones(entry, { floor: 1.5 });
  assert.equal(miss.alerts.length, 0);

  const hit = evaluateNftMilestones(entry, { floor: 1.8 });
  assert.deepEqual(hit.alerts.map((a) => a.kind), ['gain75']);

  const past = evaluateNftMilestones(entry, { floor: 2.1 });
  assert.ok(!past.alerts.some((a) => a.kind === 'gain75'));
  assert.ok(past.alerts.some((a) => a.kind === 'tier1' && a.label === '1x'));
});

test('tier N card is Nx and fires at (N+1)× floor (1x card at 2×, 20x at 21×)', () => {
  const entry = { floorAtCall: 0.1, milestonesFired: [], gainAlertFired: false };
  const at2x = evaluateNftMilestones(entry, { floor: 0.2 });
  assert.deepEqual(at2x.alerts.map((a) => a.label), ['1x']);

  const at21x = evaluateNftMilestones(
    { ...entry, milestonesFired: [] },
    { floor: 2.1 },
    { maxTier: 20 },
  );
  // Fresh jump 1→21×: highest new tier only (20x), intermediates marked silent.
  const labels = at21x.alerts.map((a) => a.label);
  assert.deepEqual(labels, ['20x']);
  assert.ok(at21x.patch.milestonesFired.includes(1));
  assert.ok(at21x.patch.milestonesFired.includes(20));
});

test('OG floor backfill does not alert on the first live tick', () => {
  const { alerts, patch } = evaluateNftMilestones({ floorAtCall: null }, { floor: 0.5 });
  assert.equal(alerts.length, 0);
  assert.equal(patch.floorAtCall, 0.5);
  assert.equal(patch.floorAtCallBackfilled, true);
});

test('trench reset clears milestones after 3 polls below 0.99×', () => {
  const now = Date.now();
  const entry = {
    floorAtCall: 1,
    milestonesFired: [1, 2],
    gainAlertFired: true,
    takeProfitFired: true,
    lowMultStreak: 2,
    lastMilestoneResetAt: now - RESET_COOLDOWN_MS - 1,
  };
  const { patch } = evaluateNftMilestones(entry, { floor: 0.9 }, { now });
  assert.deepEqual(patch.milestonesFired, []);
  assert.equal(patch.gainAlertFired, false);
});

test('nftMultiple uses max of floor× and mcap×', () => {
  const entry = { floorAtCall: 1, mcapAtCall: 100 };
  assert.equal(nftMultiple(entry, { floor: 2, mcap: 150 }), 2);
  assert.equal(nftMultiple(entry, { floor: 1.1, mcap: 300 }), 3);
  assert.equal(GAIN75_MIN, 1.75);
});

test('volume windows fall back to OpenSea one_day / seven_day stats', () => {
  const w = windowsFromStats({
    intervals: [
      { interval: 'one_day', volume: 80, sales: 12 },
      { interval: 'seven_day', volume: 400, sales: 90 },
    ],
  });
  assert.equal(w[0].label, '24h');
  assert.equal(w[0].vol, 80);
  assert.equal(w[1].label, '7d');
});

test('floorChangeWindows compute 1h/30m/15m % from candles', () => {
  const now = 1_000_000;
  const candles = [
    { t: now - 2 * 3600_000, c: 1 },
    { t: now - 40 * 60_000, c: 1.1 },
    { t: now - 10 * 60_000, c: 1.2 },
    { t: now, c: 1.5 },
  ];
  const w = floorChangeWindows(candles, now);
  assert.equal(w[0].label, '1h');
  assert.ok(Math.abs(w[0].pct - 50) < 0.01); // 1.0 → 1.5 vs 1h-ago-or-oldest-before-cutoff
});

test('resolveNftWindows prefers floor % over daily volume', () => {
  const now = Date.now();
  const candles = [
    { t: now - 3600_000, c: 1 },
    { t: now, c: 1.2 },
  ];
  const w = resolveNftWindows({
    candles,
    stats: { intervals: [{ interval: 'one_day', volume: 99, sales: 1 }] },
  });
  assert.equal(w[0].label, '1h');
  assert.ok(w[0].pct > 0);
});

test('fmtEth omits unit when symbol is empty', () => {
  assert.equal(fmtEth(0.42, 'ETH'), '0.42 ETH');
  assert.equal(fmtEth(0.42, ''), '0.42');
  assert.equal(fmtEth(null), '—');
});

test('milestone card keeps trencher skeleton: 💎 floor → floor, Take Profit banner, market links', () => {
  const { embed } = buildNftMilestoneAlert({
    entry: {
      name: 'Pudgy Penguins',
      ticker: 'PUDGY',
      chain: 'ethereum',
      slug: 'pudgy-penguins',
      address: '0xbd3531da5cf5857e7cfaa92426877b022e612cf8',
      postedBy: 'trench_king',
      postedAt: Date.now() - 4 * 3600_000,
      floorAtCall: 0.42,
      floorSymbol: 'ETH',
    },
    live: { floor: 0.84, floorSymbol: 'ETH', numOwners: 1200 },
    alertKind: 'tier1',
    tier: 1,
    windows: [{ label: '1h', vol: 12, pct: 8.2 }],
  });
  const desc = embed.data.description;
  assert.match(embed.data.author.name, /Ethereum · PUDGY · 1x/);
  assert.match(desc, /💎/);
  assert.match(desc, /0\.42/);
  assert.match(desc, /0\.84 ETH/);
  assert.match(desc, /Take Profit/);
  assert.match(desc, /OpenSea/);
  assert.match(nftMarketLinks({ slug: 'pudgy-penguins', chain: 'ethereum', address: '0xabc' }), /Blur/);
});
