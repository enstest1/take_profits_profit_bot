"use strict";

/**
 * poller.js — polling loop, price checks, milestone logic
 * Runs every 15 seconds via setInterval in index.js
 */

const { fetchTokenDex } = require("./dexscreener.js");
const { fetchPumpFunToken, fetchSolPrice, calculatePumpFunPrice } = require("./pumpfun.js");
const {
  getSolanaTokenPrice,
  getSolanaTokenBuySellPressure,
  getSolanaTopHolders,
  getEVMTokenBuySellPressure,
  getEVMDevWallet,
  getEVMWalletTokenBalance,
  delay,
} = require("./moralis.js");

// ─────────────────────────────────────────────
// RATE-LIMIT PROTECTION
// ─────────────────────────────────────────────

/** Prevent overlapping poll cycles when a poll takes longer than the interval */
let pollRunning = false;

/**
 * Buy/sell pressure cache — Moralis free tier = 40 req/min.
 * Pressure data changes slowly; no need to re-fetch every 15 seconds.
 * TTL: 2 minutes → 5 tokens = ~2.5 Moralis calls/min instead of 20–40.
 */
const pressureCache = new Map();
const PRESSURE_TTL = 2 * 60 * 1000; // 2 min

async function fetchPressureCached(entry, fallbackBuys, fallbackSells) {
  const cached = pressureCache.get(entry.address);
  if (cached && Date.now() - cached.at < PRESSURE_TTL) return cached.data;

  const data = await fetchPressure(entry);

  // If Moralis returned no data, try DexScreener buys/sells as fallback
  if (data.buyPressurePct == null && fallbackBuys != null && fallbackSells != null) {
    const total = Number(fallbackBuys) + Number(fallbackSells);
    if (total > 0) {
      data.buys = Number(fallbackBuys);
      data.sells = Number(fallbackSells);
      data.totalTxns = total;
      data.buyPressurePct = ((data.buys / total) * 100).toFixed(0);
    }
  }

  pressureCache.set(entry.address, { data, at: Date.now() });
  return data;
}

/**
 * SOL price cache — CoinGecko free tier ≈ 10-30 req/min.
 * SOL price changes slowly; cache for 60 seconds.
 */
let solPriceCache = { price: null, at: 0 };
const SOL_PRICE_TTL = 60 * 1000; // 60 sec

async function fetchSolPriceCached() {
  if (solPriceCache.price !== null && Date.now() - solPriceCache.at < SOL_PRICE_TTL) {
    return solPriceCache.price;
  }
  const price = await fetchSolPrice();
  if (price !== null) solPriceCache = { price, at: Date.now() };
  return price;
}

/** Dev wallet check interval — holdings move slowly; check every 5 min not 15 sec */
const DEV_CHECK_INTERVAL = 5 * 60 * 1000; // 5 min

// ─────────────────────────────────────────────
// FORMAT HELPERS
// ─────────────────────────────────────────────

function fmtUsd(n) {
  const num = Number(n);
  if (isNaN(num)) return "$?";
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(4)}`;
}

function fmtTime(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtMultiple(m) {
  return `${Number(m).toFixed(2)}x`;
}

function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function fmtWallet(addr) {
  if (!addr) return "unknown";
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

function fmtPressure(buyPct) {
  if (buyPct == null || buyPct === "") return "⚪ Insufficient data";
  const buy = Number(buyPct);
  if (isNaN(buy)) return "⚪ Insufficient data";
  const sell = 100 - buy;
  const indicator = buy >= 60 ? "🟢" : buy <= 40 ? "🔴" : "🟡";
  return `${indicator} ${buy}% buys / ${sell}% sells`;
}

// ─────────────────────────────────────────────
// FETCH LIVE DATA
// ─────────────────────────────────────────────

/**
 * Fetch live token data for one entry.
 * Returns { livePrice, liveVolume, pumpData } or null on failure.
 */
async function fetchLiveData(entry, solPriceUsd) {
  if (entry.platform === "pumpfun") {
    const pumpData = await fetchPumpFunToken(entry.address);
    if (!pumpData) return null;
    const livePrice = calculatePumpFunPrice(pumpData, solPriceUsd);
    return { livePrice, liveVolume: 0, marketCap: pumpData.usd_market_cap ?? null, pumpData };
  }

  if (entry.platform === "dexscreener") {
    const data = await fetchTokenDex(entry.address);
    if (!data) return null;
    return {
      livePrice: data.price ? Number(data.price) : null,
      liveVolume: data.volume24h ?? 0,
      buys24h: data.buys24h,
      sells24h: data.sells24h,
      marketCap: data.marketCap,
      pumpData: null,
    };
  }

  if (entry.platform === "moralis") {
    const data = await getSolanaTokenPrice(entry.address);
    if (!data) return null;
    return {
      livePrice: data.usdPrice ? Number(data.usdPrice) : null,
      liveVolume: 0,
      pumpData: null,
    };
  }

  return null;
}

// ─────────────────────────────────────────────
// BUY/SELL PRESSURE
// ─────────────────────────────────────────────

async function fetchPressure(entry) {
  try {
    let pressure;
    if (entry.chain === "solana" || entry.platform === "pumpfun" || entry.platform === "moralis") {
      pressure = await getSolanaTokenBuySellPressure(entry.address);
    } else {
      pressure = await getEVMTokenBuySellPressure(entry.address, entry.chain);
    }
    return pressure;
  } catch {
    return { buys: 0, sells: 0, totalTxns: 0, buyPressurePct: null };
  }
}

// ─────────────────────────────────────────────
// DEV WALLET HOLDING
// ─────────────────────────────────────────────

async function fetchDevHoldingPct(entry) {
  if (!entry.devWallet) return null;
  try {
    if (entry.chain === "solana" || entry.platform === "pumpfun") {
      const holders = await getSolanaTopHolders(entry.address);
      const devHolder = holders.find(
        (h) => h.ownerAddress?.toLowerCase() === entry.devWallet.toLowerCase()
      );
      if (!devHolder) return 0;
      return Number(devHolder.percentageRelativeToTotalSupply ?? 0);
    }
    // EVM
    const bal = await getEVMWalletTokenBalance(entry.devWallet, entry.address, entry.chain);
    if (!bal) return 0;
    // Need total supply — approximate from formatted balance + stored devHoldingAtCall ratio
    return null; // Fall back: no reliable total supply reference — skip
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// EMBED BUILDERS
// ─────────────────────────────────────────────

function buildPriceAlertEmbed(entry, livePrice, pctChange, pressure, liveData) {
  const mcapNow = liveData?.marketCap ?? null;
  const mcapEntry = entry.mcapAtCall ?? null;

  const links = [];
  if (entry.dexUrl) links.push(`[Dex](${entry.dexUrl})`);
  if (entry.pumpUrl || entry.platform === "pumpfun") links.push(`[Pump](https://pump.fun/${entry.address})`);

  const lines = [];
  if (mcapEntry && mcapNow) {
    lines.push(`MCap **${fmtUsd(mcapEntry)}** → **${fmtUsd(mcapNow)}**`);
  } else if (mcapNow) {
    lines.push(`MCap **${fmtUsd(mcapNow)}**`);
  }
  if (links.length) lines.push(links.join(" · "));
  lines.push(`\`\`\`${entry.address}\`\`\``);

  const footerParts = [entry.postedBy];
  if (entry.tokenAge) footerParts.push(entry.tokenAge);
  if (entry.postedAt) footerParts.push(`Called ${fmtDate(entry.postedAt)}`);

  return {
    color: 0x00ff88,
    title: `↗ +${pctChange.toFixed(1)}% — ${entry.name} (${entry.symbol})`,
    thumbnail: entry.imageUrl ? { url: entry.imageUrl } : undefined,
    description: lines.filter(Boolean).join("\n"),
    footer: { text: footerParts.join(" · ") },
    timestamp: new Date().toISOString(),
  };
}

function buildMilestoneEmbed(entry, milestone, livePrice, pressure) {
  const links = [];
  if (entry.dexUrl) links.push(`[Dex](${entry.dexUrl})`);
  if (entry.pumpUrl || entry.platform === "pumpfun") links.push(`[Pump](https://pump.fun/${entry.address})`);

  const lines = [
    `💰💰💰💵 **Take Profits** 💵💰💰💰`,
    `${fmtUsd(entry.priceAtCall)} → **${fmtUsd(livePrice)}**`,
  ];
  if (links.length) lines.push(links.join(" · "));
  lines.push(`\`\`\`${entry.address}\`\`\``);

  const footerParts = [entry.postedBy];
  if (entry.tokenAge) footerParts.push(entry.tokenAge);
  if (entry.postedAt) footerParts.push(`Called ${fmtDate(entry.postedAt)}`);

  return {
    color: 0xffd700,
    title: `🎯 ${milestone}x — ${entry.name} (${entry.symbol})`,
    thumbnail: entry.imageUrl ? { url: entry.imageUrl } : undefined,
    description: lines.join("\n"),
    footer: { text: footerParts.join(" · ") },
    timestamp: new Date().toISOString(),
  };
}

function buildDevDumpEmbed(entry, devHoldingPct, dropPct) {
  return {
    color: 0xff0000,
    title: `🚨 Dev Wallet Activity — ${entry.name} (${entry.symbol})`,
    description: [
      `⚠️ Dev wallet holdings dropped significantly.`,
      "",
      `Dev wallet: ${fmtWallet(entry.devWallet)}`,
      `Was holding: **${Number(entry.devHoldingAtCall).toFixed(2)}%**`,
      `Now holding: **${Number(devHoldingPct).toFixed(2)}%**`,
      "",
      `Dropped: **${dropPct.toFixed(1)}%** of their position`,
      "",
      entry.dexUrl ? `[Dex](${entry.dexUrl})` : "",
    ]
      .filter((l) => l !== null)
      .join("\n"),
    footer: { text: `Posted by ${entry.postedBy}` },
    timestamp: new Date().toISOString(),
  };
}

function buildGraduationEmbed(entry, pumpData) {
  return {
    color: 0x00ff88,
    title: `🎓 ${entry.name} (${entry.symbol}) graduated to Raydium!`,
    description: [
      `**${entry.name}** has completed its bonding curve and is now trading on Raydium.`,
      "",
      `Posted by **${entry.postedBy}** · ${fmtTime(entry.postedAt)}`,
      `Entry: ${fmtUsd(entry.priceAtCall)}`,
      "",
      `Now tracking via DexScreener for full price data.`,
    ].join("\n"),
    fields: [
      {
        name: "Final Bonding MCap",
        value: pumpData?.usd_market_cap ? fmtUsd(pumpData.usd_market_cap) : "—",
        inline: true,
      },
      { name: "Chain", value: "SOLANA", inline: true },
    ],
    footer: { text: entry.address },
    timestamp: new Date().toISOString(),
  };
}

function buildBondingAlertEmbed(entry, bondingProgress, pumpData) {
  return {
    color: 0xff9900,
    title: `⚡ ${entry.name} (${entry.symbol}) — ${bondingProgress}% to Raydium`,
    description: [
      `**${entry.name}** is **${bondingProgress}%** through its bonding curve.`,
      "",
      `Getting close to graduation — watch for the Raydium listing.`,
      "",
      `Posted by **${entry.postedBy}**`,
      `MCap now: ${pumpData?.usd_market_cap ? fmtUsd(pumpData.usd_market_cap) : "—"}`,
    ].join("\n"),
    footer: { text: entry.address },
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// MAIN POLL FUNCTION
// ─────────────────────────────────────────────

// User's "x" definition: 1x = 100% gain (price doubled), 2x = 200% (tripled), etc.
// Milestone N fires when currentMultiple >= N + 1  (i.e. price is N+1 times the call price)
const MILESTONES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

/**
 * Poll all tracked tokens once.
 * @param {import('discord.js').Client} client
 * @param {object} db
 * @param {Function} saveDB
 */
async function pollTokens(client, db, saveDB) {
  if (pollRunning) {
    console.log("[Poller] Previous poll still running — skipping this cycle");
    return;
  }
  pollRunning = true;

  try {
  const entries = Object.values(db.tokens ?? {});
  if (entries.length === 0) return;

  console.log(`[Poller] Polling ${entries.length} token(s)…`);

  // ── Backfill missing fields on old entries ──
  for (const entry of entries) {
    let changed = false;
    if (!entry.backfillDone && (!entry.mcapAtCall || !entry.imageUrl)) {
      try {
        const dexData = await fetchTokenDex(entry.address);
        if (dexData) {
          if (!entry.mcapAtCall && dexData.marketCap) {
            db.tokens[entry.address].mcapAtCall = dexData.marketCap;
            changed = true;
          }
          if (!entry.imageUrl && dexData.imageUrl) {
            db.tokens[entry.address].imageUrl = dexData.imageUrl;
            changed = true;
          }
          if (!entry.dexUrl && dexData.dexUrl) {
            db.tokens[entry.address].dexUrl = dexData.dexUrl;
            changed = true;
          }
        }
        // If it's a pump.fun token, add pump URL
        if (!entry.pumpUrl && entry.address.toLowerCase().endsWith("pump")) {
          db.tokens[entry.address].pumpUrl = `https://pump.fun/${entry.address}`;
          changed = true;
        }
        if (changed) await delay(200);
      } catch {}
      // Mark attempted so we don't retry every cycle
      db.tokens[entry.address].backfillDone = true;
    }
    if (changed) {
      console.log(`[Poller] Backfilled missing fields for ${entry.symbol}`);
    }
  }
  saveDB();

  // Fetch SOL price once for this cycle (cached 60s to respect CoinGecko limits)
  let solPriceUsd = null;
  const hasPumpFun = entries.some((e) => e.platform === "pumpfun");
  if (hasPumpFun) {
    solPriceUsd = await fetchSolPriceCached();
    if (solPriceUsd === null) {
      console.warn("[Poller] SOL price unavailable — skipping pump.fun price checks this cycle");
    }
  }

  for (const entry of entries) {
    try {
      // Skip pump.fun price checks if no SOL price
      if (entry.platform === "pumpfun" && solPriceUsd === null) {
        continue;
      }

      const live = await fetchLiveData(entry, solPriceUsd);
      if (!live || live.livePrice == null) {
        console.log(`[Poller] No live data for ${entry.symbol} (${entry.address})`);
        continue;
      }

      const { livePrice, liveVolume, pumpData } = live;

      // ── Fetch pressure (cached 2 min to stay under Moralis 40 req/min) ──
      const pressure = await fetchPressureCached(entry, live.buys24h, live.sells24h);

      const channel = await client.channels.fetch(entry.alertChannelId).catch(() => null);

      // ─────────────────────────────────────────
      // CHECK E — Graduation (pump.fun → Raydium)
      // ─────────────────────────────────────────
      if (entry.platform === "pumpfun" && pumpData?.complete === true && !entry.graduationAlertFired) {
        console.log(`[Poller] 🎓 ${entry.symbol} graduated to Raydium`);
        if (channel) {
          await channel.send({ embeds: [buildGraduationEmbed(entry, pumpData)] }).catch(() => {});
        }
        db.tokens[entry.address].platform = "dexscreener";
        db.tokens[entry.address].graduationAlertFired = true;
        saveDB();
        continue; // Next poll will use DexScreener
      }

      // ─────────────────────────────────────────
      // CHECK F — Bonding Curve 85%
      // ─────────────────────────────────────────
      if (entry.platform === "pumpfun" && pumpData) {
        const bp = Number(pumpData.bonding_curve_progress ?? 0);
        db.tokens[entry.address].bondingProgress = bp;

        if (bp >= 85 && !entry.bondingAlertFired) {
          console.log(`[Poller] ⚡ ${entry.symbol} bonding at ${bp}%`);
          if (channel) {
            await channel.send({ embeds: [buildBondingAlertEmbed(entry, bp, pumpData)] }).catch(() => {});
          }
          db.tokens[entry.address].bondingAlertFired = true;
        } else if (bp < 70 && entry.bondingAlertFired) {
          db.tokens[entry.address].bondingAlertFired = false;
        }
      }

      const priceAtCall = Number(entry.priceAtCall);
      if (!priceAtCall || priceAtCall === 0) {
        // Can't compute multiples — just update price
        db.tokens[entry.address].lastPrice = String(livePrice);
        db.tokens[entry.address].lastChecked = Date.now();
        continue;
      }

      const currentMultiple = livePrice / priceAtCall;
      const pctFromCall = ((livePrice - priceAtCall) / priceAtCall) * 100;

      // ─────────────────────────────────────────
      // FULL RESET — if price drops below call price
      // ─────────────────────────────────────────
      let milestonesFired = entry.milestonesFired ?? [];
      let pctAlertsFired = entry.pctAlertsFired ?? [];

      if (currentMultiple < 1.0) {
        // Price is below entry — reset everything so alerts fire fresh on next pump
        if (milestonesFired.length > 0 || pctAlertsFired.length > 0) {
          console.log(`[Poller] 🔄 ${entry.symbol} dropped below call price — resetting all alerts`);
        }
        milestonesFired = [];
        pctAlertsFired = [];
      }

      // ─────────────────────────────────────────
      // CHECK A — % callouts: +15%, +50%, +75% (each fires once, all reset below call)
      // ─────────────────────────────────────────
      const PCT_THRESHOLDS = [15, 50, 75];
      for (const pct of PCT_THRESHOLDS) {
        if (pctFromCall >= pct && !pctAlertsFired.includes(pct)) {
          console.log(`[Poller] 📈 ${entry.symbol} +${pctFromCall.toFixed(1)}% from call (hit ${pct}% threshold)`);
          if (channel) {
            await channel.send({
              embeds: [buildPriceAlertEmbed(entry, livePrice, pctFromCall, pressure, live)],
            }).catch(() => {});
          }
          pctAlertsFired = [...pctAlertsFired, pct];
        }
      }

      // ─────────────────────────────────────────
      // CHECK B — Milestones (1x=100%, 2x=200%, … 20x=2000% from call)
      // Nx fires when price is (N+1)× the call price.
      // Each fires 💰 TAKE PROFITS card. All reset below call.
      // ─────────────────────────────────────────
      for (const ms of MILESTONES) {
        if (currentMultiple >= ms + 1 && !milestonesFired.includes(ms)) {
          console.log(`[Poller] 🎯 ${entry.symbol} hit ${ms}x (${(ms * 100)}% gain)`);
          if (channel) {
            await channel.send({
              embeds: [buildMilestoneEmbed(entry, ms, livePrice, pressure)],
            }).catch(() => {});
          }
          milestonesFired = [...milestonesFired, ms];
        }
      }

      // ─────────────────────────────────────────
      // CHECK D — Dev Wallet Dump (throttled to every 5 min)
      // ─────────────────────────────────────────
      const timeSinceDevCheck = Date.now() - (entry.lastDevCheck ?? 0);
      if (entry.devWallet && entry.devHoldingAtCall > 0 && timeSinceDevCheck >= DEV_CHECK_INTERVAL) {
        db.tokens[entry.address].lastDevCheck = Date.now();
        const devHoldingPct = await fetchDevHoldingPct(entry);
        await delay(200);

        if (devHoldingPct !== null) {
          const threshold = entry.devHoldingAtCall * 0.8;
          if (devHoldingPct < threshold && !entry.devDumpAlertFired) {
            const dropPct = ((entry.devHoldingAtCall - devHoldingPct) / entry.devHoldingAtCall) * 100;
            console.log(`[Poller] 🚨 Dev dump detected for ${entry.symbol} — dropped ${dropPct.toFixed(1)}%`);
            if (channel) {
              await channel.send({
                embeds: [buildDevDumpEmbed(entry, devHoldingPct, dropPct)],
              }).catch(() => {});
            }
            db.tokens[entry.address].devDumpAlertFired = true;
          } else if (devHoldingPct >= entry.devHoldingAtCall * 0.9 && entry.devDumpAlertFired) {
            db.tokens[entry.address].devDumpAlertFired = false;
          }
          db.tokens[entry.address].devLastKnownHolding = devHoldingPct;
        }
      }

      // ─────────────────────────────────────────
      // Update DB
      // ─────────────────────────────────────────
      db.tokens[entry.address].lastPrice = String(livePrice);
      db.tokens[entry.address].lastVolume = liveVolume;
      db.tokens[entry.address].lastChecked = Date.now();
      db.tokens[entry.address].peakMultiple = Math.max(entry.peakMultiple ?? 1, currentMultiple);
      db.tokens[entry.address].milestonesFired = milestonesFired;
      db.tokens[entry.address].pctAlertsFired = pctAlertsFired;
      if (pressure.buyPressurePct != null) {
        db.tokens[entry.address].buyPressure = Number(pressure.buyPressurePct);
        db.tokens[entry.address].sellPressure = 100 - Number(pressure.buyPressurePct);
      }

      // TODO: First 30 buyers analysis
      // - Fetch first 30 buyer wallets from Moralis
      // - Check if known sniper/bundle bots are present
      // - Flag if >3 snipers in first 30 buyers

      // TODO: Entry/exit zone suggestions
      // - Fetch OHLCV data from Moralis
      // - Calculate basic support/resistance levels
      // - Add to confirmation embed as "Support ~$X / Resistance ~$Y"

    } catch (err) {
      console.error(`[Poller] Error processing ${entry.symbol} (${entry.address}):`, err.message);
    }
  }

  saveDB();
  console.log("[Poller] Poll cycle complete.");

  } finally {
    pollRunning = false;
  }
}

// ─────────────────────────────────────────────
// DAILY SUMMARY
// ─────────────────────────────────────────────

function fmtDateFull() {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/**
 * Build and post the daily summary embed.
 */
async function postDailySummary(client, db) {
  const channelId = process.env.SUMMARY_CHANNEL_ID;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const entries = Object.values(db.tokens ?? {});
  const watchlistCount = Object.keys(db.watchlist ?? {}).length;

  // Fetch SOL price for pump.fun tokens (cached)
  let solPriceUsd = null;
  if (entries.some((e) => e.platform === "pumpfun")) {
    solPriceUsd = await fetchSolPriceCached();
  }

  // Fetch live prices
  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        if (entry.platform === "pumpfun") {
          const pumpData = await fetchPumpFunToken(entry.address);
          const livePrice = calculatePumpFunPrice(pumpData, solPriceUsd);
          const bp = pumpData?.bonding_curve_progress ?? null;
          return { entry, livePrice, bondingProgress: bp };
        }
        if (entry.platform === "dexscreener") {
          const data = await fetchTokenDex(entry.address);
          return { entry, livePrice: data?.price ? Number(data.price) : null };
        }
        if (entry.platform === "moralis") {
          const data = await getSolanaTokenPrice(entry.address);
          return { entry, livePrice: data?.usdPrice ? Number(data.usdPrice) : null };
        }
        return { entry, livePrice: null };
      } catch {
        return { entry, livePrice: null };
      }
    })
  );

  const winners = [];
  const losers = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { entry, livePrice } = result.value;

    if (livePrice == null || !Number(entry.priceAtCall)) continue;

    const multiple = livePrice / Number(entry.priceAtCall);
    const pct = (multiple - 1) * 100;
    const row = { entry, livePrice, multiple, pct };
    if (multiple >= 1) winners.push(row);
    else losers.push(row);
  }

  // Top 5 gainers (desc), worst 3 losers (asc)
  winners.sort((a, b) => b.multiple - a.multiple);
  losers.sort((a, b) => a.multiple - b.multiple);
  const topGainers = winners.slice(0, 5);
  const topLosers = losers.slice(0, 3);

  const fmtRow = (r, up) => {
    const pctStr = up ? `+${r.pct.toFixed(0)}%` : `${r.pct.toFixed(0)}%`;
    const emoji = r.multiple >= 2 ? "🚀" : up ? "📈" : "📉";
    return `${emoji} **${r.entry.name} (${r.entry.symbol})** ${pctStr} · ${r.entry.postedBy}`;
  };

  const descParts = [];
  if (topGainers.length) {
    descParts.push("🟢 **Top Gainers**");
    descParts.push(...topGainers.map((r) => fmtRow(r, true)));
  }
  if (topLosers.length) {
    descParts.push("");
    descParts.push("🔴 **Biggest Losses**");
    descParts.push(...topLosers.map((r) => fmtRow(r, false)));
  }

  if (descParts.length === 0) descParts.push("No tokens tracked yet.");

  const embed = {
    color: 0x5865f2,
    title: `📊 Daily Recap — ${fmtDateFull()}`,
    description: descParts.join("\n"),
    footer: { text: `${entries.length} tokens · ${watchlistCount} wallets watched` },
    timestamp: new Date().toISOString(),
  };

  await channel.send({ embeds: [embed] }).catch((err) => {
    console.error("[Poller] Failed to send daily summary:", err.message);
  });
  console.log("[Poller] Daily summary posted.");
}

/**
 * Run expiry sweep — remove tokens older than 28 days.
 */
async function runExpirySweep(client, db, saveDB) {
  const cutoff = Date.now() - 28 * 24 * 60 * 60 * 1000;
  const expired = Object.values(db.tokens ?? {}).filter((e) => e.postedAt < cutoff);

  if (expired.length === 0) return;

  for (const entry of expired) {
    try {
      const channel = await client.channels.fetch(entry.alertChannelId).catch(() => null);
      if (channel) {
        await channel.send({
          embeds: [
            {
              color: 0x888888,
              title: `🗑️ Expired — ${entry.name} (${entry.symbol})`,
              description: [
                `Token tracking expired after 28 days.`,
                "",
                `Entry: ${fmtUsd(entry.priceAtCall)}`,
                `Last price: ${fmtUsd(entry.lastPrice)}`,
                `Peak: ${fmtMultiple(entry.peakMultiple ?? 1)}`,
                `Posted by: **${entry.postedBy}**`,
              ].join("\n"),
              footer: { text: entry.address },
            },
          ],
        }).catch(() => {});
      }
      delete db.tokens[entry.address];
      console.log(`[Poller] Expired ${entry.symbol} (${entry.address})`);
    } catch (err) {
      console.error(`[Poller] Expiry error for ${entry.address}:`, err.message);
    }
  }

  console.log(`[Poller] Expiry sweep removed ${expired.length} token(s).`);
  saveDB();
}

module.exports = {
  pollTokens,
  postDailySummary,
  runExpirySweep,
  fmtUsd,
  fmtTime,
  fmtMultiple,
  fmtDate,
  fmtWallet,
  fmtPressure,
};
