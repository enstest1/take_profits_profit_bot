import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EmbedBuilder } from 'discord.js';
import {
  shouldSilenceAlerts,
  getAlertSilenceStatus,
  tickComebackAfterPollCycle,
} from './alertGate.js';
import { fetchDexPair, fetchDexPairOnChain } from './dexPair.js';
import { chainLabel, isBrokenSolKey, parseStorageKey, isLegacyEvmKey, enabledChains, chainBadge } from './chains.js';
import { batchFetch, batchFetchSolana } from './dexBatch.js';
import { rateLimiter } from './rateLimiter.js';
import { recordCycle, markSummaryPosted } from './cycleStats.js';
import { fetchPumpFun, fetchSolPrice, calcPumpFunPrice } from './pumpfunApi.js';
import { rebuildCallerStats, updateCallerStatsForUser } from './callerStats.js';
import { deriveLifecycle, lifecyclePrefix } from './signals/lifecycle.js';
import { currentMultipleFromLive } from './signals/mult.js';
import { evaluateVelocity } from './signals/velocity.js';
import { evaluateLiquidityDivergence } from './signals/liquidity.js';
import { evaluateRetest, maybeResetRetestOnAth } from './signals/retest.js';
import { evaluatePersonalPositions } from './positions.js';
import { sendChannelAlert, sendTokenAlert } from './channelAlert.js';
import { indexXAccount } from './xSocial.js';
import { checkWeeklyRecap } from './recap.js';
import { CFG } from './signals/config.js';
import {
  loadDB,
  saveDB,
  ensureDBSchema,
  setActivePollTrackedKeys,
  clearActivePollTrackedKeys,
  clearRemovedThisCycle,
} from './dbStore.js';

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.dirname(fileURLToPath(import.meta.url));
/** One-time per volume: first poll after deploy only newest 5 mints may emit 🎯1x; all others skip 🎯 this cycle (avoids flood). Delete file to repeat. */
const MILESTONE_BOOTSTRAP_FILE = path.join(DATA_DIR, '.tp_milestone_bootstrap_v2');
const HOT_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WARM_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WARM_TIER_EVERY_N_CYCLES = 2;
const COLD_TIER_EVERY_N_CYCLES = 5;
/** Max concurrent DexScreener requests during a poll cycle. */
const POLL_CONCURRENCY = 6;
/** Pause between starting each token fetch (ms) — reduces 429 rate limits. */
const POLL_STAGGER_MS = 150;
/** No significant ATH in this window → poll tier cold (token must be older than this too). */
const INACTIVE_DEMOTE_MS = 72 * 60 * 60 * 1000;
const NEW_TOKEN_GRACE_MS = 72 * 60 * 60 * 1000;
/** Trench reset: below call price (with wick buffer) for N polls → milestones clear, ladder can fire again on recovery. */
const MILESTONE_RESET_MULT = 0.99;
const MILESTONE_RESET_STREAK = 3;
/** Min time between resets on the same token (stops chop/wick re-alert loops). */
const MILESTONE_RESET_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** New peak must exceed prior peakMultiple by this fraction to refresh peakAt. */
const MIN_NEW_ATH_BUMP_RATIO = 0.01;
const ARCHIVE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SILENT_CATCHUP_STALE_MS = 10 * 60 * 1000;
const CALLS_STALE_MS = 15 * 60 * 1000;

const SUMMARY_CHANNEL_ID = process.env.SUMMARY_CHANNEL_ID || '1452152164699869298';

let lastArchiveDate = null;

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

function fmtAgeLabel(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  const mi = Math.floor(diff / 60000);
  const h = Math.floor(mi / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d === 1 ? '1 day' : d + ' days';
  if (h > 0) return h === 1 ? '1 hour' : h + ' hours';
  if (mi > 0) return mi === 1 ? '1 minute' : mi + ' minutes';
  return 'just now';
}

function luteTradeUrl(mint) {
  return 'https://lute.gg/trade/' + mint;
}

function trenchTradeUrl(mint) {
  // Path /trade/<mint> 404s; app uses ?mint= on monitor (see trench.com redirects).
  return 'https://trench.com/trade/monitor?mint=' + encodeURIComponent(mint);
}

function takeProfitDescription(mint, postedBy, postedAt) {
  return (
    '💰💰💰 **Take Profit** 💰💰💰\n' +
    '`' +
    mint +
    '`\n' +
    '**' +
    postedBy +
    '** - ' +
    fmtAgeLabel(postedAt) +
    '\n' +
    '[Lute](' +
    luteTradeUrl(mint) +
    ') · [Trench](' +
    trenchTradeUrl(mint) +
    ')'
  );
}

function tokenThumbnail(entry, live) {
  if (entry && entry.imageUrl) return entry.imageUrl;
  if (live && live.rawPump && live.rawPump.image_uri) return live.rawPump.image_uri;
  if (live && live.imageUrl) return live.imageUrl;
  return null;
}

/** Normalize legacy milestonesFired (stored price gates 2,5,10,20) to tier ids 1–20. */
function normalizeTakeProfitTiers(fired) {
  if (!Array.isArray(fired) || fired.length === 0) return [];
  const legacySparse = new Set([2, 5, 10, 20]);
  if (fired.includes(1) || fired.some((x) => x > 20)) {
    return [...new Set(fired.filter((x) => x >= 1 && x <= 20))].sort((a, b) => a - b);
  }
  if (fired.every((x) => legacySparse.has(x))) {
    return [...new Set(fired.map((x) => x - 1))].filter((t) => t >= 1 && t <= 20).sort((a, b) => a - b);
  }
  if (fired.every((x) => x >= 1 && x <= 20)) {
    return [...new Set(fired)].sort((a, b) => a - b);
  }
  return [...new Set(fired.map((x) => (x >= 2 ? x - 1 : x)))]
    .filter((t) => t >= 1 && t <= 20)
    .sort((a, b) => a - b);
}

const pollingLock = new Set();
let lastSummaryDate = null;
let lastCallerRebuildDate = null;
/** Prevents overlapping poll cycles (setInterval does not await async work). */
let pollCycleInProgress = false;
let pollCycleNumber = 0;

function stableAddrHash(address) {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash * 31 + address.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function entryAgeMs(entry) {
  const postedAt = Number(entry?.postedAt) || 0;
  return postedAt > 0 ? Date.now() - postedAt : Number.MAX_SAFE_INTEGER;
}

function ensurePeakAt(entry) {
  if (entry.peakAt != null && entry.peakAt !== '') return Number(entry.peakAt);
  return Number(entry.postedAt) || Date.now();
}

function isSignificantNewAth(storedPeak, currentMultiple) {
  const peak = Number(storedPeak) || 1;
  if (currentMultiple <= peak) return false;
  if (peak <= 1) return currentMultiple > 1;
  return currentMultiple >= peak * (1 + MIN_NEW_ATH_BUMP_RATIO);
}

/** True when token is past grace period and peakAt is stale — demote to cold polling. */
function isInactiveForPolling(entry) {
  const ageMs = entryAgeMs(entry);
  if (ageMs <= NEW_TOKEN_GRACE_MS) return false;
  const peakAt = ensurePeakAt(entry);
  return Date.now() - peakAt > INACTIVE_DEMOTE_MS;
}

function pollTierForEntry(entry) {
  const ageMs = entryAgeMs(entry);
  const milestones = Array.isArray(entry?.milestonesFired) ? entry.milestonesFired.length : 0;

  // Fresh calls (<24h): every cycle
  if (ageMs <= HOT_TOKEN_MAX_AGE_MS) return 'hot';

  if (isInactiveForPolling(entry)) return 'cold';

  // Runners that already hit milestones stay on the radar
  if (milestones > 0) {
    if (ageMs <= WARM_TOKEN_MAX_AGE_MS) return 'hot';
    const peakMultiple = Number(entry?.peakMultiple) || 1;
    if (peakMultiple >= 1.5) return 'warm';
    return 'warm';
  }

  // Old tokens that never hit a milestone — cold (was hot for all ~1700 dead tokens)
  return 'cold';
}

function shouldPollAddressThisCycle(address, entry, cycleNum) {
  const tier = pollTierForEntry(entry);
  if (tier === 'hot') return true;
  const cadence = tier === 'warm' ? WARM_TIER_EVERY_N_CYCLES : COLD_TIER_EVERY_N_CYCLES;
  return stableAddrHash(address) % cadence === cycleNum % cadence;
}

// Fetch live price — DexScreener (Solana); pump.fun fallback for bonding curve
async function fetchLiveData(address, entry, solPriceUsd) {
  const chain = (entry?.chain || 'solana').toLowerCase();
  if (chain !== 'solana') return null;

  let dex = await fetchDexPairOnChain('solana', address, { retries: 2, timeoutMs: 10_000 });
  if (!dex?.price) {
    dex = await fetchDexPair(address, {
      enabledChains: ['solana'],
      chainHint: 'solana',
      retries: 2,
      timeoutMs: 12_000,
    });
  }
  if (dex?.price) return dex;

  if (solPriceUsd && entry?.platform === 'pumpfun') {
    const pump = await fetchPumpFun(address);
    if (pump) {
      const price = calcPumpFunPrice(pump, solPriceUsd);
      return {
        price,
        marketCap: pump.usd_market_cap || null,
        volume24h: null,
        liquidity: null,
        priceChange1h: null,
        buyPct: null,
        bondingProgress: pump.bonding_curve_progress || 0,
        complete: pump.complete || false,
        source: 'pumpfun',
        imageUrl: pump.image_uri || null,
        rawPump: pump,
      };
    }
  }

  return null;
}

async function runPollBatch(items, fn) {
  const queue = items.slice();
  async function worker() {
    while (queue.length > 0) {
      const address = queue.shift();
      if (!address) break;
      await fn(address);
      if (POLL_STAGGER_MS > 0) await new Promise((r) => setTimeout(r, POLL_STAGGER_MS));
    }
  }
  await Promise.all(Array.from({ length: POLL_CONCURRENCY }, () => worker()));
}

function tierRank(entry) {
  const tier = pollTierForEntry(entry);
  if (tier === 'hot') return 0;
  if (tier === 'warm') return 1;
  return 2;
}

function archiveDeadTokens(db) {
  if (!db.archived) db.archived = {};
  let moved = 0;
  for (const [key, e] of Object.entries(db.tokens)) {
    if (isBrokenSolKey(key, e)) continue;
    const dead =
      entryAgeMs(e) > ARCHIVE_AGE_MS &&
      (Number(e.peakMultiple) || 1) < 1.2 &&
      (e.milestonesFired || []).length === 0;
    if (dead) {
      db.archived[key] = { ...e, archivedAt: Date.now() };
      delete db.tokens[key];
      moved += 1;
    }
  }
  if (moved) {
    console.log('[archive] moved ' + moved + ' dead tokens (never >1.2x, 30d+) — nothing deleted');
  }
  return moved;
}

function maybeRunDailyArchive(db) {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (lastArchiveDate === todayStr) return;
  lastArchiveDate = todayStr;
  archiveDeadTokens(db);
}

async function sendEmbed(client, channelId, embed, label = 'alert') {
  return sendChannelAlert(client, channelId, embed, label);
}

async function maybeWalletConfluence(client, db, mint, wallet, boughtMint) {
  if (!boughtMint || !db.tokens[boughtMint]) return;
  const entry = db.tokens[boughtMint];
  const age = Date.now() - (entry.postedAt || 0);
  if (age > CFG.WALLET_CONFLUENCE_MAX_AGE_MS) return;
  if (Date.now() - (entry.walletConfluenceAt || 0) < CFG.WALLET_CONFLUENCE_COOLDOWN_MS) return;

  const mult =
    entry.lastPrice && entry.priceAtCall
      ? Number(entry.lastPrice) / Number(entry.priceAtCall)
      : null;
  const afterMs = Date.now() - (entry.postedAt || 0);

  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setTitle('🐋 SMART MONEY — tracked wallet aped ' + entry.symbol)
    .setDescription(
      'Wallet: ' + wallet.label + ' (watched) · ' + fmtAgeLabel(afterMs) + " after @" +
      entry.postedBy + "'s call · token at " + (mult != null ? mult.toFixed(1) + 'x' : '—'),
    )
    .setTimestamp();

  const sent = await sendTokenAlert(client, db, boughtMint, embed, 'walletconf', 'wallet-conf');
  if (sent) {
    entry.walletConfluenceAt = Date.now();
    saveDB(db);
    console.log('[wallet-conf] ' + wallet.label + ' → ' + entry.symbol);
  }
}

// Wallet watcher — polls Moralis for recent swaps on watched wallets
async function pollWallets(client) {
  if (!process.env.MORALIS_API_KEY) return;
  const db = ensureDBSchema(loadDB());
  const wallets = Object.values(db.wallets || {});
  if (wallets.length === 0) return;

  for (const wallet of wallets) {
    try {
      const res = await fetch(
        'https://solana-gateway.moralis.io/account/mainnet/' + wallet.address + '/swaps?limit=5&order=DESC',
        {
          headers: { 'Authorization': 'Bearer ' + process.env.MORALIS_API_KEY },
          signal: AbortSignal.timeout(8000)
        }
      );
      if (!res.ok) continue;

      const data = await res.json();
      const swaps = data.result || data.swaps || [];
      if (!swaps.length) continue;

      const latest = swaps[0];
      const txHash = latest.transactionHash || latest.transaction_hash || latest.hash;

      // Skip if already seen this tx
      if (!txHash || txHash === wallet.lastSeenTx) continue;

      // Update last seen immediately to prevent double alerts
      db.wallets[wallet.address].lastSeenTx = txHash;
      saveDB(db);

      const txType = (latest.transactionType || latest.type || '').toLowerCase();
      const isBuy = txType === 'buy';
      const isSell = txType === 'sell';
      if (!isBuy && !isSell) continue;

      const tokenOut = latest.tokenOut || latest.bought || {};
      const tokenIn = latest.tokenIn || latest.sold || {};
      const boughtMint = isBuy ? (tokenOut.mint || tokenOut.address || tokenOut.tokenAddress) : null;
      const tokenName = isBuy ? (tokenOut.name || tokenOut.symbol || 'Unknown') : (tokenIn.name || tokenIn.symbol || 'Unknown');
      const tokenSymbol = isBuy ? (tokenOut.symbol || '?') : (tokenIn.symbol || '?');
      const amountUsd = latest.totalValueUsd || latest.usdValue || null;

      const embed = new EmbedBuilder()
        .setColor(isBuy ? 0x00ff88 : 0xff3333)
        .setTitle((isBuy ? '🟢 Smart Wallet Buy' : '🔴 Smart Wallet Sell') + ' — ' + wallet.label)
        .setDescription(
          '**' + wallet.label + '** just ' + (isBuy ? 'bought' : 'sold') + ' **' + tokenName + ' (' + tokenSymbol + ')**' +
          (amountUsd ? '\nValue: **$' + Number(amountUsd).toLocaleString() + '**' : '') +
          '\n\nAdded by ' + wallet.addedBy
        )
        .setFooter({ text: wallet.address })
        .setTimestamp();

      try {
        const channel = await client.channels.fetch(wallet.alertChannelId);
        if (shouldSilenceAlerts()) {
          console.log('[silence] skipped wallet alert: ' + wallet.label + ' ' + (isBuy ? 'buy' : 'sell') + ' ' + tokenSymbol);
        } else {
          await channel.send({ embeds: [embed] });
          console.log('[wallet] ' + wallet.label + ' ' + (isBuy ? 'bought' : 'sold') + ' ' + tokenSymbol);
          if (isBuy && boughtMint) {
            await maybeWalletConfluence(client, db, boughtMint, wallet, boughtMint);
          }
        }
      } catch (e) {
        console.error('[wallet] send failed:', e.message);
      }

    } catch (e) {
      console.error('[wallet] poll error for ' + wallet.label + ':', e.message);
    }
  }
}

/**
 * Build daily summary title/description/footer (same text the bot posts).
 * @returns {Promise<{ title: string, description: string, footerText: string, tokenCount: number }>}
 */
export async function buildDailySummaryParts() {
  const db = ensureDBSchema(loadDB());
  const entries = Object.values(db.tokens || {});

  if (entries.length === 0) {
    return {
      title: '📊 Daily Summary',
      description: 'No tokens being tracked right now.',
      footerText: '',
      tokenCount: 0,
    };
  }

  const rows = [];
  let bestCall = null;
  let bestMultiple = 0;

  for (const entry of entries) {
    const livePrice = entry.lastPrice ? Number(entry.lastPrice) : null;
    const priceAtCall = entry.priceAtCall ? Number(entry.priceAtCall) : null;
    const stale = Date.now() - (entry.lastChecked || 0) > CALLS_STALE_MS;

    let multipleStr = '—';
    let mult = null;
    if (livePrice && priceAtCall && priceAtCall > 0) {
      mult = livePrice / priceAtCall;
      const pct = ((mult - 1) * 100).toFixed(0);
      const sign = mult >= 1 ? '+' : '';
      const staleMark = stale ? ' ⏳' : '';
      if (mult >= 2) multipleStr = '🚀 ' + mult.toFixed(2) + 'x (' + sign + pct + '%)' + staleMark;
      else if (mult >= 1) multipleStr = '📈 ' + mult.toFixed(2) + 'x (' + sign + pct + '%)' + staleMark;
      else multipleStr = '📉 ' + mult.toFixed(2) + 'x (' + pct + '%)' + staleMark;
      if (mult > bestMultiple) {
        bestMultiple = mult;
        bestCall = entry;
      }
    }

    const peakStr =
      entry.peakMultiple && entry.peakMultiple > 1
        ? ' · Peak: ' + entry.peakMultiple.toFixed(2) + 'x'
        : '';

    const line =
      lifecyclePrefix(entry) +
      '**' +
      entry.name +
      ' (' +
      entry.symbol +
      ')** — ' +
      multipleStr +
      '\n' +
      '└ **' +
      entry.postedBy +
      '** · ' +
      fmtTime(entry.postedAt) +
      ' · MCap: ' +
      fmtUsd(entry.mcapAtCall) +
      peakStr;

    if (mult !== null) rows.push({ entry, mult, line });
  }

  const TOP_GAINERS = 5;
  const TOP_LOSERS = 3;

  const byDesc = [...rows].sort((a, b) => b.mult - a.mult);
  const byAsc = [...rows].sort((a, b) => a.mult - b.mult);

  const gainerSet = new Set();
  const gainers = [];
  for (const r of byDesc) {
    if (gainers.length >= TOP_GAINERS) break;
    gainers.push(r);
    gainerSet.add(r.entry.address);
  }

  const losers = [];
  for (const r of byAsc) {
    if (losers.length >= TOP_LOSERS) break;
    if (gainerSet.has(r.entry.address)) continue;
    losers.push(r);
  }

  const sections = [];
  sections.push('**Top ' + TOP_GAINERS + ' gainers** (by multiple vs call)');
  sections.push(
    gainers.length ? gainers.map((r) => r.line).join('\n\n') : '_No price data to rank._'
  );
  sections.push('');
  sections.push('**' + TOP_LOSERS + ' biggest losers** (by multiple vs call)');
  sections.push(
    losers.length ? losers.map((r) => r.line).join('\n\n') : '_No price data to rank._'
  );

  const description = sections.join('\n').slice(0, 4000);

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  let footerStr =
    entries.length +
    ' token' +
    (entries.length !== 1 ? 's' : '') +
    ' tracked · summary: top ' +
    TOP_GAINERS +
    ' / bottom ' +
    TOP_LOSERS +
    ' · cached prices · ⏳ = >15m stale';
  if (rows.length < entries.length) {
    footerStr += ' · ' + (entries.length - rows.length) + ' w/o multiple';
  }
  if (bestCall) {
    footerStr += ' · Best overall: ' + bestCall.name + ' ' + bestMultiple.toFixed(2) + 'x';
  }

  return {
    title: '📊 Daily Summary — ' + dateStr,
    description,
    footerText: footerStr,
    tokenCount: entries.length,
  };
}

// Daily summary at 4am PST (12:00 UTC)
async function postDailySummary(client) {
  const parts = await buildDailySummaryParts();
  console.log('[summary] Posting daily summary — ' + parts.tokenCount + ' tokens');

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(parts.title)
    .setDescription(parts.description)
    .setTimestamp();

  if (parts.footerText) {
    embed.setFooter({ text: parts.footerText });
  }

  try {
    if (shouldSilenceAlerts()) {
      console.log('[silence] skipped daily summary (' + parts.tokenCount + ' tokens)');
      return;
    }
    const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
    await channel.send({ embeds: [embed] });
    markSummaryPosted();
    console.log('[summary] Posted successfully');
  } catch (e) {
    console.error('[summary] Failed to post:', e.message);
  }
}

function checkDailySummary(client, db) {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const todayStr = now.toISOString().slice(0, 10);
  if (utcHour === 12 && utcMinute < 3 && lastSummaryDate !== todayStr) {
    lastSummaryDate = todayStr;
    postDailySummary(client).catch(e => console.error('[summary] error:', e.message));
  }
  if (utcHour === 12 && utcMinute < 3 && lastCallerRebuildDate !== todayStr) {
    lastCallerRebuildDate = todayStr;
    rebuildCallerStats(db);
  }
  checkWeeklyRecap(client, db);
}

export async function pollTokens(client) {
  checkDailySummary(client, ensureDBSchema(loadDB()));

  const silence = getAlertSilenceStatus();
  if (silence.silenced && silence.reason === 'comeback' && silence.remaining) {
    console.log('[comeback] poll cycle — ' + silence.remaining + ' silent cycle(s) left before alerts resume');
  }

  // Poll smart wallets
  pollWallets(client).catch(e => console.error('[walletPoll] error:', e.message));

  if (pollCycleInProgress) {
    console.log('[poll] skip — previous cycle still running (too many tokens or slow APIs)');
    return;
  }
  pollCycleInProgress = true;
  pollCycleNumber += 1;
  const cycleNum = pollCycleNumber;
  clearRemovedThisCycle();

  try {
    const db = ensureDBSchema(loadDB());
    maybeRunDailyArchive(db);
    const trackedKeys = Object.keys(db.tokens || {});
    setActivePollTrackedKeys(trackedKeys);
    if (trackedKeys.length === 0) return;

    const tCycle = Date.now();
    const solPriceUsd = await fetchSolPrice();
    console.log('[poll] Checking ' + trackedKeys.length + ' tokens — SOL: $' + (solPriceUsd || '?'));

    const ordered = trackedKeys.slice().sort((a, b) => {
      const ta = db.tokens[a]?.postedAt || 0;
      const tb = db.tokens[b]?.postedAt || 0;
      return tb - ta;
    });

    const scheduled = [];
    let hotCount = 0;
    let warmCount = 0;
    let coldCount = 0;
    let inactiveCount = 0;
    let legacySkipCount = 0;
    let disabledChainCount = 0;
    let brokenCount = 0;
    for (const storageKey of ordered) {
      const entry = db.tokens[storageKey];
      if (!entry) continue;
      const { chainId } = parseStorageKey(storageKey);
      if (isLegacyEvmKey(storageKey)) {
        legacySkipCount += 1;
        continue;
      }
      if (!enabledChains().includes(chainId)) {
        disabledChainCount += 1;
        continue;
      }
      if (chainId === 'solana' && isBrokenSolKey(storageKey, entry)) brokenCount += 1;
      if (isInactiveForPolling(entry)) inactiveCount += 1;
      const tier = pollTierForEntry(entry);
      if (tier === 'hot') hotCount += 1;
      else if (tier === 'warm') warmCount += 1;
      else coldCount += 1;
      if (shouldPollAddressThisCycle(storageKey, entry, cycleNum)) {
        scheduled.push(storageKey);
      }
    }

    const runMilestoneBootstrap = !fs.existsSync(MILESTONE_BOOTSTRAP_FILE);
    const newest5ForBootstrap = runMilestoneBootstrap ? ordered.slice(0, 5) : [];
    const newest5Set = new Set(newest5ForBootstrap);
    if (runMilestoneBootstrap) {
      console.log(
        '[poll] milestone bootstrap: 🎯1x-only for newest 5 mints; other tokens skip 🎯 this cycle (no flood)',
      );
    }

    function milestoneOptsFor(storageKey) {
      const milestoneOpts = {};
      if (runMilestoneBootstrap) {
        if (newest5Set.has(storageKey)) milestoneOpts.tier1OnlyBootstrap = true;
        else milestoneOpts.suppressTierX = true;
      }
      return milestoneOpts;
    }

    const byChain = new Map();
    const pumpMints = [];
    for (const storageKey of scheduled) {
      const entry = db.tokens[storageKey];
      const { chainId, address } = parseStorageKey(storageKey);
      if (isLegacyEvmKey(storageKey)) continue;
      if (!enabledChains().includes(chainId)) continue;
      if (chainId === 'solana' && isBrokenSolKey(storageKey, entry)) continue;
      if (chainId === 'solana' && entry?.platform === 'pumpfun' && !entry.graduationAlertFired) {
        pumpMints.push(storageKey);
        continue;
      }
      const arr = byChain.get(chainId) || [];
      arr.push({ key: storageKey, address });
      byChain.set(chainId, arr);
    }

    for (const [, items] of byChain) {
      items.sort((a, b) => tierRank(db.tokens[a.key]) - tierRank(db.tokens[b.key]));
    }

    const chainBatchCounts = {};
    let dexProcessed = 0;
    for (const [chainId, items] of byChain) {
      const addrs = items.map((i) => i.address);
      const liveMap = await batchFetch(chainId, addrs);
      let chainProcessed = 0;
      for (const { key, address } of items) {
        const lookup = chainId === 'solana' ? address : address.toLowerCase();
        const live = liveMap.get(lookup);
        if (!live) continue;
        try {
          await processTokenWithLive(client, key, db, live, milestoneOptsFor(key));
          chainProcessed += 1;
          dexProcessed += 1;
        } catch (e) {
          console.error('[poll] Error processing ' + key + ':', e.message);
        }
      }
      chainBatchCounts[chainId] = chainProcessed + '/' + items.length;
    }

    await runPollBatch(pumpMints, async (address) => {
      if (pollingLock.has(address)) return;
      pollingLock.add(address);
      try {
        await processToken(client, address, db, solPriceUsd, milestoneOptsFor(address));
      } catch (e) {
        console.error('[poll] Error processing ' + address + ':', e.message);
      } finally {
        pollingLock.delete(address);
      }
    });

    if (runMilestoneBootstrap) {
      try {
        fs.writeFileSync(MILESTONE_BOOTSTRAP_FILE, String(Date.now()));
        console.log('[poll] milestone bootstrap done — full 🎯 logic on all tokens next cycle');
      } catch (e) {
        console.error('[poll] milestone bootstrap marker write failed:', e.message);
      }
    }

    let scheduledSol = 0;
    let scheduledRh = 0;
    for (const k of scheduled) {
      const { chainId } = parseStorageKey(k);
      if (chainId === 'solana') scheduledSol += 1;
      else if (chainId === 'robinhood') scheduledRh += 1;
    }

    saveDB(db);
    tickComebackAfterPollCycle();

    const elapsedMs = Date.now() - tCycle;
    const rateStats = rateLimiter.stats();
    recordCycle({
      ms: elapsedMs,
      scheduledSol,
      scheduledRh,
      broken: brokenCount,
      rate429Streak: rateStats.consecutive429,
    });

    const elapsed = Math.round(elapsedMs / 1000);
    const batchSummary = Object.entries(chainBatchCounts)
      .map(([c, n]) => c + '=' + n)
      .join(' ');
    console.log(
      '[poll] Cycle #' + cycleNum + ' done in ' + elapsed + 's — scheduled ' + scheduled.length +
      '/' + ordered.length + ' (hot=' + hotCount + ', warm=' + warmCount + ', cold=' + coldCount +
      ', inactive=' + inactiveCount + ', legacy=' + legacySkipCount +
      ', disabled=' + disabledChainCount + ', broken=' + brokenCount +
      ', batch ' + (batchSummary || 'none') + ', pump=' + pumpMints.length +
      ') rate=' + JSON.stringify(rateStats),
    );
  } finally {
    clearActivePollTrackedKeys();
    pollCycleInProgress = false;
  }
}

/** +75% window, 1x–20x milestones, and peak/lastPrice updates (uses USD price vs priceAtCall). */
async function evaluateGainAndMilestones(client, address, db, entry, live, milestoneOpts = {}) {
  const livePrice =
    live.price == null || live.price === '' ? null : Number(live.price);
  let callPx =
    entry.priceAtCall == null || entry.priceAtCall === '' ? null : Number(entry.priceAtCall);

  if (
    livePrice != null &&
    Number.isFinite(livePrice) &&
    livePrice > 0 &&
    (callPx == null || !Number.isFinite(callPx) || callPx <= 0) &&
    !entry.priceAtCallBackfilled
  ) {
    db.tokens[address].priceAtCall = String(livePrice);
    db.tokens[address].priceAtCallBackfilled = true;
    console.log('[backfill] ' + entry.name + ' priceAtCall was null — set from first live tick');
    db.tokens[address].lastPrice = String(livePrice);
    db.tokens[address].lastChecked = Date.now();
    return;
  }

  if (
    livePrice == null ||
    !Number.isFinite(livePrice) ||
    livePrice <= 0 ||
    callPx == null ||
    !Number.isFinite(callPx) ||
    callPx <= 0
  ) {
    db.tokens[address].lastChecked = Date.now();
    return;
  }

  const multPrice = livePrice / callPx;

  let multMcap = null;
  const mcapCall =
    entry.mcapAtCall == null || entry.mcapAtCall === '' ? null : Number(entry.mcapAtCall);
  const mcapLive =
    live.marketCap == null || live.marketCap === '' ? null : Number(live.marketCap);
  if (
    mcapCall != null &&
    Number.isFinite(mcapCall) &&
    mcapCall > 0 &&
    mcapLive != null &&
    Number.isFinite(mcapLive) &&
    mcapLive > 0
  ) {
    multMcap = mcapLive / mcapCall;
  }

  // Use the higher of price× vs call or mcap× vs call so FDV/MCap moves still count when Dex price lags.
  const currentMultiple =
    multMcap != null && Number.isFinite(multMcap) && multMcap > 0
      ? Math.max(multPrice, multMcap)
      : multPrice;

  // Trench reset — below call (~0.99×) for 3 polls, max once per 24h; recovery uses highest-tier-only alerts.
  const milestonesFired = db.tokens[address].milestonesFired || [];
  const takeProfitFired = db.tokens[address].takeProfitFired || false;
  const gainAlertFired = db.tokens[address].gainAlertFired || false;

  let lowStreak = Number(db.tokens[address].lowMultStreak) || 0;
  if (currentMultiple < MILESTONE_RESET_MULT) {
    lowStreak += 1;
    db.tokens[address].lowMultStreak = lowStreak;
    const lastResetAt = Number(db.tokens[address].lastMilestoneResetAt) || 0;
    const cooldownOk = Date.now() - lastResetAt >= MILESTONE_RESET_COOLDOWN_MS;
    if (
      cooldownOk &&
      lowStreak >= MILESTONE_RESET_STREAK &&
      (milestonesFired.length > 0 || takeProfitFired || gainAlertFired)
    ) {
      db.tokens[address].milestonesFired = [];
      db.tokens[address].takeProfitFired = false;
      db.tokens[address].gainAlertFired = false;
      db.tokens[address].lowMultStreak = 0;
      db.tokens[address].peakMultiple = currentMultiple;
      db.tokens[address].peakAt = Date.now();
      db.tokens[address].lastMilestoneResetAt = Date.now();
      console.log(
        '[reset] ' + entry.name + ' below call (' + MILESTONE_RESET_MULT + 'x) ×' + MILESTONE_RESET_STREAK + ' polls — milestones cleared for recovery',
      );
    }
  } else {
    db.tokens[address].lowMultStreak = 0;
  }

  const curGainAlert = db.tokens[address].gainAlertFired || false;

  // Check A: +75% — only fires between 1.75x and 2x (before tier 1 at 2× price)
  if (currentMultiple >= 1.75 && currentMultiple < 2.0 && !curGainAlert) {
    const thumb = tokenThumbnail(entry, live);
    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('📈 ' + chainBadge(entry.chain) + lifecyclePrefix(entry) + entry.name + ' (' + entry.symbol + ') — up 75% · MCap: ' + fmtUsd(live.marketCap))
      .setDescription(takeProfitDescription(address, entry.postedBy, entry.postedAt));
    if (thumb) embed.setThumbnail(thumb);

    await sendTokenAlert(client, db, address, embed, 'gain75', '+75%');
    db.tokens[address].gainAlertFired = true;
    saveDB(db);
    console.log('[+75%] ' + entry.name);
  }

  const rawMilestones = db.tokens[address].milestonesFired || [];
  let latest = normalizeTakeProfitTiers(rawMilestones);
  if (JSON.stringify(latest) !== JSON.stringify(rawMilestones)) {
    db.tokens[address].milestonesFired = latest;
  }

  if (!milestoneOpts.suppressTierX) {
    const maxTier = milestoneOpts.tier1OnlyBootstrap ? 1 : 20;
    const newlyPassed = [];
    for (let tier = 1; tier <= maxTier; tier++) {
      if (!latest.includes(tier) && currentMultiple >= tier + 1) {
        newlyPassed.push(tier);
      }
    }

    if (newlyPassed.length > 0) {
      const silentTiers = newlyPassed.slice(0, -1);
      let alertTier = newlyPassed[newlyPassed.length - 1];
      const lastCheckedAge = Date.now() - (Number(entry.lastChecked) || 0);
      const staleCatchUp = lastCheckedAge > SILENT_CATCHUP_STALE_MS;

      if (silentTiers.length >= 2 && latest.length === 0 && currentMultiple >= 4 && staleCatchUp) {
        latest = [...new Set([...latest, ...newlyPassed])].sort((a, b) => a - b);
        db.tokens[address].milestonesFired = latest;
        db.tokens[address].gainAlertFired = true;
        db.tokens[address].takeProfitFired = true;
        console.log(
          '[milestone] ' + entry.name + ' full silent catch-up: marked ' + newlyPassed.join(',') + 'x (no ping)',
        );
        alertTier = null;
      }

      if (alertTier != null && silentTiers.length > 0 && alertTier === newlyPassed[newlyPassed.length - 1]) {
        latest = [...new Set([...latest, ...silentTiers])].sort((a, b) => a - b);
        db.tokens[address].milestonesFired = latest;
        console.log(
          '[milestone] ' + entry.name + ' catch-up: marked ' + silentTiers.join(',') + 'x silently',
        );
      }

      if (alertTier != null) {
        const thumb = tokenThumbnail(entry, live);
        const embed = new EmbedBuilder()
          .setColor(0xffd700)
          .setTitle('🎯 ' + alertTier + 'x — ' + chainBadge(entry.chain) + lifecyclePrefix(entry) + entry.name + ' (' + entry.symbol + ')')
          .setDescription(takeProfitDescription(address, entry.postedBy, entry.postedAt));
        if (thumb) embed.setThumbnail(thumb);

        await sendTokenAlert(client, db, address, embed, 'tier' + alertTier, alertTier + 'x');
        latest = [...new Set([...latest, alertTier])].sort((a, b) => a - b);
        db.tokens[address].milestonesFired = latest;
        db.tokens[address].gainAlertFired = true;
        db.tokens[address].takeProfitFired = true;
        saveDB(db);
        updateCallerStatsForUser(db, entry.postedByUserId, entry.postedBy);
        console.log('[' + alertTier + 'x] ' + entry.name);
      }
    }
  }

  const storedPeak = Number(entry.peakMultiple) || 1;
  const newPeak = Math.max(storedPeak, currentMultiple);
  maybeResetRetestOnAth(db.tokens[address], storedPeak, newPeak);
  db.tokens[address].lastPrice = String(livePrice);
  db.tokens[address].lastVolume = live.volume24h || 0;
  db.tokens[address].lastChecked = Date.now();
  if (entry.xHandle === undefined && live.xHandle) {
    db.tokens[address].xHandle = live.xHandle;
    indexXAccount(db, live.xHandle, address);
  }
  db.tokens[address].peakMultiple = newPeak;
  if (newPeak > storedPeak) {
    db.tokens[address].athLedger = {
      peakMultiple: newPeak,
      peakAt: Date.now(),
      minsToPeak: Math.round((Date.now() - (entry.postedAt || Date.now())) / 60000),
    };
  }
  if (isSignificantNewAth(storedPeak, currentMultiple)) {
    db.tokens[address].peakAt = Date.now();
  } else if (db.tokens[address].peakAt == null || db.tokens[address].peakAt === '') {
    db.tokens[address].peakAt = ensurePeakAt(entry);
  }
  if (live.buyPct !== null && live.buyPct !== undefined) {
    db.tokens[address].buyPressure = live.buyPct;
    db.tokens[address].sellPressure = 100 - live.buyPct;
  }
}

async function processTokenWithLive(client, address, db, live, milestoneOpts = {}) {
  const entry = db.tokens[address];
  if (!entry) return;

  if (live.source === 'dexscreener' && entry.platform === 'pumpfun') {
    db.tokens[address].platform = 'dexscreener';
  }

  await evaluateGainAndMilestones(client, address, db, entry, live, milestoneOpts);

  const currentMult = currentMultipleFromLive(entry, live);
  if (currentMult != null) {
    entry.lifecycle = deriveLifecycle(entry, currentMult);
    try {
      await evaluateVelocity(client, db, address, entry, live, currentMult);
      await evaluateLiquidityDivergence(client, db, address, entry, live, currentMult);
      await evaluateRetest(client, db, address, entry, live, currentMult);
      await evaluatePersonalPositions(client, db, address, entry, live, currentMult);
    } catch (e) {
      console.error('[signals] ' + address + ':', e.message);
    }
  }
}

async function processToken(client, address, db, solPriceUsd, milestoneOpts = {}) {
  const entry = db.tokens[address];
  if (!entry) return;

  const graduationAlertFired = entry.graduationAlertFired || false;
  const bondingAlertFired = entry.bondingAlertFired || false;

  const live = await fetchLiveData(address, entry, solPriceUsd);
  if (!live) return;

  if (entry.chain === 'robinhood') {
    await evaluateGainAndMilestones(client, address, db, entry, live, milestoneOpts);
    return;
  }

  // Graduation check (Solana pump.fun only)
  if (live.source === 'pumpfun' && live.rawPump) {
    const pumpData = live.rawPump;
    if (pumpData.complete === true && !graduationAlertFired) {
      const embed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle('🎓 ' + entry.name + ' (' + entry.symbol + ') graduated to Raydium!')
        .setDescription(
          '**' + entry.name + '** completed its bonding curve.\n\n' +
          'Posted by **' + entry.postedBy + '** · ' + fmtTime(entry.postedAt) + '\n' +
          'Entry MCap: ' + fmtUsd(entry.mcapAtCall)
        )
        .addFields(
          { name: 'Final MCap', value: fmtUsd(pumpData.usd_market_cap), inline: true },
          { name: 'Chain', value: chainLabel(entry.chain), inline: true }
        )
        .setFooter({ text: address })
        .setTimestamp();

      await sendEmbed(client, entry.alertChannelId, embed);
      db.tokens[address].platform = 'dexscreener';
      db.tokens[address].graduationAlertFired = true;
      saveDB(db);
      console.log('[graduation] ' + entry.name + ' graduated');
      let liveM = await fetchLiveData(address, entry, solPriceUsd);
      if (!liveM || !liveM.price) liveM = live;
      await evaluateGainAndMilestones(client, address, db, entry, liveM, milestoneOpts);
      return;
    }

    const newBonding = pumpData.bonding_curve_progress || 0;
    db.tokens[address].bondingProgress = newBonding;

    if (newBonding >= 85 && !bondingAlertFired) {
      const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle('⚡ ' + entry.name + ' (' + entry.symbol + ') — ' + newBonding.toFixed(0) + '% to Raydium')
        .setDescription(
          '**' + entry.name + '** is ' + newBonding.toFixed(0) + '% through its bonding curve.\n\n' +
          'Posted by **' + entry.postedBy + '**\n' +
          'MCap now: ' + fmtUsd(live.marketCap)
        )
        .setFooter({ text: address })
        .setTimestamp();

      await sendEmbed(client, entry.alertChannelId, embed);
      db.tokens[address].bondingAlertFired = true;
      saveDB(db);
    }

    if (newBonding < 70 && bondingAlertFired) {
      db.tokens[address].bondingAlertFired = false;
    }
  }

  await evaluateGainAndMilestones(client, address, db, entry, live, milestoneOpts);
}
