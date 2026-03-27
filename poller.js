import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.dirname(new URL(import.meta.url).pathname);
const DB_PATH = path.join(DATA_DIR, 'tracked.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { tokens: {}, watchlist: {} }; }
}

function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('[DB] saveDB failed:', e.message); }
}

function fmtUsd(n) {
  if (!n || isNaN(Number(n))) return '—';
  const num = Number(n);
  if (num >= 1_000_000_000) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1_000_000) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1_000) return '$' + (num / 1e3).toFixed(1) + 'K';
  return '$' + num.toFixed(4);
}

function fmtTime(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 365) return Math.floor(d / 365) + 'y ago';
  if (d > 0) return d + 'd ago';
  if (h > 0) return h + 'h ago';
  if (m > 0) return m + 'm ago';
  return 'just now';
}

// In-memory lock — prevents double-processing same token
const pollingLock = new Set();

async function fetchTokenDex(address) {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + address, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs && data.pairs[0];
    if (!pair) return null;
    return {
      price: pair.priceUsd,
      marketCap: pair.marketCap,
      volume24h: (pair.volume && pair.volume.h24) || 0,
      buys24h: (pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0,
      sells24h: (pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0,
      liquidity: (pair.liquidity && pair.liquidity.usd) || 0,
      dexUrl: pair.url
    };
  } catch (e) {
    console.error('[dex] fetch failed for ' + address + ':', e.message);
    return null;
  }
}

async function fetchPumpFunToken(address) {
  try {
    const res = await fetch('https://frontend-api.pump.fun/coins/' + address, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.mint) return null;
    return d;
  } catch (e) {
    console.error('[pumpfun] fetch failed for ' + address + ':', e.message);
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

async function sendEmbed(client, channelId, embed) {
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('[alert] send failed to channel ' + channelId + ':', e.message);
  }
}

export async function pollTokens(client) {
  const db = loadDB();
  const addresses = Object.keys(db.tokens || {});
  if (addresses.length === 0) return;

  const solPriceUsd = await fetchSolPrice();
  console.log('[poll] Checking ' + addresses.length + ' tokens — SOL: $' + (solPriceUsd || '?'));

  for (const address of addresses) {
    if (pollingLock.has(address)) {
      console.log('[poll] Skipping ' + address + ' — already locked');
      continue;
    }
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

  const milestonesFired = entry.milestonesFired || [];
  const takeProfitFired = entry.takeProfitFired || false;
  const gainAlertFired = entry.gainAlertFired || false;
  const graduationAlertFired = entry.graduationAlertFired || false;
  const bondingAlertFired = entry.bondingAlertFired || false;

  let livePrice = null;
  let liveMcap = null;
  let liveVolume = null;
  let liveBuyPct = null;
  let liveSellPct = null;
  let dexUrl = entry.dexUrl || null;

  const platform = entry.platform || 'dexscreener';

  if (platform === 'pumpfun' && !graduationAlertFired) {
    const pumpData = await fetchPumpFunToken(address);
    if (!pumpData) return;

    if (pumpData.complete === true && !graduationAlertFired) {
      const embed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle('🎓 ' + entry.name + ' (' + entry.symbol + ') graduated to Raydium!')
        .setDescription(
          '**' + entry.name + '** completed its bonding curve and is now trading on Raydium.\n\n' +
          'Posted by **' + entry.postedBy + '** · ' + fmtTime(entry.postedAt) + '\n' +
          'Entry: $' + entry.priceAtCall
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

    if (solPriceUsd) {
      livePrice = calcPumpFunPrice(pumpData, solPriceUsd);
    }
    liveMcap = pumpData.usd_market_cap;
    const newBonding = pumpData.bonding_curve_progress || 0;
    db.tokens[address].bondingProgress = newBonding;

    if (newBonding >= 85 && !bondingAlertFired) {
      const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle('⚡ ' + entry.name + ' (' + entry.symbol + ') — ' + newBonding.toFixed(0) + '% to Raydium')
        .setDescription(
          '**' + entry.name + '** is ' + newBonding.toFixed(0) + '% through its bonding curve.\n\n' +
          'Getting close to graduation!\n\n' +
          'Posted by **' + entry.postedBy + '**\n' +
          'MCap now: ' + fmtUsd(liveMcap)
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

  } else {
    const live = await fetchTokenDex(address);
    if (!live) return;

    livePrice = live.price ? Number(live.price) : null;
    liveMcap = live.marketCap;
    liveVolume = live.volume24h;
    dexUrl = live.dexUrl || dexUrl;

    const totalTxns = (live.buys24h || 0) + (live.sells24h || 0);
    if (totalTxns > 0) {
      liveBuyPct = Math.round((live.buys24h / totalTxns) * 100);
      liveSellPct = 100 - liveBuyPct;
    }
  }

  if (!livePrice || !entry.priceAtCall) {
    db.tokens[address].lastChecked = Date.now();
    return;
  }

  const currentMultiple = livePrice / Number(entry.priceAtCall);
  const buyPctStr = liveBuyPct !== null ? liveBuyPct + '%' : '—';
  const sellPctStr = liveSellPct !== null ? liveSellPct + '%' : '—';

  // RESET all alerts if dropped below 1.5x
  if (currentMultiple < 1.5) {
    const needsReset = milestonesFired.length > 0 || takeProfitFired || gainAlertFired;
    if (needsReset) {
      db.tokens[address].milestonesFired = [];
      db.tokens[address].takeProfitFired = false;
      db.tokens[address].gainAlertFired = false;
      saveDB(db);
      console.log('[reset] ' + entry.name + ' dropped below 1.5x — alerts reset');
    }
  }

  const curMilestones = db.tokens[address].milestonesFired || [];
  const curTakeProfit = db.tokens[address].takeProfitFired || false;
  const curGainAlert = db.tokens[address].gainAlertFired || false;

  // Check A: +75% gain alert
  if (currentMultiple >= 1.75 && !curGainAlert) {
    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('📈 ' + entry.name + ' (' + entry.symbol + ') — up 75% from entry')
      .setDescription(
        '**' + entry.name + '** is up 75% from entry.\n\n' +
        'Now: $' + livePrice.toFixed(8) + '\n' +
        'Entry: $' + entry.priceAtCall + ' · **' + entry.postedBy + '**\n\n' +
        'Buy pressure: ' + buyPctStr + '\n\n' +
        '*Not financial advice.*'
      )
      .addFields(
        { name: 'MCap', value: fmtUsd(liveMcap), inline: true },
        { name: 'Chain', value: (entry.chain || 'SOL').toUpperCase(), inline: true }
      )
      .setFooter({ text: entry.postedBy + ' · ' + fmtTime(entry.postedAt) })
      .setTimestamp();

    await sendEmbed(client, entry.alertChannelId, embed);
    db.tokens[address].gainAlertFired = true;
    saveDB(db);
    console.log('[+75%] ' + entry.name + ' up 75% from entry');
  }

  // Check B: Milestones 2x, 5x, 10x, 20x
  const milestones = [2, 5, 10, 20];
  for (const milestone of milestones) {
    const latest = db.tokens[address].milestonesFired || [];
    if (!latest.includes(milestone) && currentMultiple >= milestone) {
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('🎯 ' + milestone + 'x — ' + entry.name + ' (' + entry.symbol + ')')
        .setDescription(
          '**' + entry.name + '** just hit **' + milestone + 'x** from entry.\n\n' +
          '**' + entry.postedBy + '** · ' + fmtTime(entry.postedAt) + '\n' +
          'Entry: $' + entry.priceAtCall + ' → Now: $' + livePrice.toFixed(8) + '\n\n' +
          'Buy pressure: ' + buyPctStr
        )
        .setFooter({ text: address })
        .setTimestamp();

      await sendEmbed(client, entry.alertChannelId, embed);
      db.tokens[address].milestonesFired = latest.concat([milestone]);
      saveDB(db);
      console.log('[' + milestone + 'x] ' + entry.name + ' hit ' + milestone + 'x');
    }
  }

  // Check C: Take profit at 2x
  const latestTP = db.tokens[address].takeProfitFired || false;
  if (currentMultiple >= 2.0 && !latestTP) {
    const embed = new EmbedBuilder()
      .setColor(0xff9900)
      .setTitle('💰 ' + entry.name + ' (' + entry.symbol + ') is up ' + currentMultiple.toFixed(2) + 'x')
      .setDescription(
        entry.name + ' has doubled from entry.\n\n' +
        '👀 Might be worth taking some off the table.\n\n' +
        'Buy pressure: ' + buyPctStr + ' — Sell pressure: ' + sellPctStr + '\n\n' +
        '*Not financial advice — just a nudge.*'
      )
      .setFooter({ text: entry.postedBy + ' · ' + fmtTime(entry.postedAt) })
      .setTimestamp();

    await sendEmbed(client, entry.alertChannelId, embed);
    db.tokens[address].takeProfitFired = true;
    saveDB(db);
    console.log('[take profit] ' + entry.name + ' nudge sent');
  }

  // Update tracking fields
  const newPeak = Math.max(entry.peakMultiple || 1, currentMultiple);
  db.tokens[address].lastPrice = livePrice.toString();
  db.tokens[address].lastVolume = liveVolume || 0;
  db.tokens[address].lastChecked = Date.now();
  db.tokens[address].peakMultiple = newPeak;
  if (dexUrl) db.tokens[address].dexUrl = dexUrl;
}
