import 'dotenv/config';
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Railway/cloud hosts often hang on Discord gateway over IPv6.
dns.setDefaultResultOrder('ipv4first');
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';
import { pollTokens } from './poller.js';
import { initAlertGate, shouldSilenceAlerts } from './alertGate.js';
import { fibtrackCommand, handleFibtrack } from './fibCommands.js';
import { startFibWatchLoop } from './fib/watchLoop.js';
import { inspectTrackedJson, printInspectReport } from './scripts/inspect-tracked.mjs';
import { runVolumeBackup } from './scripts/backup-volume.mjs';
import { runMintCaseRepair } from './scripts/repair-mint-case.mjs';
import { fetchDexPair, resolveRobinhoodToken, tokenDataFromRobinhoodPair } from './dexPair.js';
import { fetchPumpFun, fetchSolPrice, calcPumpFunPrice } from './pumpfunApi.js';
import {
  DATA_DIR,
  DB_PATH,
  loadDB,
  saveDB,
  ensureDBSchema,
  markRemovedThisCycle,
} from './dbStore.js';
import {
  chainLabel,
  chainBadge,
  enabledChainsFooter,
  isSolanaAddress,
  isEvmAddress,
  parseEnabledChains,
  storageKeyForMint,
  makeStorageKey,
  extractAddresses,
  resolveUserInputToKey,
  resolveArchivedKey,
  parseStorageKey,
} from './chains.js';
import { computeInlineCallerStats, formatDurationMins } from './callerStats.js';
import { lifecyclePrefix } from './signals/lifecycle.js';
import { onAlreadyTracking, sendTrackingEmbed } from './autotrackHelpers.js';
import { fetchRugCheckRaw } from './risk/rugscan.js';
import {
  followCaller,
  unfollowCaller,
  watchToken,
  unwatchToken,
  resolveMintForCommand,
} from './subscriptions.js';
import {
  setPosition,
  resolveTrackedMint,
  buildMyBagsLines,
} from './positions.js';
import { parseTagsInput, validateTags, applyTags } from './metaTags.js';
import { startHttpServer } from './httpServer.js';
import { auditDatabase, formatAuditTable } from './warden/auditRunner.js';
import { cycleStats } from './cycleStats.js';
import { handleX } from './xCommand.js';
import { xHandleFromPair } from './xSocial.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = path.join(ROOT_DIR, 'watchlist.json');
const RUG_CACHE_TTL_MS = 60 * 1000;
const rugCache = {};

/** Target time between poll cycle starts; each cycle runs to completion first (avoids setInterval + async skips). */
const TOKEN_POLL_INTERVAL_MS = 3 * 60 * 1000;
const TOKEN_POLL_MIN_GAP_MS = 5000;

const STARTUP_BANNER =
  '░░▒▒▓▓████████ TAKE PROFIT ████████▓▓▒▒░░\n' +
  '░░▒▒▓▓██████ the profit bot ███████▓▓▒▒░░';

async function postStartupBanner(client) {
  console.log(STARTUP_BANNER);

  const channelId =
    process.env.LOG_CHANNEL_ID || process.env.SUMMARY_CHANNEL_ID || '1452152164699869298';

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle('💰 Take Profit Bot — ONLINE')
    .setDescription('```\n' + STARTUP_BANNER + '\n```\nBot is back online and polling.')
    .setTimestamp();

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.log('[startup] channel ' + channelId + ' is not text-based');
      return;
    }
    await channel.send({ embeds: [embed] });
    console.log('[startup] banner posted to channel ' + channelId);
  } catch (e) {
    console.error('[startup] failed to post banner to ' + channelId + ':', e.message);
  }
}

async function runTokenPollLoop(client) {
  while (true) {
    const t0 = Date.now();
    try {
      await pollTokens(client);
    } catch (e) {
      console.error('[poll] loop error:', e);
    }
    const elapsed = Date.now() - t0;
    const wait = Math.max(TOKEN_POLL_MIN_GAP_MS, TOKEN_POLL_INTERVAL_MS - elapsed);
    console.log('[poll] cycle ' + Math.round(elapsed / 1000) + 's — next in ' + Math.round(wait / 1000) + 's');
    await new Promise((r) => setTimeout(r, wait));
  }
}

console.log('[boot] Using data dir: ' + DATA_DIR);
console.log('[boot] Enabled chains: ' + parseEnabledChains().map(chainLabel).join(' · '));

function fmtUsd(n) {
  if (!n || isNaN(Number(n))) return '—';
  const num = Number(n);
  if (num >= 1000000000) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1000000) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1000) return '$' + (num / 1e3).toFixed(1) + 'K';
  return '$' + num.toFixed(4);
}

function fmtTime(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ago';
  if (h > 0) return h + 'h ago';
  if (m > 0) return m + 'm ago';
  return 'just now';
}

function getTokenAgeFlag(createdAtMs) {
  if (!createdAtMs) return null;
  const ageHours = (Date.now() - createdAtMs) / 3600000;
  if (ageHours < 1) return '🔥 < 1h old';
  if (ageHours < 24) return '⚡ ' + Math.floor(ageHours) + 'h old';
  return Math.floor(ageHours / 24) + 'd old';
}

function buildTrackedEntry(token, storageKey, message, ageStr) {
  const { chainId } = parseStorageKey(storageKey);
  const isRh = chainId === 'robinhood';
  const totalTxns = (token.buys24h || 0) + (token.sells24h || 0);
  let buyPressurePct = null;
  if (totalTxns > 0) buyPressurePct = Math.round((token.buys24h / totalTxns) * 100);

  return {
    address: isRh ? token.address : storageKey,
    name: token.name,
    symbol: token.symbol,
    chain: token.chain || chainId,
    platform: token.platform,
    postedBy: message.author.username,
    postedByUserId: message.author.id,
    postedAt: Date.now(),
    calledInGuild: message.guildId,
    alertChannelId: message.channelId,
    priceAtCall: token.price || null,
    mcapAtCall: token.marketCap || null,
    volumeAtCall: token.volume24h || 0,
    lastPrice: token.price || null,
    lastVolume: token.volume24h || 0,
    lastChecked: Date.now(),
    peakMultiple: 1.0,
    peakAt: Date.now(),
    milestonesFired: [],
    lowMultStreak: 0,
    takeProfitFired: false,
    gainAlertFired: false,
    bondingProgress: isRh ? null : (token.bondingProgress || 0),
    graduationAlertFired: isRh ? null : false,
    bondingAlertFired: isRh ? null : false,
    tokenAge: ageStr || 'unknown',
    dexUrl: token.dexUrl,
    imageUrl: token.imageUrl || null,
    devWallet: isRh ? null : (token.creator || null),
    devHoldingAtCall: 0,
    devLastKnownHolding: 0,
    devDumpAlertFired: false,
    buyPressure: buyPressurePct || 0,
    sellPressure: buyPressurePct !== null ? 100 - buyPressurePct : 0,
    xHandle: token.xHandle || null,
  };
}

async function autoTrack(ref, message, seenThisMessage = new Set()) {
  const { chainId, raw } = ref;
  if (chainId === 'robinhood') return autoTrackRobinhood(raw, message, seenThisMessage);
  return autoTrackSolana(raw, message, seenThisMessage);
}

async function autoTrackRobinhood(raw, message, seenThisMessage) {
  const db = ensureDBSchema(loadDB());
  const resolved = await resolveRobinhoodToken(raw);
  if (!resolved) {
    console.log('[autotrack] 0x ' + raw.slice(0, 10) + '… has no robinhood pair — ignored');
    return;
  }

  const storageKey = makeStorageKey('robinhood', resolved.tokenAddress);
  if (seenThisMessage.has(storageKey)) {
    console.log('[autotrack] duplicate robinhood mint in same message: ' + storageKey.slice(0, 20) + '…');
    return;
  }
  if (db.tokens[storageKey]) {
    console.log('[autotrack] already tracking ' + (db.tokens[storageKey].symbol || storageKey) + ' (OG preserved)');
    await onAlreadyTracking(message.client, db, storageKey, message);
    return;
  }

  const archivedKey = resolveArchivedKey(db, storageKey, raw);
  if (archivedKey) {
    const og = db.archived[archivedKey];
    db.tokens[storageKey] = { ...og, address: resolved.tokenAddress };
    delete db.archived[archivedKey];
    saveDB(db);
    console.log('[repair] un-archived ' + (og.symbol || storageKey) + ' on repost — OG call preserved');
    return;
  }

  seenThisMessage.add(storageKey);
  const token = tokenDataFromRobinhoodPair(resolved.pair, resolved.tokenAddress);
  token.xHandle = xHandleFromPair(resolved.pair);
  const ageStr = getTokenAgeFlag(token.pairCreatedAt);
  token.ageStr = ageStr;
  token.liquidity = resolved.pair?.liquidity?.usd || token.liquidity || 0;

  await sendTrackingEmbed(message, token, storageKey, db, () =>
    buildTrackedEntry(token, storageKey, message, ageStr),
  );
}

async function fetchTokenData(address, messageText = '', { autotrack = false } = {}) {
  if (!isSolanaAddress(address)) return null;

  const dexOpts = autotrack ? { retries: 5, timeoutMs: 25_000 } : { retries: 2, timeoutMs: 12_000 };

  const dex = await fetchDexPair(address, {
    enabledChains: ['solana'],
    chainHint: 'solana',
    ...dexOpts,
  });
  if (dex?.name) return { ...dex, platform: 'dexscreener' };

  const pump = await fetchPumpFun(address);
  if (pump) {
    const solPrice = await fetchSolPrice();
    const pumpPrice = solPrice ? calcPumpFunPrice(pump, solPrice) : null;
    return {
      platform: 'pumpfun',
      chain: 'solana',
      name: pump.name,
      symbol: pump.symbol,
      price: pumpPrice ? String(pumpPrice) : null,
      marketCap: pump.usd_market_cap || 0,
      volume24h: 0,
      liquidity: 0,
      buys24h: 0,
      sells24h: 0,
      dexUrl: 'https://pump.fun/' + address,
      imageUrl: pump.image_uri || null,
      pairCreatedAt: pump.created_timestamp || null,
      bondingProgress: pump.bonding_curve_progress || 0,
      complete: pump.complete || false,
      creator: pump.creator || null,
      virtualSolReserves: pump.virtual_sol_reserves,
      virtualTokenReserves: pump.virtual_token_reserves,
    };
  }

  return null;
}

async function autoTrackSolana(address, message, seenThisMessage = new Set()) {
  const db = ensureDBSchema(loadDB());

  if (db.tokens[address]) {
    console.log('[autotrack] already tracking (exact key) ' + address.slice(0, 8) + '...');
    await onAlreadyTracking(message.client, db, address, message);
    return;
  }

  let token = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    token = await fetchTokenData(address, message.content, { autotrack: true });
    if (token) break;
    if (attempt < 2) {
      console.log('[autotrack] retry ' + (attempt + 2) + '/3 for ' + address.slice(0, 10) + '...');
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
    }
  }
  if (!token) {
    console.log('[skip] ' + address.slice(0, 8) + '... — not found');
    if (!shouldSilenceAlerts()) {
      await message.channel.send({
        embeds: [{
          color: 0xff4444,
          description:
            '⚠️ Could not find token data for `' + address + '` — not added to tracking\n\n' +
            'No DexScreener/pump.fun listing yet, or temporary API timeout — **try again in a moment.**',
          footer: { text: enabledChainsFooter() },
        }],
      }).catch(() => null);
    }
    return;
  }

  const storageKey = storageKeyForMint(address, token);

  if (seenThisMessage.has(storageKey)) {
    console.log('[autotrack] duplicate mint in same message: ' + storageKey.slice(0, 8) + '...');
    return;
  }

  const existingCanonical = resolveTokenKey(db, storageKey);
  if (existingCanonical || db.tokens[storageKey]) {
    const key = existingCanonical || storageKey;
    if (key !== storageKey && !isEvmAddress(storageKey)) {
      const og = db.tokens[key];
      db.tokens[storageKey] = { ...og, address: storageKey };
      delete db.tokens[key];
      saveDB(db);
      console.log(
        '[repair] fixed mint case for ' + (og.symbol || storageKey.slice(0, 8)) +
        ' — OG call preserved, polling restored',
      );
    } else {
      const sym = db.tokens[key]?.symbol || storageKey.slice(0, 8);
      console.log('[autotrack] already tracking ' + sym + ' (canonical mint — OG call preserved)');
      await onAlreadyTracking(message.client, db, key, message);
    }
    return;
  }

  const archivedKey = resolveArchivedKey(db, storageKey, address);
  if (archivedKey) {
    const og = db.archived[archivedKey];
    const newKey = archivedKey !== storageKey && !isEvmAddress(storageKey) ? storageKey : archivedKey;
    db.tokens[newKey] = { ...og, address: newKey };
    delete db.archived[archivedKey];
    saveDB(db);
    console.log('[repair] un-archived ' + (og.symbol || newKey.slice(0, 8)) + ' on repost — OG call preserved');
    return;
  }

  seenThisMessage.add(storageKey);

  const ageStr = getTokenAgeFlag(token.pairCreatedAt);
  token.ageStr = ageStr;
  token.liquidity = token.liquidity || 0;
  if (token.creator) token.creator = token.creator;

  await sendTrackingEmbed(message, token, storageKey, db, () =>
    buildTrackedEntry(token, storageKey, message, ageStr),
  );
}

async function fetchDexScreener(address, chainHint) {
  const enabled = parseEnabledChains();
  const chains = chainHint ? [chainHint] : enabled;
  const dex = await fetchDexPair(address, { enabledChains: chains, chainHint });
  if (!dex) return null;
  return {
    platform: 'dexscreener',
    name: dex.name,
    symbol: dex.symbol,
    chain: dex.chain,
    price: dex.price,
    marketCap: dex.marketCap,
    volume24h: dex.volume24h,
    liquidity: dex.liquidity,
    buys24h: dex.buys24h,
    sells24h: dex.sells24h,
    dexUrl: dex.dexUrl,
    imageUrl: dex.imageUrl,
    pairCreatedAt: dex.pairCreatedAt,
  };
}

async function fetchRugCheckReport(mint) {
  try {
    return await fetchRugCheckRaw(mint);
  } catch {
    return null;
  }
}

function moralisHeaders() {
  if (!process.env.MORALIS_API_KEY) return null;
  return { Authorization: 'Bearer ' + process.env.MORALIS_API_KEY };
}

async function fetchHeliusWalletHistory(wallet, limit = 40) {
  if (!process.env.HELIUS_API_KEY) return null;
  try {
    const url =
      'https://api.helius.xyz/v0/addresses/' +
      wallet +
      '/transactions?api-key=' +
      encodeURIComponent(process.env.HELIUS_API_KEY) +
      '&limit=' +
      limit;
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) return null;
    const txs = await res.json();
    if (!Array.isArray(txs)) return null;

    // Normalize key fields to the Moralis-like shape used in heuristics.
    return txs.map((tx) => {
      const t = tx?.timestamp ? new Date(Number(tx.timestamp) * 1000).toISOString() : null;
      const firstTransfer = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers[0] : null;
      return {
        blockTimestamp: t,
        baseToken: firstTransfer?.mint || null,
        exchangeAddress: tx?.feePayer || null,
        pairAddress: null,
        sold: { address: tx?.nativeTransfers?.[0]?.fromUserAccount || null },
        bought: { address: firstTransfer?.mint || null },
        subCategory: String(tx?.type || ''),
        exchangeName: String(tx?.source || ''),
      };
    });
  } catch {
    return null;
  }
}

async function fetchMoralisTokenSwaps(mint, limit = 120, order = 'ASC') {
  const headers = moralisHeaders();
  if (!headers) return null;
  try {
    const res = await fetch(
      'https://solana-gateway.moralis.io/token/mainnet/' + mint + '/swaps?limit=' + limit + '&order=' + order,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const j = await res.json();
    return j?.result || [];
  } catch {
    return null;
  }
}

async function fetchMoralisWalletSwaps(wallet, limit = 40, order = 'DESC') {
  const headers = moralisHeaders();
  if (headers) {
    try {
      const res = await fetch(
        'https://solana-gateway.moralis.io/account/mainnet/' + wallet + '/swaps?limit=' + limit + '&order=' + order,
        { headers, signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const j = await res.json();
        return j?.result || [];
      }
    } catch {}
  }
  // Fallback path when Moralis is unavailable/throttled.
  return fetchHeliusWalletHistory(wallet, limit);
}

function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  if (xs.length % 2 === 1) return xs[mid];
  return (xs[mid - 1] + xs[mid]) / 2;
}

function toMs(v) {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

function toMsTokenCreated(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e12 ? v : v * 1000;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function countBurstWindows(msList, windowMs, threshold) {
  const xs = msList.filter(Boolean).sort((a, b) => a - b);
  let count = 0;
  for (let i = 0; i < xs.length; i++) {
    let n = 1;
    for (let j = i + 1; j < xs.length; j++) {
      if (xs[j] - xs[i] <= windowMs) n++;
      else break;
    }
    if (n >= threshold) count++;
  }
  return count;
}

async function runWithLimit(items, limit, worker) {
  const out = [];
  let idx = 0;
  async function loop() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await worker(items[i], i); }
      catch { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => loop()));
  return out;
}

async function bitqueryRequest(query, variables) {
  if (!process.env.BITQUERY_API_KEY) return null;
  try {
    const res = await fetch('https://streaming.bitquery.io/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.BITQUERY_API_KEY,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (j?.errors?.length) return null;
    return j?.data || null;
  } catch {
    return null;
  }
}

function fmtAgeFromDate(dateInput) {
  const ms = toMs(dateInput);
  if (!ms) return '—';
  const diff = Date.now() - ms;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '<1h';
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd';
  const m = Math.floor(d / 30);
  return m + 'mo';
}

async function fetchBitqueryBundleQuick(mint) {
  const buysQuery =
    'query ($mint: String!) {' +
    ' Solana {' +
    '   DEXTrades(' +
    '     limit: {count: 200}' +
    '     orderBy: {ascending: Block_Time}' +
    '     where: {' +
    '       Trade: {Buy: {Currency: {MintAddress: {is: $mint}}}},' +
    '       Transaction: {Result: {Success: true}}' +
    '     }' +
    '   ) {' +
    '     Block { Time }' +
    '     Transaction { FeePayer }' +
    '     Trade { Buy { Amount Account { Address } } }' +
    '   }' +
    ' }' +
    '}';

  const buyData = await bitqueryRequest(buysQuery, { mint });
  const rows = buyData?.Solana?.DEXTrades || [];
  if (rows.length === 0) return null;

  const early = [];
  const seen = new Set();
  for (const r of rows) {
    const buyer = r?.Trade?.Buy?.Account?.Address;
    if (!buyer || seen.has(buyer)) continue;
    seen.add(buyer);
    early.push(r);
    if (early.length >= 30) break;
  }
  if (early.length === 0) return null;

  const sourceCounts = new Map();
  const buyerSource = new Map();
  const buyerAmount = new Map();
  const allTimes = [];
  for (const r of early) {
    const buyer = r?.Trade?.Buy?.Account?.Address;
    const source = String(r?.Transaction?.FeePayer || 'unknown');
    const amt = Number(r?.Trade?.Buy?.Amount || 0);
    const t = toMs(r?.Block?.Time);
    if (buyer) {
      buyerSource.set(buyer, source);
      buyerAmount.set(buyer, (buyerAmount.get(buyer) || 0) + (Number.isFinite(amt) ? amt : 0));
    }
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    if (t) allTimes.push(t);
  }

  const sortedSources = Array.from(sourceCounts.entries()).sort((a, b) => b[1] - a[1]);
  const topSource = sortedSources[0]?.[0] || 'unknown';
  const clusterSize = sortedSources[0]?.[1] || 0;
  const clusterWallets = Array.from(buyerSource.entries()).filter(([, s]) => s === topSource).map(([w]) => w);

  const totalFlow = Array.from(buyerAmount.values()).reduce((s, n) => s + n, 0);
  const clusterFlow = clusterWallets.reduce((s, w) => s + (buyerAmount.get(w) || 0), 0);
  const clusterFlowPct = totalFlow > 0 ? (clusterFlow / totalFlow) * 100 : 0;

  const entryBursts = countBurstWindows(allTimes, 10000, 3);
  const firstTrade = allTimes.length ? Math.min(...allTimes) : null;
  const clusterTimes = early
    .filter((r) => clusterWallets.includes(r?.Trade?.Buy?.Account?.Address))
    .map((r) => toMs(r?.Block?.Time))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const firstClusterStrong = (() => {
    for (let i = 0; i < clusterTimes.length; i++) {
      let n = 1;
      for (let j = i + 1; j < clusterTimes.length; j++) {
        if (clusterTimes[j] - clusterTimes[i] <= 10000) n++;
        else break;
      }
      if (n >= 3) return clusterTimes[i];
    }
    return null;
  })();
  const timeToBundleSec = firstTrade && firstClusterStrong
    ? Math.max(0, Math.round((firstClusterStrong - firstTrade) / 1000))
    : null;

  let synchronizedExits = 0;
  if (clusterWallets.length > 0) {
    const sellsQuery =
      'query ($mint: String!, $wallets: [String!]) {' +
      ' Solana {' +
      '   DEXTrades(' +
      '     limit: {count: 200}' +
      '     orderBy: {ascending: Block_Time}' +
      '     where: {' +
      '       Trade: {Sell: {Currency: {MintAddress: {is: $mint}}, Account: {Address: {in: $wallets}}}},' +
      '       Transaction: {Result: {Success: true}}' +
      '     }' +
      '   ) {' +
      '     Block { Time }' +
      '   }' +
      ' }' +
      '}';
    const sellData = await bitqueryRequest(sellsQuery, { mint, wallets: clusterWallets });
    const sellRows = sellData?.Solana?.DEXTrades || [];
    synchronizedExits = countBurstWindows(sellRows.map((r) => toMs(r?.Block?.Time)), 10000, 2);
  }

  let fired = 0;
  if (clusterSize >= 8) fired++;
  if (clusterFlowPct >= 45) fired++;
  if (entryBursts >= 2) fired++;
  if (timeToBundleSec !== null && timeToBundleSec <= 120) fired++;
  if (synchronizedExits >= 1) fired++;
  const confidence = fired >= 4 ? 'High' : fired >= 2 ? 'Medium' : 'Low';

  return {
    sampleBuys: rows.length,
    earlyCount: early.length,
    clusterSize,
    clusterFlowPct,
    timeToBundleSec,
    synchronizedExits,
    confidence,
  };
}

async function fetchDeepForensics(mint, creator, deadline) {
  const out = {
    bundle: null,
    dev: null,
  };

  const swaps = await fetchMoralisTokenSwaps(mint, 300, 'ASC');
  if (swaps && swaps.length) {
    const buys = swaps.filter((s) => s.transactionType === 'buy');
    const earlyByWallet = new Map();
    for (const b of buys) {
      if (Date.now() > deadline) break;
      const w = b.walletAddress;
      if (!w || earlyByWallet.has(w)) continue;
      earlyByWallet.set(w, b);
      if (earlyByWallet.size >= 40) break;
    }
    const early = Array.from(earlyByWallet.values());
    const wallets = early.map((e) => e.walletAddress);
    const firstBuyTs = toMs(early[0]?.blockTimestamp);

    const walletHist = await runWithLimit(wallets, 8, async (w) => {
      if (Date.now() > deadline) return null;
      const hist = await fetchMoralisWalletSwaps(w, 60, 'ASC');
      if (!hist || hist.length === 0) return { wallet: w, firstSeen: null, sourceKey: 'unknown', reuse: 0 };
      const first = hist[0];
      const firstSeen = toMs(first.blockTimestamp);
      const sourceKey = String(first.exchangeAddress || first.sold?.address || first.pairAddress || 'unknown');
      const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
      const reuseTokens = new Set(
        hist
          .filter((x) => toMs(x.blockTimestamp) && toMs(x.blockTimestamp) >= thirtyDaysAgo)
          .map((x) => x.baseToken)
          .filter((t) => t && t !== mint)
      );
      return { wallet: w, firstSeen, sourceKey, reuse: reuseTokens.size };
    });

    const sourceGroups = new Map();
    for (const h of walletHist.filter(Boolean)) {
      sourceGroups.set(h.sourceKey, (sourceGroups.get(h.sourceKey) || 0) + 1);
    }
    const clusterSize = sourceGroups.size ? Math.max(...sourceGroups.values()) : 0;
    const clusterSource = Array.from(sourceGroups.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    const clusterWallets = walletHist.filter((h) => h && h.sourceKey === clusterSource).map((h) => h.wallet);

    const amountByWallet = new Map(early.map((e) => [e.walletAddress, Number(e.totalValueUsd || e.bought?.usdAmount || 0)]));
    const totalFlow = Array.from(amountByWallet.values()).reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
    const clusterFlow = clusterWallets.reduce((s, w) => s + (amountByWallet.get(w) || 0), 0);
    const clusterFlowPct = totalFlow > 0 ? (clusterFlow / totalFlow) * 100 : 0;

    const buyTimes = early.map((e) => toMs(e.blockTimestamp)).filter(Boolean);
    const entryBursts = countBurstWindows(buyTimes, 10000, 3);
    const timeToBundleSec = buyTimes.length && clusterWallets.length >= 2
      ? Math.max(
        0,
        Math.round(
          (Math.min(...buyTimes.filter((_, i) => clusterWallets.includes(early[i]?.walletAddress))) - Math.min(...buyTimes)) / 1000
        )
      )
      : null;

    const freshWallets = walletHist.filter((h) => h?.firstSeen && firstBuyTs && (firstBuyTs - h.firstSeen) <= 24 * 3600 * 1000).length;
    const freshRatio = early.length > 0 ? (freshWallets / early.length) * 100 : 0;
    const reusedWallets = walletHist.filter((h) => h && h.reuse >= 2).length;

    const sells = swaps.filter((s) => s.transactionType === 'sell' && clusterWallets.includes(s.walletAddress));
    const synchronizedExits = countBurstWindows(sells.map((s) => toMs(s.blockTimestamp)), 10000, 2);

    out.bundle = {
      earlyCount: early.length,
      clusterSize,
      clusterFlowPct,
      entryBursts,
      timeToBundleSec,
      synchronizedExits,
      freshRatio,
      reusedWallets,
    };
  }

  if (creator && Date.now() <= deadline) {
    const hist = await fetchMoralisWalletSwaps(creator, 250, 'DESC');
    if (hist && hist.length) {
      const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
      const launches = Array.from(new Set(
        hist
          .filter((x) => toMs(x.blockTimestamp) && toMs(x.blockTimestamp) >= cutoff)
          .filter((x) => x.subCategory === 'newPosition' || String(x.exchangeName || '').toLowerCase().includes('pump'))
          .map((x) => x.bought?.address || x.baseToken)
          .filter((t) => t && t !== mint && t !== 'So11111111111111111111111111111111111111112')
      )).slice(0, 24);

      const reports = await runWithLimit(launches.slice(0, 15), 5, async (m) => {
        if (Date.now() > deadline) return null;
        return fetchRugCheckReport(m);
      });
      const valid = reports.filter(Boolean);
      const rugged = valid.filter((r) => r.rugged || Number(r.score_normalised ?? r.score_normalized ?? 0) >= 70);
      const rugRate = valid.length > 0 ? (rugged.length / valid.length) * 100 : 0;
      const ttdDays = valid
        .map((r) => {
          const detected = toMs(r?.detectedAt);
          const created = toMs((r?.creatorTokens || []).find((x) => x?.mint === r?.mint)?.createdAt) || toMs((r?.markets || [])[0]?.createdAt);
          return detected && created ? Math.max(0, (detected - created) / (24 * 3600 * 1000)) : null;
        })
        .filter((x) => x !== null);

      out.dev = {
        sampled: valid.length,
        ruggedCount: rugged.length,
        rugRate,
        medianTimeToDeathDays: median(ttdDays),
      };
    }
  }

  return out;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  const refs = extractAddresses(message.content);
  if (refs.length === 0) return;
  console.log('[detect] Found ' + refs.length + ' address(es) from ' + message.author.username);
  const seenThisMessage = new Set();
  for (const ref of refs) {
    await autoTrack(ref, message, seenThisMessage).catch((e) =>
      console.error('[autotrack] Error for ' + ref.raw + ':', e.message),
    );
  }
});

const commands = [
  fibtrackCommand,
  new SlashCommandBuilder()
    .setName('calls')
    .setDescription('Show all tracked tokens and their current performance'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Stop tracking a token')
    .addStringOption(opt =>
      opt.setName('address').setDescription('Contract address').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('pelpafkedup')
    .setDescription('Emergency — stop tracking a spamming CA (same as /remove)')
    .addStringOption(opt =>
      opt.setName('address').setDescription('Contract address that is spazzing out').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('x')
    .setDescription('X account risk — profile, renames, and your group call history')
    .addStringOption((opt) =>
      opt
        .setName('handle')
        .setDescription('X @handle, X URL, or tracked CA')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('rug')
    .setDescription('Run RugCheck + bundle risk scan for a Solana token')
    .addStringOption(opt =>
      opt.setName('mint').setDescription('Solana token mint address').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('rugdeep')
    .setDescription('Run deep RugCheck + bundle + dev forensics scan (slower)')
    .addStringOption(opt =>
      opt.setName('mint').setDescription('Solana token mint address').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Manage smart wallet watchlist')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Watch a wallet and get alerts when it trades')
        .addStringOption(opt =>
          opt.setName('address').setDescription('Solana wallet address').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('label').setDescription('Label for this wallet e.g. "whale1"').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Stop watching a wallet')
        .addStringOption(opt =>
          opt.setName('address').setDescription('Solana wallet address').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all watched wallets')
    ),
  new SlashCommandBuilder()
    .setName('devs')
    .setDescription('Creator wallets inferred from tracked tokens')
    .addSubcommand(sub =>
      sub
        .setName('random')
        .setDescription('30 random dev wallets + token launch counts in the last 30 days')
    ),
  new SlashCommandBuilder()
    .setName('devrandom')
    .setDescription('30 random dev wallets from tracked + 30-day launch counts (same as /devs random)'),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Caller stats for a Discord user')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Member to rank').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top callers by hit rate')
    .addStringOption((opt) =>
      opt
        .setName('period')
        .setDescription('weekly or alltime')
        .addChoices(
          { name: 'weekly', value: 'weekly' },
          { name: 'alltime', value: 'alltime' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('ape')
    .setDescription('Set your personal entry price on a tracked token')
    .addStringOption((opt) => opt.setName('ca').setDescription('Contract address').setRequired(true))
    .addNumberOption((opt) => opt.setName('price').setDescription('Your entry price (optional)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('mybags')
    .setDescription('Your personal positions on tracked tokens'),
  new SlashCommandBuilder()
    .setName('follow')
    .setDescription('DM when a caller posts a new CA')
    .addUserOption((opt) => opt.setName('user').setDescription('Caller to follow').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unfollow')
    .setDescription('Stop following a caller')
    .addUserOption((opt) => opt.setName('user').setDescription('Caller to unfollow').setRequired(true)),
  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('DM on alerts for a tracked token')
    .addStringOption((opt) => opt.setName('ca').setDescription('Contract address').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unwatch')
    .setDescription('Stop watching a token')
    .addStringOption((opt) => opt.setName('ca').setDescription('Contract address').setRequired(true)),
  new SlashCommandBuilder()
    .setName('tag')
    .setDescription('Tag a tracked token (max 3 meta tags)')
    .addStringOption((opt) => opt.setName('ca').setDescription('Contract address').setRequired(true))
    .addStringOption((opt) => opt.setName('tags').setDescription('Comma-separated tags').setRequired(true)),
  new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Run Warden Layer-1 DB invariant checks (ephemeral)'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: commands }
      );
      console.log('Slash commands registered (guild — instant)');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('Slash commands registered (global — up to 1hr to appear)');
    }
  } catch (e) {
    console.error('Failed to register commands:', e.message);
  }
}

async function handleDevsRandom(interaction) {
  await interaction.deferReply();
  const db = ensureDBSchema(loadDB());
  const entries = Object.values(db.tokens || {});
  if (entries.length === 0) {
    return interaction.editReply('📭 No tracked tokens yet — call some mints in chat first.');
  }

  const mintByDev = new Map();
  for (const e of entries) {
    const d = e.devWallet;
    if (d && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(d) && !mintByDev.has(d)) {
      mintByDev.set(d, e.address);
    }
  }

  const toProbe = shuffleArray(
    entries.filter((e) => {
      if (!e.devWallet) return true;
      return !mintByDev.has(e.devWallet);
    })
  );

  let pumpFetches = 0;
  for (const e of toProbe) {
    if (mintByDev.size >= 150) break;
    if (pumpFetches >= 40) break;
    pumpFetches++;
    const pump = await fetchPumpFun(e.address);
    const c = pump && pump.creator;
    if (c && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c) && !mintByDev.has(c)) {
      mintByDev.set(c, e.address);
    }
  }

  let pairs = shuffleArray([...mintByDev.entries()]).slice(0, 30);
  if (pairs.length === 0) {
    return interaction.editReply(
      '❌ No creator wallets found. Tracked entries may be missing deployer metadata — try pump.fun mints.'
    );
  }

  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const rows = await runWithLimit(pairs, 4, async ([dev, mint]) => {
    const report = await fetchRugCheckReport(mint);
    if (!report) {
      return { dev, mint, count30d: null, mismatch: false };
    }
    const rcCreator = report.creator || null;
    const tokens = Array.isArray(report.creatorTokens) ? report.creatorTokens : [];
    let count30d = 0;
    for (const t of tokens) {
      const ms = toMsTokenCreated(t.createdAt || t.created_at);
      if (ms !== null && ms >= cutoffMs) count30d++;
    }
    const mismatch = !!(rcCreator && rcCreator !== dev);
    return { dev, mint, count30d, mismatch };
  });

  const validRows = rows.filter(Boolean);
  validRows.sort((a, b) => {
    const ac = a.count30d == null ? -1 : a.count30d;
    const bc = b.count30d == null ? -1 : b.count30d;
    return bc - ac;
  });

  const lines = validRows.map((r, i) => {
    const cnt = r.count30d === null ? 'N/A' : String(r.count30d);
    const warn = r.mismatch ? ' ⚠️' : '';
    return (
      '**' +
      (i + 1) +
      '.** `' +
      r.dev +
      '` — **' +
      cnt +
      '** in last 30d' +
      warn
    );
  });

  const embed = new EmbedBuilder()
    .setColor(0xa855f7)
    .setTitle('🎲 30 random creator wallets (from tracked)')
    .setDescription(
      'Deploy counts = tokens with **creation time** in the last **30 days** (from index for that wallet). ' +
        'Each row uses one of your **tracked mints** for that creator.\n\n' +
        lines.join('\n').slice(0, 4090)
    )
    .setFooter({
      text:
        validRows.length +
        ' wallets · N/A = no report or no dated launches · ⚠️ sample mint creator ≠ stored dev',
    })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handleCalls(interaction) {
  await interaction.deferReply();
  const db = ensureDBSchema(loadDB());
  const entries = Object.values(db.tokens || {})
    .sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
  if (entries.length === 0) {
    return interaction.editReply('Nothing tracked yet — drop a contract address in chat.');
  }

  const STALE_MS = 15 * 60 * 1000;
  const lines = entries.slice(0, 40).map((entry) => {
    const last = entry.lastPrice ? Number(entry.lastPrice) : null;
    const call = entry.priceAtCall ? Number(entry.priceAtCall) : null;
    let multStr = '—';
    if (last && call && call > 0) {
      const mult = last / call;
      const stale = Date.now() - (entry.lastChecked || 0) > STALE_MS ? ' ⏳' : '';
      const backfillMark = entry.priceAtCallBackfilled ? ' ~' : '';
      multStr =
        (mult >= 2 ? '🚀 **' : mult >= 1 ? '📈 ' : '📉 ') +
        mult.toFixed(2) + 'x' +
        (mult >= 2 ? '**' : '') +
        stale + backfillMark;
    }
    const peakNote =
      entry.athLedger?.peakMultiple > 1.2
        ? ' · peaked ' + entry.athLedger.peakMultiple.toFixed(1) + 'x'
        : '';
    return chainBadge(entry.chain) + lifecyclePrefix(entry) + ' **' + entry.name + ' (' + entry.symbol + ')** — ' + multStr +
           peakNote +
           '\n└ **' + entry.postedBy + '** · ' + fmtTime(entry.postedAt);
  });

  const footer =
    'showing newest 40 of ' + entries.length +
    ' · ⏳ = stale (>15m since last poll)' +
    (entries.some((e) => e.priceAtCallBackfilled) ? ' · ~ = backfilled call price' : '');

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle('Tracked Tokens')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: footer })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction) {
  const address = interaction.options.getString('address').trim();
  const db = ensureDBSchema(loadDB());
  const key = resolveUserInputToKey(db, address);
  if (!key) {
    return interaction.reply({ content: 'Not tracking `' + address + '`', ephemeral: true });
  }
  const name = db.tokens[key].name;
  const symbol = db.tokens[key].symbol;
  delete db.tokens[key];
  markRemovedThisCycle(key);
  saveDB(db);
  await interaction.reply('Stopped tracking **' + name + ' (' + symbol + ')** · `' + key + '`');
}

async function handleRank(interaction) {
  await interaction.deferReply();
  const user = interaction.options.getUser('user') || interaction.user;
  const db = ensureDBSchema(loadDB());
  let stats = computeInlineCallerStats(db, user.id, user.username);
  if (!stats || stats.totalCalls === 0) {
    return interaction.editReply('No tracked calls from that user yet.');
  }
  const hitPct = Math.round((stats.hits2x / Math.max(1, stats.totalCalls)) * 100);
  const best = stats.bestCall;
  const bestLine = best
    ? '$' + best.symbol + ' — ' + best.peak.toFixed(1) + 'x (' +
      new Date(best.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ')'
    : '—';
  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle('🏆 Rank — @' + user.username)
    .setDescription(
      'Calls: ' + stats.totalCalls + ' · Hit rate (2x+): ' + hitPct + '% · Rugs: ' +
      Math.round((stats.rugs / Math.max(1, stats.totalCalls)) * 100) + '%\n' +
      'Avg peak: ' + stats.avgPeak + 'x · Median time to 2x: ' +
      formatDurationMins(stats.medianMinsTo2x) + ' · Streak: ' + stats.streak2x + ' 🔥\n' +
      'Best call: ' + bestLine,
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

async function handleLeaderboard(interaction) {
  await interaction.deferReply();
  const period = interaction.options.getString('period') || 'weekly';
  const db = ensureDBSchema(loadDB());
  const since = period === 'weekly' ? Date.now() - 7 * 24 * 60 * 60 * 1000 : 0;
  const byUser = new Map();
  for (const e of Object.values(db.tokens || {})) {
    if (since && (e.postedAt || 0) < since) continue;
    if (!e.postedByUserId) continue;
    if (!byUser.has(e.postedByUserId)) byUser.set(e.postedByUserId, []);
    byUser.get(e.postedByUserId).push(e);
  }
  const rows = [];
  for (const [userId, calls] of byUser) {
    if (calls.length < 3) continue;
    const hits = calls.filter((e) => (Number(e.peakMultiple) || 1) >= 2).length;
    const avg =
      calls.reduce((s, e) => s + (Number(e.peakMultiple) || 1), 0) / calls.length;
    rows.push({
      name: calls[0].postedBy || userId,
      hitPct: Math.round((hits / calls.length) * 100),
      avg: Math.round(avg * 10) / 10,
      total: calls.length,
    });
  }
  rows.sort((a, b) => b.hitPct - a.hitPct || b.avg - a.avg);
  if (!rows.length) {
    const msg = period === 'weekly'
      ? 'Not enough resolved calls this week.'
      : 'Not enough resolved calls to rank (min 3 per caller).';
    return interaction.editReply(msg);
  }
  const title = period === 'weekly' ? '🏆 Leaderboard — This Week' : '🏆 Leaderboard — All Time';
  const lines = rows.slice(0, 10).map((r, i) =>
    (i + 1) + '. @' + r.name + ' — ' + r.hitPct + '% hits · ' + r.avg + 'x avg · ' + r.total + ' calls',
  );
  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(title)
    .setDescription(lines.join('\n') + '\n\nMin 3 calls to rank. Full stats: /rank @user')
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

async function handleApe(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const ca = interaction.options.getString('ca').trim();
  const priceOpt = interaction.options.getNumber('price');
  const db = ensureDBSchema(loadDB());
  const mint = resolveTrackedMint(db, ca);
  if (!mint) {
    return interaction.editReply('Not tracking that CA. Post it in the channel first to start tracking.');
  }
  const entry = db.tokens[mint];
  let px = priceOpt;
  if (px == null) px = entry.lastPrice ? Number(entry.lastPrice) : null;
  if (px == null || !Number.isFinite(px) || px <= 0) {
    return interaction.editReply('No live price yet — pass `price:` explicitly.');
  }
  setPosition(db, mint, interaction.user.id, px);
  saveDB(db);
  await interaction.editReply(
    'Updated your entry on **$' + entry.symbol + '** to $' + Number(px).toFixed(8),
  );
}

async function handleMybags(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const db = ensureDBSchema(loadDB());
  const rows = buildMyBagsLines(db, interaction.user.id);
  if (!rows.length) {
    return interaction.editReply('💼 No open positions — use `/ape` on a tracked token.');
  }
  const capped = rows.slice(0, 25);
  const extra = rows.length > 25 ? '\n…and ' + (rows.length - 25) + ' more' : '';
  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setTitle('💼 Your bags (' + rows.length + ')')
    .setDescription(capped.map((r) => r.line).join('\n') + extra)
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

async function handleFollow(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const user = interaction.options.getUser('user');
  if (!user) return interaction.editReply('Pick a user to follow.');
  const db = ensureDBSchema(loadDB());
  followCaller(db, user.id, interaction.user.id);
  saveDB(db);
  await interaction.editReply("Following **@" + user.username + "** — you'll get a DM whenever they call.");
}

async function handleUnfollow(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const user = interaction.options.getUser('user');
  const db = ensureDBSchema(loadDB());
  if (!unfollowCaller(db, user.id, interaction.user.id)) {
    return interaction.editReply("You weren't following that.");
  }
  saveDB(db);
  await interaction.editReply('Unfollowed **@' + user.username + '**.');
}

async function handleWatch(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const ca = interaction.options.getString('ca').trim();
  const db = ensureDBSchema(loadDB());
  const mint = resolveMintForCommand(db, ca);
  if (!mint) return interaction.editReply('Not tracking that CA.');
  watchToken(db, mint, interaction.user.id);
  saveDB(db);
  await interaction.editReply(
    'Watching **$' + db.tokens[mint].symbol + '** — DMs on alerts for this token.',
  );
}

async function handleUnwatch(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const ca = interaction.options.getString('ca').trim();
  const db = ensureDBSchema(loadDB());
  const mint = resolveMintForCommand(db, ca);
  if (!mint) return interaction.editReply('Not tracking that CA.');
  if (!unwatchToken(db, mint, interaction.user.id)) {
    return interaction.editReply("You weren't watching that.");
  }
  saveDB(db);
  await interaction.editReply('Stopped watching **$' + db.tokens[mint].symbol + '**.');
}

async function handleTag(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const ca = interaction.options.getString('ca').trim();
  const tagsRaw = interaction.options.getString('tags');
  const db = ensureDBSchema(loadDB());
  const mint = resolveMintForCommand(db, ca);
  if (!mint) return interaction.editReply('Not tracking that CA.');
  const parsed = parseTagsInput(tagsRaw);
  const v = validateTags(parsed);
  if (!v.ok) return interaction.editReply(v.error);
  applyTags(db.tokens[mint], v.tags);
  saveDB(db);
  await interaction.editReply('Tagged **$' + db.tokens[mint].symbol + '**: ' + v.tags.join(', '));
}

async function handleAudit(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const db = ensureDBSchema(loadDB());
  const result = auditDatabase(db, cycleStats.broken || 0);
  await interaction.editReply(formatAuditTable(result));
}

/** Solana-only case-insensitive key lookup (mint-case repair). */
function resolveTokenKey(db, rawAddress) {
  const trimmed = rawAddress.trim();
  if (db.tokens[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  if (db.tokens[lower]) return lower;
  return (
    Object.keys(db.tokens).find((k) => {
      const p = parseStorageKey(k);
      return p.chainId === 'solana' && k.toLowerCase() === lower;
    }) || null
  );
}

/** Emergency untrack when a token spams alerts — same as /remove, public confirmation. */
async function handlePelpaFkedup(interaction) {
  const address = interaction.options.getString('address').trim();
  const db = ensureDBSchema(loadDB());
  const key = resolveUserInputToKey(db, address);
  if (!key) {
    return interaction.reply({
      content: '🤷 Not tracking `' + address + '` — nothing to yeet.',
      ephemeral: true,
    });
  }
  const name = db.tokens[key].name;
  const symbol = db.tokens[key].symbol;
  delete db.tokens[key];
  markRemovedThisCycle(key);
  saveDB(db);
  console.log('[pelpafkedup] ' + interaction.user.username + ' removed ' + symbol + ' (' + key + ')');
  await interaction.reply(
    '🚨 **Pelpa fked up** — stopped tracking **' + name + ' (' + symbol + ')**.\n`' + key + '`\nNo more alerts for this CA.',
  );
}

async function handleRug(interaction, forcedMode = null) {
  await interaction.deferReply();
  const mode = forcedMode || 'quick';
  const isDeep = mode === 'deep';
  const rawMint =
    interaction.options.getString('mint') ||
    interaction.options.getString('address') ||
    '';
  const mint = rawMint.trim();

  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return interaction.editReply('❌ Invalid Solana mint address.');
  }

  const cacheKey = mint + ':' + mode;
  const cacheHit = rugCache[cacheKey];
  if (cacheHit && Date.now() - cacheHit.ts < RUG_CACHE_TTL_MS) {
    return interaction.editReply({ embeds: [cacheHit.embed] });
  }

  const deadline = Date.now() + (isDeep ? 90000 : 15000);
  const timeLeft = () => Math.max(500, deadline - Date.now());
  const timed = async (fn) => Promise.race([
    fn(),
    new Promise((resolve) => setTimeout(() => resolve(null), timeLeft())),
  ]);

  const [tokenBlock, riskBlock, bundleBlock] = await Promise.allSettled([
    timed(async () => {
      const [token, pump, dex] = await Promise.all([
        fetchTokenData(mint),
        fetchPumpFun(mint),
        fetchDexScreener(mint),
      ]);
      return { token, pump, dex };
    }),
    timed(async () => {
      const rug = await fetchRugCheckReport(mint);
      if (!rug) return null;
      const norm = Number(rug.score_normalised ?? rug.score_normalized ?? 0);
      const level = norm >= 71 ? 'High' : norm >= 31 ? 'Medium' : 'Low';
      const top10 = (rug.topHolders || []).slice(0, 10);
      const top10Pct = top10.reduce((s, h) => s + Number(h?.pct || h?.percentage || 0), 0);
      const mintAuthEnabled = !!rug.mintAuthority;
      const freezeAuthEnabled = !!rug.freezeAuthority;
      const risks = (rug.risks || []).map((r) => r?.name).filter(Boolean);
      const lpProviders = Number(rug.totalLPProviders || 0);
      const lpLockedPct = lpProviders > 0 ? Math.min(100, Number((rug.lockers || []).length > 0 ? 100 : 0)) : 0;
      return { rug, norm, level, top10Pct, mintAuthEnabled, freezeAuthEnabled, risks, lpLockedPct };
    }),
    timed(async () => {
      return fetchBitqueryBundleQuick(mint);
    })
  ]);

  const tokenData = tokenBlock.status === 'fulfilled' ? tokenBlock.value : null;
  const riskData = riskBlock.status === 'fulfilled' ? riskBlock.value : null;
  const bundleData = bundleBlock.status === 'fulfilled' ? bundleBlock.value : null;
  let devData = null;
  if (riskData?.rug?.creator) {
    const creator = riskData.rug.creator;
    const creatorTokens = Array.isArray(riskData.rug.creatorTokens) ? riskData.rug.creatorTokens : [];
    const launches = creatorTokens
      .map((x) => ({ mint: x?.mint, createdAt: x?.createdAt }))
      .filter((x) => x.mint && x.mint !== mint)
      .sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0));
    const sampledMints = launches.slice(0, 12).map((x) => x.mint);
    const sampledReports = await runWithLimit(sampledMints, 4, async (m) => {
      if (Date.now() > deadline) return null;
      return fetchRugCheckReport(m);
    });
    const valid = sampledReports.filter(Boolean);
    const rugged = valid.filter((r) => r.rugged || Number(r.score_normalised ?? r.score_normalized ?? 0) >= 70);
    const rugRate = valid.length ? (rugged.length / valid.length) * 100 : 0;
    const mcapList = valid
      .map((r) => ({ mint: r?.mint, mcap: Number(r?.tokenMeta?.marketCap || r?.token?.marketCap || 0), rugged: !!r?.rugged }))
      .filter((x) => x.mint)
      .sort((a, b) => (b.mcap || 0) - (a.mcap || 0))
      .slice(0, 5);

    let watchlistHit = false;
    try {
      if (fs.existsSync(WATCHLIST_PATH)) {
        const list = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
        if (Array.isArray(list)) watchlistHit = list.includes(creator);
      }
    } catch {}

    const repeatPattern = (bundleData?.confidence === 'High' && rugRate >= 50) ? 'YES' : 'NO';
    devData = {
      creator,
      pastLaunches: launches.length,
      sampled: valid.length,
      ruggedCount: rugged.length,
      rugRate,
      repeatPattern,
      watchlistHit,
      mcapList,
    };
  }

  let deepData = null;
  if (isDeep) {
    deepData = await fetchDeepForensics(mint, riskData?.rug?.creator || null, deadline);
  }

  // Do not hard-fail when market APIs miss if RugCheck still has data.
  if (!tokenData?.pump && !tokenData?.dex && !riskData?.rug) {
    return interaction.editReply('❌ Token not found on pump.fun or DexScreener.');
  }

  const name = tokenData?.token?.name || riskData?.rug?.tokenMeta?.name || mint.slice(0, 8) + '...';
  const symbol = tokenData?.token?.symbol || riskData?.rug?.tokenMeta?.symbol || 'SOL';
  const rug = riskData?.rug || null;

  const lines = [];
  let high = false;
  let med = false;

  lines.push('**' + name + ' (' + symbol + ')**');
  const priceUsd = tokenData?.token?.price ? Number(tokenData.token.price) : null;
  const liqUsd = rug?.totalMarketLiquidity ?? tokenData?.dex?.liquidity ?? tokenData?.token?.liquidity ?? null;
  const volUsd = tokenData?.dex?.volume24h ?? tokenData?.token?.volume24h ?? null;
  const holders = rug?.totalHolders ?? null;
  const ageStr = fmtAgeFromDate(rug?.detectedAt || tokenData?.pump?.created_timestamp || tokenData?.dex?.pairCreatedAt || tokenData?.token?.pairCreatedAt || null);
  const launchpad = rug?.launchpad || (tokenData?.pump ? 'pump.fun' : 'unknown');
  const migrated = tokenData?.pump?.complete === true ? 'PumpSwap' : (tokenData?.pump ? 'pump.fun' : 'unknown');
  const launchpadText = typeof launchpad === 'string' ? launchpad : (launchpad?.name || 'unknown');
  lines.push(
    'Price: ' + (priceUsd ? '$' + priceUsd.toFixed(priceUsd >= 0.01 ? 4 : 8) : '—') +
    ' | Liq: ' + fmtUsd(liqUsd) + ' | Vol: ' + fmtUsd(volUsd)
  );
  lines.push('Holders: ' + (holders ? Number(holders).toLocaleString() : '—') + ' | Age: ' + ageStr);
  lines.push('Path: ' + launchpadText + ' -> ' + migrated);

  lines.push('');
  lines.push('🛡️ **TOKEN RISK**');
  if (riskData) {
    const score = Number(riskData.norm || 0);
    lines.push('Score: ' + score + '/100 (' + riskData.level + ')');
    lines.push('Mint: ' + (riskData.mintAuthEnabled ? 'enabled' : 'revoked') +
      ' | Freeze: ' + (riskData.freezeAuthEnabled ? 'enabled' : 'revoked'));
    lines.push('LP: ' + (riskData.lpLockedPct > 0 ? 'locked ' + riskData.lpLockedPct.toFixed(0) + '%' : 'unlocked'));
    lines.push('Top10: ' + riskData.top10Pct.toFixed(1) + '%');
    lines.push('Risks: ' + (riskData.risks.length ? riskData.risks.slice(0, 4).join(', ') : 'none'));
    const devSold = riskData.risks.some((r) => String(r).toLowerCase().includes('creator history of rugged tokens') || String(r).toLowerCase().includes('dev sold'));
    const insiderCount = Number(rug?.insiderNetworks?.length || 0);
    lines.push('Dev sold: ' + (devSold ? 'yes' : 'no-signal') + ' | Insiders: ' + insiderCount);
    if (riskData.level === 'High') high = true;
    else if (riskData.level === 'Medium') med = true;
  } else {
    lines.push('N/A');
  }

  lines.push('');
  lines.push('📦 **BUNDLE RISK**');
  if (bundleData) {
    lines.push('Cluster: ' + bundleData.clusterSize + '/' + bundleData.earlyCount);
    lines.push('Flow: ' + bundleData.clusterFlowPct.toFixed(1) + '%');
    lines.push('TTB: ' + (bundleData.timeToBundleSec === null ? 'N/A' : bundleData.timeToBundleSec + 's'));
    lines.push('Sync exits: ' + bundleData.synchronizedExits);
    lines.push('Sample: ' + bundleData.sampleBuys + ' buys');
    lines.push('Confidence: ' + bundleData.confidence);
    if (bundleData.confidence === 'High') high = true;
    else if (bundleData.confidence === 'Medium') med = true;
  } else {
    lines.push('N/A');
  }
  if (deepData?.bundle) {
    lines.push('Deep fresh: ' + deepData.bundle.freshRatio.toFixed(0) + '%');
    lines.push('Deep reuse: ' + deepData.bundle.reusedWallets + '/' + deepData.bundle.earlyCount);
    lines.push('Deep bursts: ' + deepData.bundle.entryBursts);
  } else if (isDeep) {
    lines.push('Deep bundle: N/A');
  }

  lines.push('');
  lines.push('👤 **DEV HISTORY**');
  if (devData) {
    lines.push('Launches: ' + devData.pastLaunches);
    lines.push('Rug rate: ' + devData.ruggedCount + '/' + devData.sampled);
    lines.push('Repeat: ' + devData.repeatPattern);
    lines.push('Watchlist: ' + (devData.watchlistHit ? 'FLAGGED' : 'clean'));
    if (devData.mcapList.length) {
      lines.push('Past MCAPs: ' + devData.mcapList
        .map((x) => x.mint.slice(0, 6) + '… ' + fmtUsd(x.mcap))
        .join(' · '));
    }
    if (devData.rugRate >= 50) high = true;
    else if (devData.rugRate >= 25) med = true;
  } else {
    lines.push('N/A');
  }
  if (deepData?.dev) {
    lines.push('Deep sampled: ' + deepData.dev.sampled);
    lines.push('Deep rug: ' + deepData.dev.ruggedCount + '/' + deepData.dev.sampled);
    lines.push('Deep median TTD: ' + (deepData.dev.medianTimeToDeathDays === null ? 'N/A' : deepData.dev.medianTimeToDeathDays.toFixed(1) + 'd'));
  } else if (isDeep) {
    lines.push('Deep dev: N/A');
  }

  lines.push('');
  lines.push('📌 **VERDICT**');
  const verdict = high ? '🔴 HIGH RISK' : med ? '🟠 MIXED RISK' : '🟢 LOW RISK';
  lines.push(verdict);
  const dexUrl = tokenData?.dex?.dexUrl || tokenData?.token?.dexUrl || null;
  const pumpUrl = tokenData?.pump ? ('https://pump.fun/' + mint) : null;
  const links = [
    dexUrl ? '[DEX](' + dexUrl + ')' : null,
    pumpUrl ? '[PUMP](' + pumpUrl + ')' : null,
  ].filter(Boolean);
  if (links.length) {
    lines.push('🔗 ' + links.join(' | '));
  }

  const color = high ? 0xff3b30 : med ? 0xffa500 : 0x00c853;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('💎 ' + (isDeep ? '/rugdeep' : '/rug') + ' — ' + symbol)
    .setDescription(lines.join('\n').slice(0, 4000))
    .addFields({ name: 'Mint', value: '`' + mint + '`' })
    .setFooter({ text: 'Risk signals only — not certainty' })
    .setTimestamp();

  if (tokenData?.token?.imageUrl) embed.setThumbnail(tokenData.token.imageUrl);
  rugCache[cacheKey] = { ts: Date.now(), embed };
  return interaction.editReply({ embeds: [embed] });
}

async function handleWalletAdd(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const address = interaction.options.getString('address').trim();
  const label = interaction.options.getString('label') || address.slice(0, 8) + '...';

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return interaction.editReply('❌ Invalid Solana address.');
  }

  const db = ensureDBSchema(loadDB());
  if (db.wallets[address]) {
    return interaction.editReply('👀 Already watching **' + db.wallets[address].label + '**');
  }

  db.wallets[address] = {
    address,
    label,
    addedBy: interaction.user.username,
    addedAt: Date.now(),
    alertChannelId: interaction.channelId,
    lastSeenTx: null,
  };

  saveDB(db);
  console.log('[wallet] Added ' + label + ' (' + address + ')');

  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setTitle('👛 Watching wallet: ' + label)
    .setDescription(
      'Added by **' + interaction.user.username + '**\n' +
      '`' + address + '`\n\n' +
      'You\'ll be pinged when this wallet buys or sells something.'
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handleWalletRemove(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const address = interaction.options.getString('address').trim();
  const db = ensureDBSchema(loadDB());

  if (!db.wallets[address]) {
    return interaction.editReply('❌ Not watching that wallet.');
  }

  const label = db.wallets[address].label;
  delete db.wallets[address];
  saveDB(db);
  return interaction.editReply('✅ Stopped watching **' + label + '**');
}

async function handleWalletList(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const db = ensureDBSchema(loadDB());
  const wallets = Object.values(db.wallets || {});

  if (wallets.length === 0) {
    return interaction.editReply('📭 No wallets being watched. Use `/wallet add <address>` to add one.');
  }

  const lines = wallets.map((w, i) =>
    (i + 1) + '. **' + w.label + '**\n   `' + w.address + '`\n   Added by ' + w.addedBy + ' · ' + fmtTime(w.addedAt)
  );

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle('👛 Watched Wallets')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: wallets.length + ' wallet' + (wallets.length !== 1 ? 's' : '') + ' being watched' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'calls') return handleCalls(interaction);
    if (interaction.commandName === 'remove') return handleRemove(interaction);
    if (interaction.commandName === 'pelpafkedup') return handlePelpaFkedup(interaction);
    if (interaction.commandName === 'rank') return handleRank(interaction);
    if (interaction.commandName === 'leaderboard') return handleLeaderboard(interaction);
    if (interaction.commandName === 'ape') return handleApe(interaction);
    if (interaction.commandName === 'mybags') return handleMybags(interaction);
    if (interaction.commandName === 'follow') return handleFollow(interaction);
    if (interaction.commandName === 'unfollow') return handleUnfollow(interaction);
    if (interaction.commandName === 'watch') return handleWatch(interaction);
    if (interaction.commandName === 'unwatch') return handleUnwatch(interaction);
    if (interaction.commandName === 'tag') return handleTag(interaction);
    if (interaction.commandName === 'audit') return handleAudit(interaction);
    if (interaction.commandName === 'fibtrack') return handleFibtrack(interaction, client);
    if (interaction.commandName === 'x') {
      return handleX(interaction, { loadDB, ensureDBSchema });
    }
    if (interaction.commandName === 'rug') return handleRug(interaction);
    if (interaction.commandName === 'rugdeep') return handleRug(interaction, 'deep');
    if (interaction.commandName === 'devrandom') return handleDevsRandom(interaction);
    if (interaction.commandName === 'devs') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'random') return handleDevsRandom(interaction);
    }
    if (interaction.commandName === 'wallet') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') return handleWalletAdd(interaction);
      if (sub === 'remove') return handleWalletRemove(interaction);
      if (sub === 'list') return handleWalletList(interaction);
    }
  } catch (e) {
    console.error('[interaction] error:', e);
    const msg = { content: 'Error: ' + e.message, ephemeral: true };
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => null);
    else interaction.reply(msg).catch(() => null);
  }
});

client.once('ready', async () => {
  if (bootWaitTimer) clearInterval(bootWaitTimer);
  console.log('Bot online as ' + client.user.tag);
  console.log('Data directory: ' + DATA_DIR);
  void registerCommands();
  await postStartupBanner(client);
  try {
    initAlertGate();
  } catch (e) {
    console.error('[boot] initAlertGate failed:', e.message);
  }
  try {
    await runMintCaseRepair();
  } catch (e) {
    console.error('[boot] mint-case repair failed (non-fatal):', e.message);
  }
  try {
    if (fs.existsSync(DB_PATH)) {
      printInspectReport(inspectTrackedJson(DB_PATH));
    } else {
      console.log('[inspect] no tracked.json yet at ' + DB_PATH);
    }
  } catch (e) {
    console.error('[inspect] boot report failed:', e.message);
  }
  void runTokenPollLoop(client);
  startFibWatchLoop(client);
  startHttpServer(client, () => ensureDBSchema(loadDB()));
});

const LOGIN_TIMEOUT_MS = 45_000;
let bootWaitTimer = null;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms),
    ),
  ]);
}

(async () => {
  if (!process.env.DISCORD_TOKEN) {
    console.error('[boot] DISCORD_TOKEN missing — cannot connect');
    process.exit(1);
  }

  console.log('[boot] connecting to Discord...');
  runVolumeBackup();
  bootWaitTimer = setInterval(() => {
    console.log('[boot] still waiting for Discord gateway...');
  }, 10_000);

  try {
    await withTimeout(client.login(process.env.DISCORD_TOKEN), LOGIN_TIMEOUT_MS, 'Discord login');
  } catch (e) {
    if (bootWaitTimer) clearInterval(bootWaitTimer);
    console.error('[boot] login failed:', e.message);
    process.exit(1);
  }
})();
