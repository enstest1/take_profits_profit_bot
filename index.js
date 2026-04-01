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

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.dirname(new URL(import.meta.url).pathname);
const DB_PATH = path.join(DATA_DIR, 'tracked.json');

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

async function fetchRugCheckReport(address) {
  try {
    const headers = {};
    if (process.env.RUGCHECK_API_KEY) {
      headers.Authorization = 'Bearer ' + process.env.RUGCHECK_API_KEY;
    }
    const res = await fetch('https://api.rugcheck.xyz/v1/tokens/' + address + '/report', {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchBitqueryBundleSignals(address) {
  if (!process.env.BITQUERY_API_KEY) {
    return { available: false, reason: 'BITQUERY_API_KEY missing' };
  }

  const query =
    'query ($mint: String!) {' +
    ' Solana {' +
    '   DEXTrades(' +
    '     limit: {count: 200}' +
    '     orderBy: {descending: Block_Time}' +
    '     where: {' +
    '       Transaction: {Result: {Success: true}},' +
    '       Trade: {Buy: {Currency: {MintAddress: {is: $mint}}}}' +
    '     }' +
    '   ) {' +
    '     Block { Time }' +
    '     Trade { Buy { Amount Account { Address } } }' +
    '   }' +
    ' }' +
    '}';

  try {
    const res = await fetch('https://streaming.bitquery.io/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.BITQUERY_API_KEY,
      },
      body: JSON.stringify({ query, variables: { mint: address } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { available: false, reason: 'Bitquery HTTP ' + res.status };
    const json = await res.json();
    const rows = json?.data?.Solana?.DEXTrades || [];
    if (rows.length === 0) {
      return {
        available: true,
        totalTrades: 0,
        uniqueBuyers: 0,
        top5SharePct: 0,
        burstPct: 0,
        highBurstBuckets: 0,
        riskLabel: 'Low',
        riskScore: 0,
        reasons: ['No recent buy trades found in sample window'],
      };
    }

    const buyerAmount = new Map();
    const perSecond = new Map();
    let totalAmount = 0;

    for (const row of rows) {
      const buyer = row?.Trade?.Buy?.Account?.Address;
      const amount = Number(row?.Trade?.Buy?.Amount || 0);
      const time = row?.Block?.Time;
      if (buyer) {
        buyerAmount.set(buyer, (buyerAmount.get(buyer) || 0) + (isNaN(amount) ? 0 : amount));
      }
      if (!isNaN(amount)) totalAmount += amount;
      if (time) {
        const sec = String(time).slice(0, 19);
        perSecond.set(sec, (perSecond.get(sec) || 0) + 1);
      }
    }

    const totalTrades = rows.length;
    const uniqueBuyers = buyerAmount.size;
    const amounts = Array.from(buyerAmount.values()).sort((a, b) => b - a);
    const top5Amount = amounts.slice(0, 5).reduce((s, n) => s + n, 0);
    const top5SharePct = totalAmount > 0 ? (top5Amount / totalAmount) * 100 : 0;

    const secondCounts = Array.from(perSecond.values());
    const maxBurst = secondCounts.length ? Math.max(...secondCounts) : 0;
    const burstPct = totalTrades > 0 ? (maxBurst / totalTrades) * 100 : 0;
    const highBurstBuckets = secondCounts.filter((n) => n >= 3).length;

    let riskScore = 0;
    const reasons = [];

    if (top5SharePct >= 60) {
      riskScore += 45;
      reasons.push('Top 5 buyers control ' + top5SharePct.toFixed(1) + '% of sampled buy flow');
    } else if (top5SharePct >= 45) {
      riskScore += 30;
      reasons.push('Top 5 buyers control ' + top5SharePct.toFixed(1) + '% of sampled buy flow');
    } else if (top5SharePct >= 35) {
      riskScore += 15;
      reasons.push('Moderate buyer concentration (' + top5SharePct.toFixed(1) + '% in top 5)');
    }

    if (totalTrades >= 50 && uniqueBuyers <= 25) {
      riskScore += 20;
      reasons.push('Low wallet diversity for trade volume (' + uniqueBuyers + ' buyers / ' + totalTrades + ' buys)');
    } else if (totalTrades >= 50 && uniqueBuyers <= 40) {
      riskScore += 10;
      reasons.push('Buyer diversity below ideal (' + uniqueBuyers + ' buyers / ' + totalTrades + ' buys)');
    }

    if (burstPct >= 20) {
      riskScore += 20;
      reasons.push('Heavy same-second burst activity (' + burstPct.toFixed(1) + '% in peak second)');
    } else if (burstPct >= 12) {
      riskScore += 12;
      reasons.push('Notable burst activity (' + burstPct.toFixed(1) + '% in peak second)');
    }

    if (highBurstBuckets >= 5) {
      riskScore += 15;
      reasons.push('Multiple synchronized buy clusters (' + highBurstBuckets + ' seconds with 3+ buys)');
    } else if (highBurstBuckets >= 2) {
      riskScore += 8;
      reasons.push('Some synchronized buy clusters (' + highBurstBuckets + ' seconds with 3+ buys)');
    }

    let riskLabel = 'Low';
    if (riskScore >= 60) riskLabel = 'High';
    else if (riskScore >= 35) riskLabel = 'Medium';

    return {
      available: true,
      totalTrades,
      uniqueBuyers,
      top5SharePct,
      burstPct,
      highBurstBuckets,
      riskLabel,
      riskScore,
      reasons,
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
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
      opt.setName('address').setDescription('Solana token mint address').setRequired(true)
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
  const address = interaction.options.getString('address').trim();

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return interaction.editReply('❌ Invalid Solana mint address.');
  }

  const [rugRes, bundleRes, tokenRes] = await Promise.allSettled([
    fetchRugCheckReport(address),
    fetchBitqueryBundleSignals(address),
    fetchTokenData(address),
  ]);

  const rug = rugRes.status === 'fulfilled' ? rugRes.value : null;
  const bundle = bundleRes.status === 'fulfilled' ? bundleRes.value : null;
  const token = tokenRes.status === 'fulfilled' ? tokenRes.value : null;

  const name = token?.name || rug?.tokenMeta?.name || rug?.name || address.slice(0, 8) + '...';
  const symbol = token?.symbol || rug?.tokenMeta?.symbol || 'SOL';

  const desc = [];
  let highRisk = false;
  let medRisk = false;

  if (rug) {
    const normScore = rug.score_normalised ?? rug.score_normalized ?? null;
    const rugged = rug.rugged === true;
    const liq = rug.totalMarketLiquidity;
    const risks = (rug.risks || []).slice(0, 5);

    const riskLine = normScore !== null
      ? '🛡️ **RugCheck score:** ' + normScore + '/100' + (rugged ? ' · 🔴 Rugged' : '')
      : '🛡️ **RugCheck data loaded**' + (rugged ? ' · 🔴 Rugged' : '');
    desc.push(riskLine);
    desc.push('💧 Liquidity: **' + fmtUsd(liq) + '**');

    if (risks.length > 0) {
      const riskLines = risks.map((r) => {
        const level = String(r.level || '').toLowerCase();
        const emoji = level === 'danger' ? '🔴' : level === 'warn' ? '🟠' : '🟢';
        return emoji + ' ' + (r.name || 'Unknown risk');
      });
      desc.push('⚠️ Top risks:\n' + riskLines.join('\n'));
    } else {
      desc.push('✅ No major RugCheck flags in top risks');
    }

    if (rugged || (typeof normScore === 'number' && normScore >= 70)) highRisk = true;
    else if (typeof normScore === 'number' && normScore >= 40) medRisk = true;
  } else {
    desc.push('🛡️ RugCheck: unavailable right now');
  }

  desc.push('');

  if (bundle?.available) {
    const bundleBadge =
      bundle.riskLabel === 'High' ? '🔴 High' :
      bundle.riskLabel === 'Medium' ? '🟠 Medium' : '🟢 Low';
    desc.push('🧩 **Bundle Risk:** ' + bundleBadge + ' (' + bundle.riskScore + '/100)');
    desc.push(
      '📊 Sample: **' + bundle.totalTrades + '** buys · **' +
      bundle.uniqueBuyers + '** buyers · top5 flow **' + bundle.top5SharePct.toFixed(1) + '%**'
    );
    desc.push(
      '⚡ Peak same-second burst: **' + bundle.burstPct.toFixed(1) +
      '%** · clustered seconds (3+ buys): **' + bundle.highBurstBuckets + '**'
    );
    if (bundle.reasons?.length) {
      desc.push('🔎 Evidence:\n' + bundle.reasons.slice(0, 3).map((r) => '• ' + r).join('\n'));
    }

    if (bundle.riskLabel === 'High') highRisk = true;
    else if (bundle.riskLabel === 'Medium') medRisk = true;
  } else {
    desc.push('🧩 Bundle Risk: unavailable (' + (bundle?.reason || 'no data') + ')');
  }

  const color = highRisk ? 0xff3b30 : medRisk ? 0xffa500 : 0x00c853;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🧪 /rug — ' + name + ' (' + symbol + ')')
    .setDescription(desc.join('\n').slice(0, 4000))
    .addFields({ name: 'Mint', value: '`' + address + '`' })
    .setFooter({ text: 'RugCheck + Bitquery heuristics (signals, not certainty)' })
    .setTimestamp();

  if (token?.imageUrl) embed.setThumbnail(token.imageUrl);
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
