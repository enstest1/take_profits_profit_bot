import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.dirname(new URL(import.meta.url).pathname);
const DB_PATH = path.join(DATA_DIR, 'tracked.json');

const SUMMARY_CHANNEL_ID = '1452152164699869298';

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

// In-memory lock
const pollingLock = new Set();

// Track if daily summary has fired today
let lastSummaryDate = null;

// ── API fetchers ────────────────────────────────────────────────────────────

async function fetchBirdeye(address) {
  if (!process.env.BIRDEYE_API_KEY) return null;
  try {
    const res = await fetch(
      'https://public-api.birdeye.so/defi/token_overview?address=' + address,
      {
        headers: {
          'X-API-KEY': process.env.BIRDEYE_API_KEY,
          'x-chain': 'solana',
          'accept': 'application/json'
        },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const d = json && json.data;
    if (!d) return null;
    return {
      price: d.price || null,
      marketCap: d.mc || d.marketCap || null,
      volume24h: d.v24hUSD || d.v24h || null,
      volume1h: d.v1hUSD || d.v1h || null,
      priceChange1h: d.priceChange1hPercent || null,
      buys24h: d.buy24h || null,
      sells24h: d.sell24h || null,
      liquidity: d.liquidity || null,
    };
  } catch (e) {
    console.error('[birdeye] poll failed for ' + address + ':', e.message);
    return null;
  }
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
      price: pair.priceUsd || null,
      marketCap: pair.marketCap || null,
      volume24h: (pair.volume && pair.volume.h24) || null,
      buys24h: (pair.txns && pair.txns.h24 && pair.txns.h24.buys) || null,
      sells24h: (pair.txns && pair.txns.h24 && pair.txns.h24.sells) || null,
      liquidity: (pair.liquidity && pair.liquidity.usd) || null,
      priceChange1h: (pair.priceChange && pair.priceChange.h1) || null,
    };
  } catch (e) {
    console.error('[dexscreener] poll failed for ' + address + ':', e.message);
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

// Fetch live price — Birdeye first, DexScreener fallback, pump.fun for bonding curve
async function fetchLiveData(address, platform, solPriceUsd) {
  // Always try Birdeye first
  const birdeye = await fetchBirdeye(address);
  if (birdeye && birdeye.price) {
    const totalTxns = (birdeye.buys24h || 0) + (birdeye.sells24h || 0);
    return {
      price: birdeye.price,
      marketCap: birdeye.marketCap,
      volume24h: birdeye.volume24h,
      liquidity: birdeye.liquidity,
      priceChange1h: birdeye.priceChange1h,
      buyPct: totalTxns > 0 ? Math.round((birdeye.buys24h / totalTxns) * 100) : null,
      source: 'birdeye'
    };
  }

  // Fallback to DexScreener
  const dex = await fetchDexScreener(address);
  if (dex && dex.price) {
    const totalTxns = (dex.buys24h || 0) + (dex.sells24h || 0);
    return {
      price: Number(dex.price),
      marketCap: dex.marketCap,
      volume24h: dex.volume24h,
      liquidity: dex.liquidity,
      priceChange1h: dex.priceChange1h,
      buyPct: totalTxns > 0 ? Math.round((dex.buys24h / totalTxns) * 100) : null,
      source: 'dexscreener'
    };
  }

  // Fallback to pump.fun (bonding curve tokens)
  if (platform === 'pumpfun' && solPriceUsd) {
    const pump = await fetchPumpFun(address);
    if (pump) {
      const price = calcPumpFunPrice(pump, solPriceUsd);
      return {
        price: price,
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

// ── Daily Summary ───────────────────────────────────────────────────────────

async function postDailySummary(client) {
  const db = loadDB();
  const entries = Object.values(db.tokens || {});

  console.log('[summary] Posting daily summary — ' + entries.length + ' tokens');

  if (entries.length === 0) {
    try {
      const channel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('📊 Daily Summary')
            .setDescription('No tokens being tracked right now.')
            .setTimestamp()
        ]
      });
    } catch (e) {
      console.error('[summary] failed to post empty summary:', e.message);
    }
    return;
  }

  const solPriceUsd = await fetchSolPrice();

  // Fetch live data for all tokens
  const results = await Promise.allSettled(
    entries.map(e => fetchLiveData(e.address, e.platform, solPriceUsd))
  );

  const lines = [];
  let bestCall = null;
  let bestMultiple = 0;
  let totalTracked = entries.length;
  let winners = 0;
  let losers = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const live = results[i].status === 'fulfilled' ? results[i].value : null;

    const livePrice = live && live.price ? Number(live.price) : null;
    const priceAtCall = entry.priceAtCall ? Number(entry.priceAtCall) : null;

    let multipleStr = '—';
    let mult = null;

    if (livePrice && priceAtCall && priceAtCall > 0) {
      mult = livePrice / priceAtCall;
      const pctGain = ((mult - 1) * 100).toFixed(0);
      const sign = mult >= 1 ? '+' : '';

      if (mult >= 2) {
        multipleStr = '🚀 ' + mult.toFixed(2) + 'x (' + sign + pctGain + '%)';
        winners++;
      } else if (mult >= 1) {
        multipleStr = '📈 ' + mult.toFixed(2) + 'x (' + sign + pctGain + '%)';
        winners++;
      } else {
        multipleStr = '📉 ' + mult.toFixed(2) + 'x (' + pctGain + '%)';
        losers++;
      }

      if (mult > bestMultiple) {
        bestMultiple = mult;
        bestCall = entry;
      }
    }

    const peakStr = entry.peakMultiple && entry.peakMultiple > 1
      ? ' · Peak: ' + entry.peakMultiple.toFixed(2) + 'x'
      : '';

    lines.push(
      '**' + entry.name + ' (' + entry.symbol + ')** — ' + multipleStr + '\n' +
      '└ **' + entry.postedBy + '** · ' + fmtTime(entry.postedAt) + ' · MCap: ' + fmtUsd(live ? live.marketCap : null) + peakStr
    );
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  let footerStr = totalTracked + ' token' + (totalTracked !== 1 ? 's' : '') + ' tracked';
  if (bestCall) {
    footerStr += ' · Best call: ' + bestCall.name + ' ' + bestMultiple.toFixed(2) + 'x by ' + bestCall.postedBy;
  }

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
  } catch (e) {
    console.error('[summary] Failed to post:', e.message);
  }
}

// ── Check if daily summary should fire ─────────────────────────────────────
// 4am PST = 12:00 UTC
function checkDailySummary(client) {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const todayStr = now.toISOString().slice(0, 10);

  // Fire between 12:00 and 12:03 UTC (gives a 3-min window in case poll is slightly delayed)
  if (utcHour === 12 && utcMinute < 3 && lastSummaryDate !== todayStr) {
    lastSummaryDate = todayStr;
    postDailySummary(client).catch(e => console.error('[summary] error:', e.message));
  }
}

// ── Main poll loop ──────────────────────────────────────────────────────────

export async function pollTokens(client) {
  // Check if daily summary should fire
  checkDailySummary(client);

  const db = loadDB();
  const addresses = Object.keys(db.tokens || {});
  if (addresses.length === 0) return;

  const solPriceUsd = await fetchSolPrice();
  console.log('[poll] Checking ' + addresses.length + ' tokens — SOL: $' + (solPriceUsd || '?'));

  for (const address of addresses) {
    if (pollingLock.has(address)) {
      console.log('[poll] Skipping ' + address + ' — locked');
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

// ── Process single token ────────────────────────────────────────────────────

async function processToken(client, address, db, solPriceUsd) {
  const entry = db.tokens[address];
  if (!entry) return;

  const graduationAlertFired = entry.graduationAlertFired || false;
  const bondingAlertFired = entry.bondingAlertFired || false;

  // Fetch live data using the waterfall
  const live = await fetchLiveData(address, entry.platform || 'birdeye', solPriceUsd);
  if (!live) return;

  // Handle graduation for pump.fun tokens
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
      db.tokens[address].platform = 'birdeye';
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
  const sellPctStr = live.buyPct !== null && live.buyPct !== undefined ? (100 - live.buyPct) + '%' : '—';

  // RESET all alerts if dropped below 1.5x
  const milestonesFired = db.tokens[address].milestonesFired || [];
  const takeProfitFired = db.tokens[address].takeProfitFired || false;
  const gainAlertFired = db.tokens[address].gainAlertFired || false;

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

  const curGainAlert = db.tokens[address].gainAlertFired || false;

  // Check A: +75% gain alert
  // Guard: currentMultiple < 2.0 prevents double-firing when token jumps straight to 2x
  if (currentMultiple >= 1.75 && currentMultiple < 2.0 && !curGainAlert) {
    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('📈 ' + entry.name + ' (' + entry.symbol + ') — up 75% · MCap: ' + fmtUsd(live.marketCap))
      .setFooter({ text: address + ' · ' + entry.postedBy + ' · ' + fmtTime(entry.postedAt) })
      .setTimestamp();

    await sendEmbed(client, entry.alertChannelId, embed);
    db.tokens[address].gainAlertFired = true;
    saveDB(db);
    console.log('[+75%] ' + entry.name);
  }

  // Check B: Milestones
  // Labels show GAIN: price 2x = 1x gain (+100%), price 5x = 4x gain (+400%) etc
  const milestones = [2, 5, 10, 20];
  for (const milestone of milestones) {
    const latest = db.tokens[address].milestonesFired || [];
    if (!latest.includes(milestone) && currentMultiple >= milestone) {
      const gainX = milestone - 1;
      const gainPct = gainX * 100;
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('🎯 ' + gainX + 'x (+' + gainPct + '%) — ' + entry.name + ' (' + entry.symbol + ')')
        .setDescription('💰💰💰 Take Profit 💰💰💰')
        .setFooter({ text: address + ' · ' + entry.postedBy + ' · ' + fmtTime(entry.postedAt) })
        .setTimestamp();

      await sendEmbed(client, entry.alertChannelId, embed);
      db.tokens[address].milestonesFired = latest.concat([milestone]);
      db.tokens[address].gainAlertFired = true;
      db.tokens[address].takeProfitFired = true;
      saveDB(db);
      console.log('[' + gainX + 'x +' + gainPct + '%] ' + entry.name);
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
