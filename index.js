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

// DB
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

// Format helpers
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
  if (!createdAtMs) return { flag: null, label: 'unknown age' };
  const ageHours = (Date.now() - createdAtMs) / 3600000;
  if (ageHours < 1) return { flag: '🔥', label: '< 1h old' };
  if (ageHours < 24) return { flag: '⚡', label: Math.floor(ageHours) + 'h old' };
  return { flag: null, label: Math.floor(ageHours / 24) + 'd old' };
}

// Extract and deduplicate addresses from message text
function extractAddresses(text) {
  const found = new Set();

  const evmMatches = text.match(/\b0x[a-fA-F0-9]{40}\b/g) || [];
  for (const addr of evmMatches) {
    found.add(addr.toLowerCase());
  }

  const solanaMatches = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [];
  for (const addr of solanaMatches) {
    if (addr.length < 32) continue;
    if (/\d/.test(addr) && !/[0OIl]/.test(addr)) {
      found.add(addr);
    }
  }

  return Array.from(found);
}

// Birdeye token overview — single call gives price, mcap, volume, liquidity, age, buys/sells
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
      fdv: d.fdv || null,
      liquidity: d.liquidity || null,
      volume24h: d.v24hUSD || d.v24h || null,
      volume1h: d.v1hUSD || d.v1h || null,
      priceChange24h: d.priceChange24hPercent || null,
      priceChange1h: d.priceChange1hPercent || null,
      buys24h: d.buy24h || null,
      sells24h: d.sell24h || null,
      uniqueWallets24h: d.uniqueWallet24h || null,
      createdAt: d.createdAt || null,
      name: d.name || null,
      symbol: d.symbol || null,
      logoURI: d.logoURI || null,
      extensions: d.extensions || null,
    };
  } catch (e) {
    console.error('[birdeye] failed for ' + address + ':', e.message);
    return null;
  }
}

// Pump.fun for pre-graduation tokens
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

// Fetch token data — Birdeye first, fallback to pump.fun
async function fetchTokenData(address) {

  // Try Birdeye first — covers both graduated and many pre-graduation tokens
  const birdeye = await fetchBirdeye(address);
  if (birdeye && birdeye.price) {
    return {
      platform: 'birdeye',
      name: birdeye.name,
      symbol: birdeye.symbol,
      chain: 'solana',
      price: birdeye.price ? String(birdeye.price) : null,
      marketCap: birdeye.marketCap,
      fdv: birdeye.fdv,
      liquidity: birdeye.liquidity,
      volume24h: birdeye.volume24h,
      volume1h: birdeye.volume1h,
      priceChange1h: birdeye.priceChange1h,
      priceChange24h: birdeye.priceChange24h,
      buys24h: birdeye.buys24h,
      sells24h: birdeye.sells24h,
      uniqueWallets24h: birdeye.uniqueWallets24h,
      dexUrl: 'https://birdeye.so/token/' + address + '?chain=solana',
      imageUrl: birdeye.logoURI || null,
      pairCreatedAt: birdeye.createdAt ? birdeye.createdAt * 1000 : null,
    };
  }

  // Fallback to pump.fun for pre-graduation tokens Birdeye doesn't have yet
  const pump = await fetchPumpFun(address);
  if (pump) {
    return {
      platform: 'pumpfun',
      name: pump.name,
      symbol: pump.symbol,
      chain: 'solana',
      price: null,
      marketCap: pump.usd_market_cap || 0,
      fdv: null,
      liquidity: null,
      volume24h: null,
      volume1h: null,
      priceChange1h: null,
      priceChange24h: null,
      buys24h: null,
      sells24h: null,
      uniqueWallets24h: null,
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

// Auto-track a detected address
async function autoTrack(address, message) {
  const db = loadDB();

  if (db.tokens[address]) {
    const existing = db.tokens[address];
    if (existing.alertChannelId !== message.channelId) {
      await message.channel.send({
        embeds: [{
          color: 0xffaa00,
          description: '👀 Already tracking **' + existing.name + ' (' + existing.symbol + ')** — first posted by **' + existing.postedBy + '** ' + fmtTime(existing.postedAt) + ' in <#' + existing.alertChannelId + '>',
          footer: { text: address }
        }]
      });
    }
    return;
  }

  const token = await fetchTokenData(address);
  if (!token) return;

  const ageFlag = getTokenAgeFlag(token.pairCreatedAt);

  // Buy/sell pressure
  const totalTxns = (token.buys24h || 0) + (token.sells24h || 0);
  let buyPressurePct = null;
  if (totalTxns > 0) {
    buyPressurePct = Math.round((token.buys24h / totalTxns) * 100);
  }
  const pressureIndicator = buyPressurePct !== null
    ? buyPressurePct >= 60 ? '🟢' : buyPressurePct <= 40 ? '🔴' : '🟡'
    : '🟡';

  const descParts = [
    'Posted by **' + message.author.username + '** · ' + (ageFlag.flag ? ageFlag.flag + ' ' : '') + ageFlag.label,
    'Entry: **' + (token.price ? '$' + Number(token.price).toFixed(8) : 'Bonding curve') + '** · MCap: **' + fmtUsd(token.marketCap) + '**',
  ];

  if (token.liquidity) {
    descParts.push('💧 Liquidity: **' + fmtUsd(token.liquidity) + '**');
  }

  if (token.volume1h) {
    descParts.push('📊 Vol 1h: **' + fmtUsd(token.volume1h) + '**' + (token.priceChange1h ? ' · 1h: **' + (token.priceChange1h > 0 ? '+' : '') + token.priceChange1h.toFixed(1) + '%**' : ''));
  }

  if (buyPressurePct !== null) {
    descParts.push(pressureIndicator + ' Buy pressure: **' + buyPressurePct + '%** buys / ' + (100 - buyPressurePct) + '% sells');
  }

  if (token.uniqueWallets24h) {
    descParts.push('👥 Unique wallets 24h: **' + token.uniqueWallets24h.toLocaleString() + '**');
  }

  if (token.platform === 'pumpfun' && !token.complete) {
    descParts.push('⏳ Bonding curve: **' + (token.bondingProgress ? token.bondingProgress.toFixed(0) : 0) + '%** to Raydium');
  }

  descParts.push('[' + (token.platform === 'pumpfun' ? 'pump.fun' : 'Birdeye') + '](' + token.dexUrl + ')');

  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setAuthor({ name: '📡 Auto-tracking: ' + token.name + ' (' + token.symbol + ')' })
    .setDescription(descParts.join('\n'))
    .setFooter({ text: address + ' · SOLANA' })
    .setTimestamp();

  if (token.imageUrl) embed.setThumbnail(token.imageUrl);

  await message.channel.send({ embeds: [embed] });

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
    tokenAge: (ageFlag.flag ? ageFlag.flag + ' ' : '') + ageFlag.label,
    dexUrl: token.dexUrl,
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

// Message listener
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const addresses = extractAddresses(message.content);
  if (addresses.length === 0) return;

  console.log('[detect] Found ' + addresses.length + ' address(es) from ' + message.author.username + ': ' + addresses.join(', '));

  for (const address of addresses) {
    await autoTrack(address, message).catch(e =>
      console.error('[autotrack] Error for ' + address + ':', e.message)
    );
  }
});

// Slash commands
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
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Slash commands registered');
  } catch (e) {
    console.error('Failed to register commands:', e.message);
  }
}

async function handleCalls(interaction) {
  await interaction.deferReply();
  const db = loadDB();
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
      multipleStr = mult >= 2
        ? '🚀 **' + mult.toFixed(2) + 'x**'
        : mult >= 1
          ? '📈 ' + mult.toFixed(2) + 'x'
          : '📉 ' + mult.toFixed(2) + 'x';
    }
    const buyPct = entry.buyPressure || 0;
    const mcap = live ? live.marketCap : null;
    return '**' + entry.name + ' (' + entry.symbol + ')** — ' + multipleStr + '\n' +
           '└ **' + entry.postedBy + '** · ' + fmtTime(entry.postedAt) + ' · MCap: ' + fmtUsd(mcap) + ' · ' + buyPct + '% buys';
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
  const db = loadDB();

  if (!db.tokens[address]) {
    return interaction.reply({ content: 'Not tracking ' + address, ephemeral: true });
  }

  const name = db.tokens[address].name;
  const symbol = db.tokens[address].symbol;
  delete db.tokens[address];
  saveDB(db);
  await interaction.reply('Stopped tracking **' + name + ' (' + symbol + ')**');
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'calls') return handleCalls(interaction);
    if (interaction.commandName === 'remove') return handleRemove(interaction);
  } catch (e) {
    console.error('[interaction] error:', e);
    const msg = { content: 'Error: ' + e.message, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      interaction.editReply(msg).catch(() => null);
    } else {
      interaction.reply(msg).catch(() => null);
    }
  }
});

client.once('ready', () => {
  console.log('Bot online as ' + client.user.tag);
  console.log('Watching all channels for contract addresses');
  pollTokens(client);
  setInterval(() => pollTokens(client), 3 * 60 * 1000);
});

(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
