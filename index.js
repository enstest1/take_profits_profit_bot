import 'dotenv/config';
import fs from 'fs';
import path from 'path';
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const DATA_DIR = fs.existsSync('/data') ? '/data' : ROOT_DIR;
const DB_PATH = path.join(DATA_DIR, 'tracked.json');
const WATCHLIST_PATH = path.join(ROOT_DIR, 'watchlist.json');
const RUG_CACHE_TTL_MS = 60 * 1000;
const rugCache = {};

console.log('[boot] Using data dir: ' + DATA_DIR);

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { tokens: {}, watchlist: {}, wallets: {} }; }
}

function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('[DB] saveDB failed:', e.message); }
}

function ensureDBSchema(db) {
  if (!db.tokens) db.tokens = {};
  if (!db.watchlist) db.watchlist = {};
  if (!db.wallets) db.wallets = {};
  return db;
}

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

function extractAddresses(text) {
  const found = new Set();
  const evmMatches = text.match(/\b0x[a-fA-F0-9]{40}\b/g) || [];
  for (const addr of evmMatches) found.add(addr.toLowerCase());
  const solanaMatches = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [];
  for (const addr of solanaMatches) {
    if (/\d/.test(addr) && !/[0OIl]/.test(addr)) found.add(addr);
  }
  return Array.from(found);
}

async function fetchDexScreener(address) {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + address, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs && data.pairs[0];
    if (!pair) return null;
    return {
      platform: 'dexscreener',
      name: pair.baseToken && pair.baseToken.name,
      symbol: pair.baseToken && pair.baseToken.symbol,
      price: pair.priceUsd || null,
      marketCap: pair.marketCap || null,
      volume24h: (pair.volume && pair.volume.h24) || 0,
      liquidity: (pair.liquidity && pair.liquidity.usd) || 0,
      buys24h: (pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0,
      sells24h: (pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0,
      dexUrl: pair.url || 'https://dexscreener.com/solana/' + address,
      imageUrl: (pair.info && pair.info.imageUrl) || null,
      pairCreatedAt: pair.pairCreatedAt || null,
    };
  } catch (e) {
    console.error('[dex] failed for ' + address + ':', e.message);
    return null;
  }
}

async function fetchPumpFun(address) {
  try {
    const res = await fetch('https://frontend-api.pump.fun/coins/' + address, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.mint || !d.name) return null;
    return d;
  } catch (e) {
    console.error('[pumpfun] failed for ' + address + ':', e.message);
    return null;
  }
}

async function fetchSolPrice() {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(6000) }
    );
    const data = await res.json();
    return (data && data.solana && data.solana.usd) || null;
  } catch {
    return null;
  }
}

function calcPumpFunPrice(pump, solPrice) {
  try {
    const solRes = Number(pump.virtual_sol_reserves);
    const tokRes = Number(pump.virtual_token_reserves);
    if (!tokRes) return null;
    return (solRes / 1e9) / (tokRes / 1e6) * solPrice;
  } catch {
    return null;
  }
}

async function fetchTokenData(address) {
  const dex = await fetchDexScreener(address);
  if (dex && dex.name) return dex;

  const pump = await fetchPumpFun(address);
  if (pump) {
    const solPrice = await fetchSolPrice();
    const pumpPrice = solPrice ? calcPumpFunPrice(pump, solPrice) : null;
    return {
      platform: 'pumpfun',
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

async function fetchRugCheckReport(mint) {
  try {
    const headers = {};
    if (process.env.RUGCHECK_API_KEY) {
      headers.Authorization = 'Bearer ' + process.env.RUGCHECK_API_KEY;
    }
    const res = await fetch('https://api.rugcheck.xyz/v1/tokens/' + mint + '/report', {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function moralisHeaders() {
  if (!process.env.MORALIS_API_KEY) return null;
  return { Authorization: 'Bearer ' + process.env.MORALIS_API_KEY };
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
  if (!headers) return null;
  try {
    const res = await fetch(
      'https://solana-gateway.moralis.io/account/mainnet/' + wallet + '/swaps?limit=' + limit + '&order=' + order,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const j = await res.json();
    return j?.result || [];
  } catch {
    return null;
  }
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

async function autoTrack(address, message) {
  const db = ensureDBSchema(loadDB());

  if (db.tokens[address]) {
    const existing = db.tokens[address];
    if (existing.alertChannelId !== message.channelId) {
      await message.channel.send({
        embeds: [{
          color: 0xffaa00,
          description: '👀 Already tracking **' + existing.name + ' (' + existing.symbol + ')** — first posted by **' + existing.postedBy + '** ' + fmtTime(existing.postedAt) + ' in <#' + existing.alertChannelId + '>',
          footer: { text: 'SOLANA' }
        }]
      });
    }
    return;
  }

  const token = await fetchTokenData(address);
  if (!token) {
    console.log('[skip] ' + address.slice(0, 8) + '... — not found');
    return;
  }

  const ageStr = getTokenAgeFlag(token.pairCreatedAt);
  const posterLine = ageStr
    ? 'Posted by **' + message.author.username + '** · ' + ageStr
    : 'Posted by **' + message.author.username + '**';

  const descParts = [
    posterLine,
    'MCap: **' + fmtUsd(token.marketCap) + '**',
  ];

  if (token.platform === 'pumpfun' && !token.complete) {
    descParts.push('⏳ Bonding curve: **' + (token.bondingProgress ? token.bondingProgress.toFixed(0) : 0) + '%** to Raydium');
  }

  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setAuthor({ name: '📡 Auto-tracking: ' + token.name + ' (' + token.symbol + ')' })
    .setDescription(descParts.join('\n'))
    .setFooter({ text: 'SOLANA' })
    .setTimestamp();

  if (token.imageUrl) embed.setThumbnail(token.imageUrl);

  await message.channel.send({ embeds: [embed] });

  const totalTxns = (token.buys24h || 0) + (token.sells24h || 0);
  let buyPressurePct = null;
  if (totalTxns > 0) buyPressurePct = Math.round((token.buys24h / totalTxns) * 100);

  db.tokens[address] = {
    address,
    name: token.name,
    symbol: token.symbol,
    chain: 'solana',
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
    milestonesFired: [],
    takeProfitFired: false,
    gainAlertFired: false,
    bondingProgress: token.bondingProgress || 0,
    graduationAlertFired: false,
    bondingAlertFired: false,
    tokenAge: ageStr || 'unknown',
    dexUrl: token.dexUrl,
    imageUrl: token.imageUrl || null,
    devWallet: token.creator || null,
    devHoldingAtCall: 0,
    devLastKnownHolding: 0,
    devDumpAlertFired: false,
    buyPressure: buyPressurePct || 0,
    sellPressure: buyPressurePct !== null ? 100 - buyPressurePct : 0,
  };

  saveDB(db);
  console.log('[tracked] ' + token.name + ' (' + token.symbol + ') — posted by ' + message.author.username);
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  const addresses = extractAddresses(message.content);
  if (addresses.length === 0) return;
  console.log('[detect] Found ' + addresses.length + ' address(es) from ' + message.author.username);
  for (const address of addresses) {
    await autoTrack(address, message).catch(e =>
      console.error('[autotrack] Error for ' + address + ':', e.message)
    );
  }
});

const commands = [
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
    .setName('x')
    .setDescription('Check X account profile, history and rug signals')
    .addStringOption(opt =>
      opt.setName('handle').setDescription('X handle (with or without @)').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('rug')
    .setDescription('Run RugCheck + bundle risk scan for a Solana token')
    .addStringOption(opt =>
      opt.setName('mint').setDescription('Solana token mint address').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Scan depth')
        .setRequired(false)
        .addChoices(
          { name: 'quick (5-15s)', value: 'quick' },
          { name: 'deep (30-90s)', value: 'deep' }
        )
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

async function handleCalls(interaction) {
  await interaction.deferReply();
  const db = ensureDBSchema(loadDB());
  const entries = Object.values(db.tokens || {});
  if (entries.length === 0) {
    return interaction.editReply('Nothing tracked yet — drop a contract address in chat.');
  }
  const liveData = await Promise.allSettled(
    entries.map(e => fetchTokenData(e.address).catch(() => null))
  );
  const lines = entries.map((entry, i) => {
    const live = liveData[i].status === 'fulfilled' ? liveData[i].value : null;
    const livePrice = live && live.price ? Number(live.price) : null;
    const priceAtCall = entry.priceAtCall ? Number(entry.priceAtCall) : null;
    let multipleStr = '—';
    if (livePrice && priceAtCall && priceAtCall > 0) {
      const mult = livePrice / priceAtCall;
      multipleStr = mult >= 2 ? '🚀 **' + mult.toFixed(2) + 'x**' : mult >= 1 ? '📈 ' + mult.toFixed(2) + 'x' : '📉 ' + mult.toFixed(2) + 'x';
    }
    return '**' + entry.name + ' (' + entry.symbol + ')** — ' + multipleStr + '\n' +
           '└ **' + entry.postedBy + '** · ' + fmtTime(entry.postedAt) + ' · MCap: ' + fmtUsd(live ? live.marketCap : null);
  });
  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle('Tracked Tokens')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: entries.length + ' token' + (entries.length !== 1 ? 's' : '') + ' being watched' })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction) {
  const address = interaction.options.getString('address').trim();
  const db = ensureDBSchema(loadDB());
  if (!db.tokens[address]) {
    return interaction.reply({ content: 'Not tracking ' + address, ephemeral: true });
  }
  const name = db.tokens[address].name;
  const symbol = db.tokens[address].symbol;
  delete db.tokens[address];
  saveDB(db);
  await interaction.reply('Stopped tracking **' + name + ' (' + symbol + ')**');
}

// /x handler — Twttr API (RapidAPI) for profile data + memory.lol for name changes
async function handleX(interaction) {
  await interaction.deferReply();
  const raw = interaction.options.getString('handle').trim();
  const handle = raw.startsWith('@') ? raw.slice(1) : raw;
  const SOL_CA_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

  // Fetch profile + memory first (tweets endpoint needs numeric user id / rest_id)
  const [twttrResult, memoryResult] = await Promise.allSettled([
    // Twttr API — profile info
    (async () => {
      if (!process.env.RAPIDAPI_KEY) return null;
      try {
        const res = await fetch(
          'https://twitter241.p.rapidapi.com/user?username=' + encodeURIComponent(handle),
          {
            headers: {
              'x-rapidapi-key': process.env.RAPIDAPI_KEY,
              'x-rapidapi-host': 'twitter241.p.rapidapi.com'
            },
            signal: AbortSignal.timeout(10000)
          }
        );
        if (!res.ok) {
          return null;
        }
        return res.json();
      } catch (e) {
        return null;
      }
    })(),
    // memory.lol — name change history
    (async () => {
      const res = await fetch(
        'https://api.memory.lol/v1/tw/' + encodeURIComponent(handle),
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return null;
      return res.json();
    })()
  ]);

  const twttr = twttrResult.status === 'fulfilled' ? twttrResult.value : null;
  const memory = memoryResult.status === 'fulfilled' ? memoryResult.value : null;

  // If both failed
  if (!twttr && !memory) {
    return interaction.editReply('❌ Could not fetch data for **@' + handle + '** — try again.');
  }

  // Parse Twttr API profile data
  let profileLines = [];
  let profilePic = null;
  let suspicious = false;

  // Live twitter241 structure:
  // twttr.result.data.user.result.legacy + twttr.result.data.user.result.is_blue_verified
  const userResult =
    twttr?.result?.data?.user?.result ||
    twttr?.result ||
    twttr?.user?.result ||
    null;
  const core = userResult?.legacy || null;
  const userCore = userResult?.core || null;
  const isBlueVerified = userResult?.is_blue_verified || false;
  const profileUserId = userResult?.rest_id || userResult?.legacy?.id_str || null;
  if (core) {
      const followers = core.followers_count || 0;
      const following = core.friends_count || 0;
      const tweets = core.statuses_count || 0;
      const createdAtRaw = core.created_at || userCore?.created_at || null;
      const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
      const accountAgeDays = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null;
      const ageStr = accountAgeDays !== null
        ? accountAgeDays > 365
          ? Math.floor(accountAgeDays / 365) + 'y ' + Math.floor((accountAgeDays % 365) / 30) + 'm old'
          : accountAgeDays + 'd old'
        : '—';

      profilePic = core.profile_image_url_https || userResult?.avatar?.image_url || null;

      // Suspicious signals
      const ffRatio = following > 0 ? (followers / following).toFixed(2) : null;
      const isNew = accountAgeDays !== null && accountAgeDays < 30;
      const isLowFollowers = followers < 100;
      if (isNew || isLowFollowers) suspicious = true;

      profileLines = [
        '📅 **' + ageStr + '**' + (isNew ? ' ⚠️ Very new account' : ''),
        '👥 **' + followers.toLocaleString() + '** followers · **' + following.toLocaleString() + '** following' + (ffRatio ? ' · ratio: ' + ffRatio : ''),
        '🐦 **' + tweets.toLocaleString() + '** tweets',
      ];

      // Verified status
      if (core.verified || isBlueVerified) {
        profileLines.push('✅ Verified');
      }
  }

  // Twttr API — last ~200 tweets for CA graveyard (requires numeric user id)
  let tweetsData = null;
  if (process.env.RAPIDAPI_KEY && profileUserId) {
    try {
      const headers = {
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        'x-rapidapi-host': 'twitter241.p.rapidapi.com'
      };
      const candidates = [
        'https://twitter241.p.rapidapi.com/user-tweets?user=' + encodeURIComponent(profileUserId) + '&count=200',
        'https://twitter241.p.rapidapi.com/user-tweets?user=' + encodeURIComponent(profileUserId)
      ];
      for (const url of candidates) {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
        if (res.ok) {
          tweetsData = await res.json();
          break;
        }
      }
    } catch (_) {
      tweetsData = null;
    }
  }

  // Parse memory.lol name changes
  let nameLines = [];
  let nameChangeCount = 0;

  if (memory && memory.accounts) {
    const accountData = Object.values(memory.accounts)[0];
    if (accountData) {
      const historical = Object.keys(accountData)
        .filter(n => n.toLowerCase() !== handle.toLowerCase());
      nameChangeCount = historical.length;
      if (historical.length > 0) {
        nameLines = historical.map(n => {
          const dates = accountData[n];
          const firstSeen = dates && dates[0] ? dates[0] : 'unknown';
          return '**@' + n + '** · ' + firstSeen;
        });
        if (historical.length >= 2) suspicious = true;
      }
    }
  }

  // CA Graveyard — extract Solana addresses from tweets, check pump.fun
  let graveyardLine = null;
  if (tweetsData) {
    try {
      // Recursively gather tweet text fields from API payload.
      const tweetTexts = [];
      const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (typeof node !== 'object') return;

        if (typeof node.full_text === 'string') tweetTexts.push(node.full_text);
        if (typeof node.text === 'string') tweetTexts.push(node.text);
        if (node.note_tweet?.note_tweet_results?.result?.text) {
          tweetTexts.push(node.note_tweet.note_tweet_results.result.text);
        }

        for (const value of Object.values(node)) walk(value);
      };
      walk(tweetsData);

      // Parse CAs from tweet text only (avoid random JSON field matches).
      const solanaMatches = [...new Set(
        tweetTexts
          .flatMap((t) => t.match(SOL_CA_REGEX) || [])
          .filter((a) => /\d/.test(a))
      )];

      if (solanaMatches.length > 0) {
        // Check each CA on pump.fun (cap requests to keep slash response fast).
        const toCheck = solanaMatches.slice(0, 60);
        const results = await Promise.allSettled(
          toCheck.map(async (addr) => {
            const r = await fetch('https://frontend-api.pump.fun/coins/' + addr, {
              signal: AbortSignal.timeout(4000)
            });
            if (!r.ok) return { addr, alive: false };
            const d = await r.json();
            return { addr, alive: !!(d && d.mint && d.name) };
          })
        );

        const checked = results
          .filter(r => r.status === 'fulfilled')
          .map(r => r.value);
        const alive = checked.filter(r => r.alive).length;
        const dead = checked.filter(r => !r.alive).length;
        const total = alive + dead;

        if (total > 0) {
          const deadPct = Math.round((dead / total) * 100);
          const rugSignal = deadPct >= 70 ? ' ⚠️ High rug association' : deadPct >= 40 ? ' 🟡 Mixed history' : ' ✅ Mostly clean';
          graveyardLine = '🔍 **CA Graveyard** (last ~200 tweets)\n' +
            '🟢 ' + alive + ' alive · 🔴 ' + dead + ' dead of ' + total + ' posted\n' +
            deadPct + '% dead rate —' + rugSignal;
          if (deadPct >= 70) suspicious = true;
        }
      }
    } catch (e) {
      // Do not fail command on graveyard subcheck.
    }
  }

  // Build embed
  const color = suspicious
    ? (nameChangeCount >= 3 ? 0xff3333 : 0xffaa00)
    : 0x00ff88;

  const descParts = [];

  if (profileLines.length > 0) {
    descParts.push(profileLines.join('\n'));
  }

  if (nameChangeCount > 0) {
    descParts.push(
      '\n🔄 **' + nameChangeCount + ' name change' + (nameChangeCount !== 1 ? 's' : '') + ' detected**\n' +
      nameLines.join('\n') +
      '\nCurrent: **@' + handle + '**'
    );
    if (nameChangeCount >= 2) {
      descParts.push('\n⚠️ **Multiple rebrands — common pattern in serial ruggers**');
    }
  } else if (memory) {
    descParts.push('\n✅ No name changes detected');
  }

  if (graveyardLine) {
    descParts.push('\n' + graveyardLine);
  }

  if (descParts.length === 0) {
    descParts.push('No data available for this account.');
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🐦 X Profile — @' + handle)
    .setDescription(descParts.join('\n').slice(0, 4000))
    .setFooter({ text: 'Twttr API + memory.lol' })
    .setTimestamp();

  if (profilePic) embed.setThumbnail(profilePic);

  return interaction.editReply({ embeds: [embed] });
}

async function handleRug(interaction) {
  await interaction.deferReply();
  const mode = interaction.options.getString('mode') || 'quick';
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

  if (!tokenData?.pump && !tokenData?.dex) {
    return interaction.editReply('❌ Token not found on pump.fun or DexScreener.');
  }

  const name = tokenData?.token?.name || riskData?.rug?.tokenMeta?.name || mint.slice(0, 8) + '...';
  const symbol = tokenData?.token?.symbol || riskData?.rug?.tokenMeta?.symbol || 'SOL';

  const lines = [];
  let high = false;
  let med = false;

  lines.push('━━━ **TOKEN RISK** ━━━');
  if (riskData) {
    const score = Number(riskData.norm || 0);
    const levelEmoji = riskData.level === 'High' ? '🔴' : riskData.level === 'Medium' ? '🟠' : '🟢';
    lines.push('Score: **' + score + '/100** ' + levelEmoji + ' ' + riskData.level + ' Risk');
    lines.push('Mint auth: ' + (riskData.mintAuthEnabled ? '⚠️ Enabled' : '✅ Revoked') +
      ' · Freeze auth: ' + (riskData.freezeAuthEnabled ? '⚠️ Enabled' : '✅ Revoked'));
    lines.push('LP locked: ' + (riskData.lpLockedPct > 0 ? '✅ Yes (' + riskData.lpLockedPct.toFixed(0) + '%)' : '❌ No'));
    lines.push('Top 10 holders: **' + riskData.top10Pct.toFixed(1) + '%**' + (riskData.top10Pct >= 60 ? ' ⚠️' : ''));
    lines.push('Risks: ' + (riskData.risks.length ? riskData.risks.slice(0, 4).join(', ') : 'None'));
    if (riskData.level === 'High') high = true;
    else if (riskData.level === 'Medium') med = true;
  } else {
    lines.push('⚠️ Token risk data unavailable');
  }

  lines.push('');
  lines.push('━━━ **BUNDLE RISK** ━━━');
  if (bundleData) {
    lines.push('Top funded cluster: **' + bundleData.clusterSize + ' / ' + bundleData.earlyCount + '** early buyers');
    lines.push('Cluster buy-flow: **' + bundleData.clusterFlowPct.toFixed(1) + '%**');
    lines.push('Time-to-bundle: **' + (bundleData.timeToBundleSec === null ? '—' : bundleData.timeToBundleSec + 's') + '**');
    lines.push('Synchronized exits: **' + bundleData.synchronizedExits + '** windows');
    lines.push('Sample: **' + bundleData.sampleBuys + '** buys');
    const confEmoji = bundleData.confidence === 'High' ? '🔴' : bundleData.confidence === 'Medium' ? '🟠' : '🟢';
    lines.push('Bundle confidence: **' + bundleData.confidence.toUpperCase() + '** ' + confEmoji);
    if (bundleData.confidence === 'High') high = true;
    else if (bundleData.confidence === 'Medium') med = true;
  } else {
    lines.push('⚠️ Bundle data unavailable');
  }
  if (deepData?.bundle) {
    lines.push('Deep fresh-wallet ratio: **' + deepData.bundle.freshRatio.toFixed(0) + '%**');
    lines.push('Deep cross-token reuse: **' + deepData.bundle.reusedWallets + ' / ' + deepData.bundle.earlyCount + '**');
    lines.push('Deep entry bursts: **' + deepData.bundle.entryBursts + '**');
  } else if (isDeep) {
    lines.push('⚠️ Deep bundle forensics unavailable');
  }
  lines.push('*Probabilistic signals — not guaranteed*');

  lines.push('');
  lines.push('━━━ **DEV HISTORY** ━━━');
  if (devData) {
    lines.push('Past launches: **' + devData.pastLaunches + '**');
    lines.push('Rug rate: **' + devData.ruggedCount + ' / ' + devData.sampled + '**' +
      (devData.rugRate >= 50 ? ' 🔴' : devData.rugRate >= 25 ? ' 🟠' : ' 🟢'));
    lines.push('Repeat pattern: **' + devData.repeatPattern + '**' + (devData.repeatPattern === 'YES' ? ' ⚠️' : ''));
    lines.push('Watchlist: ' + (devData.watchlistHit ? '⚠️ FLAGGED' : '✅ Clean'));
    if (devData.mcapList.length) {
      lines.push('Current MCAPs (top past): ' + devData.mcapList
        .map((x) => (x.rugged ? '🔴' : '🟢') + ' ' + x.mint.slice(0, 6) + '… ' + fmtUsd(x.mcap))
        .join(' · '));
    }
    if (devData.rugRate >= 50) high = true;
    else if (devData.rugRate >= 25) med = true;
  } else {
    lines.push('⚠️ Dev history unavailable');
  }
  if (deepData?.dev) {
    lines.push('Deep sampled launches: **' + deepData.dev.sampled + '**');
    lines.push('Deep rug rate: **' + deepData.dev.ruggedCount + ' / ' + deepData.dev.sampled + '**');
    lines.push('Deep median time-to-death: **' + (deepData.dev.medianTimeToDeathDays === null ? '—' : deepData.dev.medianTimeToDeathDays.toFixed(1) + 'd') + '**');
  } else if (isDeep) {
    lines.push('⚠️ Deep dev forensics unavailable');
  }
  lines.push('*Probabilistic signals — not guaranteed*');

  lines.push('');
  lines.push('━━━ **VERDICT** ━━━');
  const verdict = high ? '🔴 HIGH RISK' : med ? '🟠 MIXED RISK' : '🟢 LOW RISK';
  lines.push(verdict + ' — review all sections before trading');

  const color = high ? 0xff3b30 : med ? 0xffa500 : 0x00c853;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🔍 Rug Check — ' + name + ' (' + symbol + ')' + (isDeep ? ' [DEEP]' : ''))
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
    if (interaction.commandName === 'x') return handleX(interaction);
    if (interaction.commandName === 'rug') return handleRug(interaction);
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

client.once('ready', () => {
  console.log('Bot online as ' + client.user.tag);
  console.log('Data directory: ' + DATA_DIR);
  pollTokens(client);
  setInterval(() => pollTokens(client), 3 * 60 * 1000);
});

(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
