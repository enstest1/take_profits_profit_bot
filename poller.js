import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.dirname(new URL(import.meta.url).pathname);
const DB_PATH = path.join(DATA_DIR, 'tracked.json');

const SUMMARY_CHANNEL_ID = '1452152164699869298';

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

// DexScreener
async function fetchDexScreener(address) {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + address, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs && data.pairs[0];
    if (!pair) return null;
    const totalTxns = ((pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0) +
                      ((pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0);
    return {
      price: pair.priceUsd ? Number(pair.priceUsd) : null,
      marketCap: pair.marketCap || null,
      volume24h: (pair.volume && pair.volume.h24) || null,
      liquidity: (pair.liquidity && pair.liquidity.usd) || null,
      priceChange1h: (pair.priceChange && pair.priceChange.h1) || null,
      buyPct: totalTxns > 0 ? Math.round(((pair.txns.h24.buys || 0) / totalTxns) * 100) : null,
      imageUrl: (pair.info && pair.info.imageUrl) || null,
      source: 'dexscreener'
    };
  } catch (e) {
    console.error('[dex] poll failed for ' + address + ':', e.message);
    return null;
  }
}

// pump.fun
async function fetchPumpFun(address) {
  try {
    const res = await fetch('https://frontend-api.pump.fun/coins/' + address, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.mint) return null;
    return d;
  } catch (e) {
    console.error('[pumpfun] poll failed for ' + address + ':', e.message);
    return null;
  }
}

async function fetchSolPrice() {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    return (data && data.solana && data.solana.usd) || null;
  } catch {
    return null;
  }
}

function calcPumpFunPrice(pumpData, solPrice) {
  try {
    const solRes = Number(pumpData.virtual_sol_reserves);
    const tokRes = Number(pumpData.virtual_token_reserves);
    if (!tokRes) return null;
    return (solRes / 1e9) / (tokRes / 1e6) * solPrice;
  } catch {
    return null;
  }
}

// Fetch live price — DexScreener first, pump.fun fallback
async function fetchLiveData(address, platform, solPriceUsd) {
  const dex = await fetchDexScreener(address);
  if (dex && dex.price) return dex;

  if (solPriceUsd) {
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
        rawPump: pump
      };
    }
  }

  return null;
}

async function sendEmbed(client, channelId, embed) {
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('[alert] send failed to channel ' + channelId + ':', e.message);
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
        await channel.send({ embeds: [embed] });
        console.log('[wallet] ' + wallet.label + ' ' + (isBuy ? 'bought' : 'sold') + ' ' + tokenSymbol);
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

  const solPriceUsd = await fetchSolPrice();
  const results = await Promise.allSettled(
    entries.map((e) => fetchLiveData(e.address, e.platform, solPriceUsd))
  );

  const rows = [];
  let bestCall = null;
  let bestMultiple = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const live = results[i].status === 'fulfilled' ? results[i].value : null;
    const livePrice = live && live.price ? Number(live.price) : null;
    const priceAtCall = entry.priceAtCall ? Number(entry.priceAtCall) : null;

    let multipleStr = '—';
    let mult = null;
    if (livePrice && priceAtCall && priceAtCall > 0) {
      mult = livePrice / priceAtCall;
      const pct = ((mult - 1) * 100).toFixed(0);
      const sign = mult >= 1 ? '+' : '';
      if (mult >= 2) multipleStr = '🚀 ' + mult.toFixed(2) + 'x (' + sign + pct + '%)';
      else if (mult >= 1) multipleStr = '📈 ' + mult.toFixed(2) + 'x (' + sign + pct + '%)';
      else multipleStr = '📉 ' + mult.toFixed(2) + 'x (' + pct + '%)';
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
      fmtUsd(live ? live.marketCap : null) +
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
    TOP_LOSERS;
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
    const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
    await channel.send({ embeds: [embed] });
    console.log('[summary] Posted successfully');
  } catch (e) {
    console.error('[summary] Failed to post:', e.message);
  }
}

function checkDailySummary(client) {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const todayStr = now.toISOString().slice(0, 10);
  if (utcHour === 12 && utcMinute < 3 && lastSummaryDate !== todayStr) {
    lastSummaryDate = todayStr;
    postDailySummary(client).catch(e => console.error('[summary] error:', e.message));
  }
}

export async function pollTokens(client) {
  checkDailySummary(client);

  // Poll smart wallets
  pollWallets(client).catch(e => console.error('[walletPoll] error:', e.message));

  const db = ensureDBSchema(loadDB());
  const addresses = Object.keys(db.tokens || {});
  if (addresses.length === 0) return;

  const solPriceUsd = await fetchSolPrice();
  console.log('[poll] Checking ' + addresses.length + ' tokens — SOL: $' + (solPriceUsd || '?'));

  for (const address of addresses) {
    if (pollingLock.has(address)) continue;
    pollingLock.add(address);
    try {
      await processToken(client, address, db, solPriceUsd);
    } catch (e) {
      console.error('[poll] Error processing ' + address + ':', e.message);
    } finally {
      pollingLock.delete(address);
    }
  }

  saveDB(db);
}

/** +75% window, 1x–20x milestones, and peak/lastPrice updates (uses USD price vs priceAtCall). */
async function evaluateGainAndMilestones(client, address, db, entry, live) {
  const livePrice = live.price ? Number(live.price) : null;
  if (!livePrice || !entry.priceAtCall) {
    db.tokens[address].lastChecked = Date.now();
    return;
  }

  const currentMultiple = livePrice / Number(entry.priceAtCall);

  // Reset all alerts below 1.5x
  const milestonesFired = db.tokens[address].milestonesFired || [];
  const takeProfitFired = db.tokens[address].takeProfitFired || false;
  const gainAlertFired = db.tokens[address].gainAlertFired || false;

  if (currentMultiple < 1.5) {
    if (milestonesFired.length > 0 || takeProfitFired || gainAlertFired) {
      db.tokens[address].milestonesFired = [];
      db.tokens[address].takeProfitFired = false;
      db.tokens[address].gainAlertFired = false;
      saveDB(db);
      console.log('[reset] ' + entry.name + ' dropped below 1.5x');
    }
  }

  const curGainAlert = db.tokens[address].gainAlertFired || false;

  // Check A: +75% — only fires between 1.75x and 2x (before tier 1 at 2× price)
  if (currentMultiple >= 1.75 && currentMultiple < 2.0 && !curGainAlert) {
    const thumb = tokenThumbnail(entry, live);
    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('📈 ' + entry.name + ' (' + entry.symbol + ') — up 75% · MCap: ' + fmtUsd(live.marketCap))
      .setDescription(takeProfitDescription(address, entry.postedBy, entry.postedAt));
    if (thumb) embed.setThumbnail(thumb);

    await sendEmbed(client, entry.alertChannelId, embed);
    db.tokens[address].gainAlertFired = true;
    saveDB(db);
    console.log('[+75%] ' + entry.name);
  }

  // Take-profit tiers 1x–20x — tier N when price is ≥ (N+1)× call (tier 1 at 2×, …, tier 20 at 21×)
  const rawMilestones = db.tokens[address].milestonesFired || [];
  let latest = normalizeTakeProfitTiers(rawMilestones);
  if (JSON.stringify(latest) !== JSON.stringify(rawMilestones)) {
    db.tokens[address].milestonesFired = latest;
    saveDB(db);
  }

  for (let tier = 1; tier <= 20; tier++) {
    if (!latest.includes(tier) && currentMultiple >= tier + 1) {
      const thumb = tokenThumbnail(entry, live);
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('🎯 ' + tier + 'x — ' + entry.name + ' (' + entry.symbol + ')')
        .setDescription(takeProfitDescription(address, entry.postedBy, entry.postedAt));
      if (thumb) embed.setThumbnail(thumb);

      await sendEmbed(client, entry.alertChannelId, embed);
      latest = latest.concat([tier]);
      db.tokens[address].milestonesFired = latest;
      db.tokens[address].gainAlertFired = true;
      db.tokens[address].takeProfitFired = true;
      saveDB(db);
      console.log('[' + tier + 'x] ' + entry.name);
    }
  }

  const newPeak = Math.max(entry.peakMultiple || 1, currentMultiple);
  db.tokens[address].lastPrice = String(livePrice);
  db.tokens[address].lastVolume = live.volume24h || 0;
  db.tokens[address].lastChecked = Date.now();
  db.tokens[address].peakMultiple = newPeak;
  if (live.buyPct !== null && live.buyPct !== undefined) {
    db.tokens[address].buyPressure = live.buyPct;
    db.tokens[address].sellPressure = 100 - live.buyPct;
  }
}

async function processToken(client, address, db, solPriceUsd) {
  const entry = db.tokens[address];
  if (!entry) return;

  const graduationAlertFired = entry.graduationAlertFired || false;
  const bondingAlertFired = entry.bondingAlertFired || false;

  const live = await fetchLiveData(address, entry.platform || 'dexscreener', solPriceUsd);
  if (!live) return;

  // Graduation check
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
          { name: 'Chain', value: 'SOLANA', inline: true }
        )
        .setFooter({ text: address })
        .setTimestamp();

      await sendEmbed(client, entry.alertChannelId, embed);
      db.tokens[address].platform = 'dexscreener';
      db.tokens[address].graduationAlertFired = true;
      saveDB(db);
      console.log('[graduation] ' + entry.name + ' graduated');
      // Same tick: previously returned here so +75%/milestones never ran after grad.
      let liveM = await fetchLiveData(address, 'dexscreener', solPriceUsd);
      if (!liveM || !liveM.price) liveM = live;
      await evaluateGainAndMilestones(client, address, db, entry, liveM);
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
      saveDB(db);
    }
  }

  await evaluateGainAndMilestones(client, address, db, entry, live);
}
