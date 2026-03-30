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

// Daily summary at 4am PST (12:00 UTC)
async function postDailySummary(client) {
  const db = ensureDBSchema(loadDB());
  const entries = Object.values(db.tokens || {});
  console.log('[summary] Posting daily summary — ' + entries.length + ' tokens');

  if (entries.length === 0) {
    try {
      const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
      await channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📊 Daily Summary')
          .setDescription('No tokens being tracked right now.')
          .setTimestamp()]
      });
    } catch (e) { console.error('[summary] failed:', e.message); }
    return;
  }

  const solPriceUsd = await fetchSolPrice();
  const results = await Promise.allSettled(
    entries.map(e => fetchLiveData(e.address, e.platform, solPriceUsd))
  );

  const lines = [];
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
      if (mult > bestMultiple) { bestMultiple = mult; bestCall = entry; }
    }

    const peakStr = entry.peakMultiple && entry.peakMultiple > 1
      ? ' · Peak: ' + entry.peakMultiple.toFixed(2) + 'x' : '';

    lines.push(
      '**' + entry.name + ' (' + entry.symbol + ')** — ' + multipleStr + '\n' +
      '└ **' + entry.postedBy + '** · ' + fmtTime(entry.postedAt) + ' · MCap: ' + fmtUsd(live ? live.marketCap : null) + peakStr
    );
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  let footerStr = entries.length + ' token' + (entries.length !== 1 ? 's' : '') + ' tracked';
  if (bestCall) footerStr += ' · Best: ' + bestCall.name + ' ' + bestMultiple.toFixed(2) + 'x by ' + bestCall.postedBy;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📊 Daily Summary — ' + dateStr)
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: footerStr })
    .setTimestamp();

  try {
    const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
    await channel.send({ embeds: [embed] });
    console.log('[summary] Posted successfully');
  } catch (e) { console.error('[summary] Failed to post:', e.message); }
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

  const livePrice = live.price ? Number(live.price) : null;
  if (!livePrice || !entry.priceAtCall) {
    db.tokens[address].lastChecked = Date.now();
    return;
  }

  const currentMultiple = livePrice / Number(entry.priceAtCall);
  const buyPctStr = live.buyPct !== null && live.buyPct !== undefined ? live.buyPct + '%' : '—';

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

  // Check A: +75% — only fires between 1.75x and 2x to prevent double post
  if (currentMultiple >= 1.75 && currentMultiple < 2.0 && !curGainAlert) {
    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('📈 ' + entry.name + ' (' + entry.symbol + ') — up 75% · MCap: ' + fmtUsd(live.marketCap))
      .setFooter({ text: address + ' · ' + entry.postedBy + ' · ' + fmtTime(entry.postedAt) })
      .setTimestamp();
    if (entry.imageUrl) embed.setThumbnail(entry.imageUrl);

    await sendEmbed(client, entry.alertChannelId, embed);
    db.tokens[address].gainAlertFired = true;
    saveDB(db);
    console.log('[+75%] ' + entry.name);
  }

  // Check B: Milestones 2x, 5x, 10x, 20x
  const milestones = [2, 5, 10, 20];
  for (const milestone of milestones) {
    const latest = db.tokens[address].milestonesFired || [];
    if (!latest.includes(milestone) && currentMultiple >= milestone) {
      const gainX = milestone - 1;
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('🎯 ' + gainX + 'x — ' + entry.name + ' (' + entry.symbol + ')')
        .setDescription('💰💰💰 Take Profit 💰💰💰')
        .setFooter({ text: address + ' · ' + entry.postedBy + ' · ' + fmtTime(entry.postedAt) })
        .setTimestamp();
      if (entry.imageUrl) embed.setThumbnail(entry.imageUrl);

      await sendEmbed(client, entry.alertChannelId, embed);
      db.tokens[address].milestonesFired = latest.concat([milestone]);
      db.tokens[address].gainAlertFired = true;
      db.tokens[address].takeProfitFired = true;
      saveDB(db);
      console.log('[' + gainX + 'x] ' + entry.name);
    }
  }

  // Update tracking fields
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
