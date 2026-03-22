"use strict";

require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const { fetchTokenDex } = require("./dexscreener.js");
const { fetchPumpFunToken, fetchSolPrice, calculatePumpFunPrice } = require("./pumpfun.js");
const {
  getSolanaTokenMetadata,
  getSolanaTokenBuySellPressure,
  getSolanaTopHolders,
  getSolanaTokenCreator,
  getEVMTokenBuySellPressure,
  getEVMDevWallet,
  delay,
} = require("./moralis.js");
const {
  pollTokens,
  postDailySummary,
  runExpirySweep,
  fmtUsd,
  fmtTime,
  fmtMultiple,
  fmtWallet,
  fmtPressure,
} = require("./poller.js");
const { pollWatchlist } = require("./walletWatcher.js");

// ─────────────────────────────────────────────
// DB
// ─────────────────────────────────────────────

const DB_PATH = path.join(__dirname, "tracked.json");

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return { tokens: {}, watchlist: {} };
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { tokens: {}, watchlist: {} };
  }
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

const db = loadDB();

// ─────────────────────────────────────────────
// DISCORD CLIENT
// ─────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─────────────────────────────────────────────
// SLASH COMMAND DEFINITIONS
// ─────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("calls")
    .setDescription("Show all tracked tokens with current multiple and buy pressure"),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a token from tracking")
    .addStringOption((opt) =>
      opt.setName("address").setDescription("Contract address").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Add a wallet to the watchlist")
    .addStringOption((opt) =>
      opt.setName("wallet").setDescription("Wallet address").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("label").setDescription("Optional label").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("unwatch")
    .setDescription("Remove a wallet from the watchlist")
    .addStringOption((opt) =>
      opt.setName("wallet").setDescription("Wallet address").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("watchlist")
    .setDescription("Show all watched wallets"),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log("[Bot] Registering slash commands…");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("[Bot] Slash commands registered.");
  } catch (err) {
    console.error("[Bot] Failed to register commands:", err.message);
  }
}

// ─────────────────────────────────────────────
// ADDRESS DETECTION
// ─────────────────────────────────────────────

const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const SOL_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

function extractAddresses(text) {
  const evm = text.match(EVM_RE) ?? [];
  const sol = text.match(SOL_RE) ?? [];
  // Deduplicate
  return [...new Set([...evm.map((a) => a.toLowerCase()), ...sol.map((a) => a.toLowerCase())])];
}

function isEvmAddress(addr) {
  return /^0x[0-9a-f]{40}$/.test(addr);
}

// ─────────────────────────────────────────────
// TOKEN AGE FLAG
// ─────────────────────────────────────────────

function getTokenAgeFlag(createdAtMs) {
  if (!createdAtMs) return { flag: null, label: "unknown age" };
  const ageMs = Date.now() - createdAtMs;
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours < 1) return { flag: "🔥", label: "< 1h old" };
  if (ageHours < 24) return { flag: "⚡", label: `${Math.floor(ageHours)}h old` };
  const ageDays = Math.floor(ageHours / 24);
  return { flag: null, label: `${ageDays}d old` };
}

// ─────────────────────────────────────────────
// CONFIRMATION EMBED
// ─────────────────────────────────────────────

function buildConfirmEmbed(data) {
  const {
    name, symbol, chain, platform, marketCap,
    postedBy, tokenAge,
    dexUrl, pumpUrl, imageUrl, address,
  } = data;

  const links = [];
  if (dexUrl) links.push(`[Dex](${dexUrl})`);
  if (pumpUrl) links.push(`[Pump](${pumpUrl})`);

  const lines = [];
  if (marketCap) lines.push(`MCap **${fmtUsd(marketCap)}**`);
  if (links.length) lines.push(links.join(" · "));
  if (address) lines.push(`\`\`\`${address}\`\`\``);

  return {
    color: 0x00ccff,
    title: `📡 ${name} (${symbol})`,
    thumbnail: imageUrl ? { url: imageUrl } : undefined,
    description: lines.filter(Boolean).join("\n"),
    footer: { text: `${postedBy} · ${tokenAge} · ${chain}` },
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// DUPLICATE CA EMBED
// ─────────────────────────────────────────────

function buildDuplicateEmbed(existing, address) {
  return {
    color: 0xffaa00,
    description: `👀 Already tracking **${existing.name} (${existing.symbol})** — first posted by **${existing.postedBy}** ${fmtTime(existing.postedAt)} in <#${existing.alertChannelId}>`,
    footer: { text: address },
  };
}

// ─────────────────────────────────────────────
// TRACK A TOKEN
// ─────────────────────────────────────────────

/**
 * Full tracking flow for a detected address.
 * Runs in background (fire and forget from messageCreate).
 */
async function trackAddress(address, message) {
  const lowerAddr = address.toLowerCase();
  const postedBy = message.author.username;
  const postedByUserId = message.author.id;
  const guildId = message.guildId;
  const channelId = message.channelId;

  // ── Duplicate check ──
  if (db.tokens[lowerAddr]) {
    const existing = db.tokens[lowerAddr];
    if (existing.alertChannelId !== channelId) {
      await message.channel.send({ embeds: [buildDuplicateEmbed(existing, lowerAddr)] }).catch(() => {});
    }
    console.log(`[Bot] Duplicate CA skipped: ${lowerAddr}`);
    return;
  }

  console.log(`[Bot] Detected address: ${address} from ${postedBy}`);

  let tokenData = null;
  let platform = null;

  // Detect likely pump.fun addresses (end with "pump")
  const isPumpAddress = /pump$/i.test(address);

  // ── Step 1a: If pump.fun address, try pump.fun FIRST ──
  if (isPumpAddress) {
    const solPrice = await fetchSolPrice();
    const pumpData = await fetchPumpFunToken(address);
    if (pumpData && pumpData.name) {
      const price = calculatePumpFunPrice(pumpData, solPrice);
      tokenData = {
        name: pumpData.name,
        symbol: pumpData.symbol,
        chain: "solana",
        price: price,
        marketCap: pumpData.usd_market_cap,
        volume24h: 0,
        buys24h: 0,
        sells24h: 0,
        dexUrl: null,
        pumpUrl: `https://pump.fun/${address}`,
        imageUrl: pumpData.image_uri,
        pairCreatedAt: pumpData.created_timestamp
          ? pumpData.created_timestamp * 1000
          : null,
        bondingProgress: pumpData.bonding_curve_progress,
        complete: pumpData.complete,
        creator: pumpData.creator,
      };
      platform = "pumpfun";
      console.log(`[Bot] Found on pump.fun (priority): ${pumpData.name}`);
    }
  }

  // ── Step 1b: Try DexScreener ──
  if (!tokenData) {
    const dexData = await fetchTokenDex(address);
    if (dexData) {
      tokenData = dexData;
      platform = "dexscreener";
      console.log(`[Bot] Found on DexScreener: ${dexData.name}`);
    }
  }

  // ── Step 2: Try pump.fun (for non-pump addresses that DexScreener missed) ──
  if (!tokenData && !isPumpAddress) {
    const solPrice = await fetchSolPrice();
    const pumpData = await fetchPumpFunToken(address);
    if (pumpData && pumpData.name) {
      const price = calculatePumpFunPrice(pumpData, solPrice);
      tokenData = {
        name: pumpData.name,
        symbol: pumpData.symbol,
        chain: "solana",
        price: price,
        marketCap: pumpData.usd_market_cap,
        volume24h: 0,
        buys24h: 0,
        sells24h: 0,
        dexUrl: null,
        pumpUrl: `https://pump.fun/${address}`,
        imageUrl: pumpData.image_uri,
        pairCreatedAt: pumpData.created_timestamp
          ? pumpData.created_timestamp * 1000
          : null,
        bondingProgress: pumpData.bonding_curve_progress,
        complete: pumpData.complete,
        creator: pumpData.creator,
      };
      platform = "pumpfun";
      console.log(`[Bot] Found on pump.fun: ${pumpData.name}`);
    }
  }

  // ── Step 3: Try Moralis (Solana metadata) ──
  if (!tokenData) {
    await delay(200);
    const meta = await getSolanaTokenMetadata(address);
    if (meta && (meta.name || meta.symbol)) {
      tokenData = {
        name: meta.name ?? "Unknown",
        symbol: meta.symbol ?? "???",
        chain: "solana",
        price: null,
        marketCap: meta.fullyDilutedValuation ?? null,
        volume24h: 0,
        dexUrl: null,
        pumpUrl: null,
        imageUrl: null,
        pairCreatedAt: null,
      };
      platform = "moralis";
      console.log(`[Bot] Found via Moralis: ${meta.name}`);
    }
  }

  // ── Not found ──
  if (!tokenData || !platform) {
    console.log(`[Bot] Address not recognised as a token — skipping: ${address}`);
    return;
  }

  // ── Token age ──
  const ageResult = getTokenAgeFlag(tokenData.pairCreatedAt);
  const tokenAge = [ageResult.flag, ageResult.label].filter(Boolean).join(" ");

  // ── Buy/sell pressure ──
  await delay(200);
  let pressure = { buys: 0, sells: 0, totalTxns: 0, buyPressurePct: null };
  try {
    if (platform === "pumpfun" || platform === "moralis" || tokenData.chain === "solana") {
      pressure = await getSolanaTokenBuySellPressure(address);
    } else {
      pressure = await getEVMTokenBuySellPressure(address, tokenData.chain);
    }
  } catch (err) {
    console.warn(`[Bot] Pressure fetch failed: ${err.message}`);
  }

  // Fallback: use DexScreener buys/sells if Moralis returned no data
  if (pressure.buyPressurePct == null && platform === "dexscreener") {
    const dexBuys = Number(tokenData.buys24h ?? 0);
    const dexSells = Number(tokenData.sells24h ?? 0);
    const dexTotal = dexBuys + dexSells;
    if (dexTotal > 0) {
      pressure = {
        buys: dexBuys,
        sells: dexSells,
        totalTxns: dexTotal,
        buyPressurePct: ((dexBuys / dexTotal) * 100).toFixed(0),
      };
    }
  }

  // ── Dev wallet ──
  await delay(200);
  let devWallet = null;
  let devHoldingPct = 0;

  try {
    if (platform === "pumpfun" && tokenData.creator) {
      devWallet = tokenData.creator;
      // Get holding from top holders
      const holders = await getSolanaTopHolders(address);
      const devHolder = holders.find(
        (h) => h.ownerAddress?.toLowerCase() === devWallet.toLowerCase()
      );
      devHoldingPct = devHolder
        ? Number(devHolder.percentageRelativeToTotalSupply ?? 0)
        : 0;
    } else if (platform === "moralis") {
      devWallet = await getSolanaTokenCreator(address);
      if (devWallet) {
        const holders = await getSolanaTopHolders(address);
        const devHolder = holders.find(
          (h) => h.ownerAddress?.toLowerCase() === devWallet.toLowerCase()
        );
        devHoldingPct = devHolder
          ? Number(devHolder.percentageRelativeToTotalSupply ?? 0)
          : 0;
      }
    } else if (isEvmAddress(address)) {
      const devInfo = await getEVMDevWallet(address, tokenData.chain);
      if (devInfo) {
        devWallet = devInfo.ownerAddress ?? devInfo.address ?? null;
      }
    }
  } catch (err) {
    console.warn(`[Bot] Dev wallet fetch failed: ${err.message}`);
  }

  // ── Build DB entry ──
  const messageUrl = `https://discord.com/channels/${guildId}/${channelId}/${message.id}`;

  const entry = {
    address: lowerAddr,
    name: tokenData.name,
    symbol: tokenData.symbol,
    chain: tokenData.chain ?? "unknown",
    platform,
    postedBy,
    postedByUserId,
    postedAt: Date.now(),
    tokenAge,
    calledInGuild: guildId,
    alertChannelId: channelId,
    priceAtCall: tokenData.price != null ? String(tokenData.price) : null,
    volumeAtCall: tokenData.volume24h ?? 0,
    lastPrice: tokenData.price != null ? String(tokenData.price) : null,
    lastVolume: tokenData.volume24h ?? 0,
    lastChecked: Date.now(),
    peakMultiple: 1.0,
    milestonesFired: [],
    pctAlertsFired: [],
    messageUrl,
    devWallet: devWallet ?? null,
    devHoldingAtCall: devHoldingPct,
    devLastKnownHolding: devHoldingPct,
    devDumpAlertFired: false,
    buyPressure: pressure.buyPressurePct != null ? Number(pressure.buyPressurePct) : null,
    sellPressure: pressure.buyPressurePct != null ? 100 - Number(pressure.buyPressurePct) : null,
    mcapAtCall: tokenData.marketCap ?? null,
    dexUrl: tokenData.dexUrl ?? null,
    pumpUrl: tokenData.pumpUrl ?? null,
    imageUrl: tokenData.imageUrl ?? null,
    bondingProgress: tokenData.bondingProgress ?? 0,
    graduationAlertFired: tokenData.complete === true,
    bondingAlertFired: false,
  };

  db.tokens[lowerAddr] = entry;
  saveDB();

  console.log(`[Bot] Now tracking ${tokenData.name} (${tokenData.symbol}) — ${platform}`);

  // ── Post confirmation embed ──
  const embed = buildConfirmEmbed({
    name: tokenData.name,
    symbol: tokenData.symbol,
    chain: tokenData.chain ?? "unknown",
    platform,
    price: tokenData.price,
    marketCap: tokenData.marketCap,
    volume: tokenData.volume24h,
    postedBy,
    tokenAge,
    buyPressurePct: pressure.buyPressurePct,
    devWallet,
    devHoldingPct,
    dexUrl: tokenData.dexUrl,
    pumpUrl: tokenData.pumpUrl,
    bondingProgress: tokenData.bondingProgress,
    imageUrl: tokenData.imageUrl,
    address: lowerAddr,
  });

  await message.channel.send({ embeds: [embed] }).catch((err) => {
    console.error("[Bot] Failed to send confirmation embed:", err.message);
  });
}

// ─────────────────────────────────────────────
// MESSAGE CREATE — address detection
// ─────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content) return;

  const addresses = extractAddresses(message.content);
  if (addresses.length === 0) return;

  // Fire and forget — do not await, catch errors silently
  for (const address of addresses) {
    trackAddress(address, message).catch((err) => {
      console.error(`[Bot] trackAddress error for ${address}:`, err.message);
    });
  }
});

// ─────────────────────────────────────────────
// SLASH COMMAND HANDLER
// ─────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /calls ──
  if (commandName === "calls") {
    const entries = Object.values(db.tokens ?? {});
    if (entries.length === 0) {
      await interaction.reply({ content: "No tokens being tracked yet.", ephemeral: true });
      return;
    }

    const lines = entries.map((e) => {
      const multiple = e.lastPrice && e.priceAtCall
        ? Number(e.lastPrice) / Number(e.priceAtCall)
        : null;
      const emoji = multiple == null ? "❓" : multiple >= 2 ? "🚀" : multiple >= 1 ? "📈" : "📉";
      const multipleStr = multiple != null ? ` — ${fmtMultiple(multiple)}` : "";
      const buy = Number(e.buyPressure ?? 50);
      const indicator = buy >= 60 ? "🟢" : buy <= 40 ? "🔴" : "🟡";
      return `${emoji} **${e.name} (${e.symbol})**${multipleStr} · ${e.postedBy} · ${indicator}${buy}% buys`;
    });

    const embed = {
      color: 0x5865f2,
      title: "📋 Tracked Tokens",
      description: lines.join("\n"),
      footer: { text: `${entries.length} token(s) tracked` },
    };

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // ── /remove ──
  if (commandName === "remove") {
    const address = interaction.options.getString("address", true).toLowerCase();
    if (!db.tokens[address]) {
      await interaction.reply({ content: `❌ Not tracking \`${address}\`.`, ephemeral: true });
      return;
    }
    const name = db.tokens[address].name;
    delete db.tokens[address];
    saveDB();
    await interaction.reply({ content: `✅ Removed **${name}** (\`${address}\`) from tracking.` });
    console.log(`[Bot] Removed ${address} by ${interaction.user.username}`);
    return;
  }

  // ── /watch ──
  if (commandName === "watch") {
    const wallet = interaction.options.getString("wallet", true);
    const labelInput = interaction.options.getString("label") ?? null;
    const walletLower = wallet.toLowerCase();
    const label = labelInput ?? fmtWallet(wallet);

    // Validate address format
    const isEvm = /^0x[0-9a-fA-F]{40}$/.test(wallet);
    const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet);
    if (!isEvm && !isSol) {
      await interaction.reply({ content: "❌ Invalid wallet address format.", ephemeral: true });
      return;
    }

    db.watchlist[walletLower] = {
      address: walletLower,
      label,
      addedBy: interaction.user.username,
      addedAt: Date.now(),
      alertChannelId: interaction.channelId,
      lastSeenTx: null,
    };
    saveDB();

    await interaction.reply({
      content: `👁️ Now watching wallet **${label}** — you'll be pinged when it buys something.`,
    });
    console.log(`[Bot] Watching wallet ${wallet} (${label})`);
    return;
  }

  // ── /unwatch ──
  if (commandName === "unwatch") {
    const wallet = interaction.options.getString("wallet", true).toLowerCase();
    if (!db.watchlist[wallet]) {
      await interaction.reply({ content: `❌ Wallet \`${wallet}\` not in watchlist.`, ephemeral: true });
      return;
    }
    const label = db.watchlist[wallet].label;
    delete db.watchlist[wallet];
    saveDB();
    await interaction.reply({ content: `✅ Removed wallet **${label}** from watchlist.` });
    return;
  }

  // ── /watchlist ──
  if (commandName === "watchlist") {
    const wallets = Object.values(db.watchlist ?? {});
    if (wallets.length === 0) {
      await interaction.reply({ content: "No wallets being watched.", ephemeral: true });
      return;
    }

    const lines = wallets.map((w) => {
      const ago = fmtTime(w.addedAt);
      return `👁️ **${w.label}** — added by ${w.addedBy} ${ago}`;
    });

    const embed = {
      color: 0x9b59b6,
      title: "👁️ Wallet Watchlist",
      description: lines.join("\n"),
      footer: { text: `${wallets.length} wallet(s) being watched` },
    };

    await interaction.reply({ embeds: [embed] });
    return;
  }
});

// ─────────────────────────────────────────────
// CRON JOBS
// ─────────────────────────────────────────────

function scheduleDailySummary() {
  cron.schedule("0 9 * * *", async () => {
    console.log("[Cron] Daily summary firing…");
    await postDailySummary(client, db).catch((err) => {
      console.error("[Cron] Daily summary error:", err.message);
    });
  }, { timezone: "UTC" });
}

function scheduleExpirySweep() {
  cron.schedule("5 9 * * *", async () => {
    console.log("[Cron] Expiry sweep firing…");
    await runExpirySweep(client, db, saveDB).catch((err) => {
      console.error("[Cron] Expiry sweep error:", err.message);
    });
  }, { timezone: "UTC" });
}

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────

// How often we poll tracked tokens for price changes.
// Note: faster polling increases API load/rate-limit risk.
const POLL_INTERVAL_MS = 15 * 1000;      // 15 seconds
const WATCH_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes

client.once("ready", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);

  // Immediate + interval polls
  pollTokens(client, db, saveDB).catch(console.error);
  setInterval(() => {
    pollTokens(client, db, saveDB).catch(console.error);
  }, POLL_INTERVAL_MS);

  pollWatchlist(client, db, saveDB).catch(console.error);
  setInterval(() => {
    pollWatchlist(client, db, saveDB).catch(console.error);
  }, WATCH_INTERVAL_MS);
});

async function main() {
  await registerCommands();
  scheduleDailySummary();
  scheduleExpirySweep();
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((err) => {
  console.error("[Bot] Fatal startup error:", err);
  process.exit(1);
});
