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

function getTokenAgeFlag(createdAtMs) {
  if (!createdAtMs) return null;
  const ageHours = (Date.now() - createdAtMs) / 3600000;
  if (ageHours < 1) return '🔥 < 1h old';
  if (ageHours < 24) return '⚡ ' + Math.floor(ageHours) + 'h old';
  return Math.floor(ageHours / 24) + 'd old';
}

// Deduplicate addresses — handles addresses with or without 'pump' suffix
function extractAddresses(text) {
  const found = new Set();

  // EVM
  const evmMatches = text.match(/\b0x[a-fA-F0-9]{40}\b/g) || [];
  for (const addr of evmMatches) found.add(addr.toLowerCase());

  // Solana — 32-44 base58 chars
  const solanaMatches = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [];
  for (const addr of solanaMatches) {
    if (/\d/.test(addr) && !/[0OIl]/.test(addr)) found.add(addr);
  }

  return Array.from(found);
}

// DexScreener — graduated tokens on Raydium
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

// pump.fun — pre-graduation bonding curve tokens
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

// Try DexScreener first (graduated), then pump.fun (bonding curve)
async function fetchTokenData(address) {
  // DexScreener first — covers graduated tokens
  const dex = await fetchDexScreener(address);
  if (dex && dex.name) {
    return dex;
  }

  // pump.fun fallback — covers pre-graduation tokens
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

async function autoTrack(address, message) {
  const db = loadDB();

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
    console.log('[skip] ' + address.slice(0, 8) + '... — not found on DexScreener or pump.fun');
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
    .setDescription('Check X account name history for rug detection')
    .addStringOption(opt =>
      opt.setName('handle').setDescription('X handle (with or without @)').setRequired(true)
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

async function handleX(interaction) {
  await interaction.deferReply();

  // Strip @ if included
  const raw = interaction.options.getString('handle').trim();
  const handle = raw.startsWith('@') ? raw.slice(1) : raw;

  try {
    const res = await fetch('https://api.memory.lol/v1/tw/' + encodeURIComponent(handle), {
      signal: AbortSignal.timeout(8000)
    });

    if (res.status === 404) {
      return interaction.editReply('❌ **@' + handle + '** not found in memory.lol — account may be too new or never indexed.');
    }
    if (!res.ok) {
      return interaction.editReply('❌ Could not fetch history for **@' + handle + '** — try again in a moment.');
    }

    const data = await res.json();
    const accounts = data && data.accounts;
    const accountData = accounts && Object.values(accounts)[0];

    if (!accountData) {
      return interaction.editReply('✅ **@' + handle + '** — no name changes found. Clean account.');
    }

    // Get all historical usernames (exclude current handle)
    const historical = Object.keys(accountData)
      .filter(name => name.toLowerCase() !== handle.toLowerCase());

    if (historical.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle('🐦 X Account History — @' + handle)
        .setDescription('✅ No name changes detected — account has always used this handle.')
        .setFooter({ text: 'Powered by memory.lol' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // Build timeline — get dates for each name
    const nameList = historical.map(name => {
      const dates = accountData[name];
      const firstSeen = dates && dates[0] ? dates[0] : 'unknown date';
      return '**@' + name + '** (seen ' + firstSeen + ')';
    });

    const isSuspicious = historical.length >= 2;
    const color = historical.length >= 3 ? 0xff3333 : historical.length >= 2 ? 0xffaa00 : 0xffff00;

    const description = [
      (isSuspicious ? '⚠️ ' : '🟡 ') + historical.length + ' name change' + (historical.length !== 1 ? 's' : '') + ' detected
',
      'Previous usernames:',
      nameList.join('
'),
      '
Current: **@' + handle + '**',
      isSuspicious ? '
⚠️ **Multiple rebrands — common pattern in serial ruggers**' : ''
    ].join('
');

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle('🐦 X Account History — @' + handle)
      .setDescription(description.slice(0, 4000))
      .setFooter({ text: 'Powered by memory.lol · ' + historical.length + ' name change' + (historical.length !== 1 ? 's' : '') })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });

  } catch (e) {
    console.error('[/x] failed for ' + handle + ':', e.message);
    return interaction.editReply('❌ Failed to fetch history — try again in a moment.');
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'calls') return handleCalls(interaction);
    if (interaction.commandName === 'remove') return handleRemove(interaction);
    if (interaction.commandName === 'x') return handleX(interaction);
  } catch (e) {
    console.error('[interaction] error:', e);
    const msg = { content: 'Error: ' + e.message, ephemeral: true };
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => null);
    else interaction.reply(msg).catch(() => null);
  }
});

client.once('ready', () => {
  console.log('Bot online as ' + client.user.tag);
  pollTokens(client);
  setInterval(() => pollTokens(client), 3 * 60 * 1000);
});

(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
