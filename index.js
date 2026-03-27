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
  if (num >= 1_000_000_000) return `$${(num / 1e9).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1e3).toFixed(1)}K`;
  return `$${num.toFixed(4)}`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function getTokenAgeFlag(createdAtMs) {
  if (!createdAtMs) return { flag: null, label: 'unknown age' };
  const ageHours = (Date.now() - createdAtMs) / 3600000;
  if (ageHours < 1) return { flag: '🔥', label: '< 1h old' };
  if (ageHours < 24) return { flag: '⚡', label: `${Math.floor(ageHours)}h old` };
  return { flag: null, label: `${Math.floor(ageHours / 24)}d old` };
}

// Extract and deduplicate addresses from message text
function extractAddresses(text) {
  const found = new Set();

  // EVM addresses
  const evmMatches = text.match(/\b0x[a-fA-F0-9]{40}\b/g) || [];
  for (const addr of evmMatches) {
    found.add(addr.toLowerCase());
  }

  // Solana base58 - must have digit, no 0/O/I/l
  const solanaMatches = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [];
  for (const addr of solanaMatches) {
    if (addr.length < 32) continue;
    if (/\d/.test(addr) && !/[0OIl]/.test(addr)) {
      found.add(addr);
    }
  }

  return Array.from(found);
}

// Fetch token data - try DexScreener then pump.fun
async function fetchTokenData(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      const pair = data.pairs && data.pairs[0];
      if (pair) {
        return {
          platform: 'dexscreener',
          name: pair.baseToken && pair.baseToken.name,
          symbol: pair.baseToken && pair.baseToken.symbol,
          chain: pair.chainId,
          price: pair.priceUsd,
          marketCap: pair.marketCap,
          volume24h: (pair.volume && pair.volume.h24) || 0,
          liquidity: (pair.liquidity && pair.liquidity.usd) || 0,
          dexUrl: pair.url,
          imageUrl: (pair.info && pair.info.imageUrl) || null,
          pairCreatedAt: pair.pairCreatedAt || null,
          buys24h: (pair.txns && pair.txns.h24 && pair.txns.h24.buys) || 0,
          sells24h: (pair.txns && pair.txns.h24 && pair.txns.h24.sells) || 0,
        };
      }
    }
  } catch (e) {
    console.error(`[dex] ${address}:`, e.message);
  }

  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${address}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const d = await res.json();
      if (d && d.mint && d.name) {
        return {
          platform: 'pumpfun',
          name: d.name,
          symbol: d.symbol,
          chain: 'solana',
          price: null,
          marketCap: d.usd_market_cap || 0,
          volume24h: 0,
          liquidity: 0,
          dexUrl: `https://pump.fun/${address}`,
          imageUrl: d.image_uri || null,
          pairCreatedAt: d.created_timestamp || null,
          bondingProgress: d.bonding_curve_progress || 0,
          complete: d.complete || false,
          creator: d.creator || null,
          virtualSolReserves: d.virtual_sol_reserves,
          virtualTokenReserves: d.virtual_token_reserves,
          totalSupply: d.total_supply,
          description: d.description || null,
        };
      }
    }
  } catch (e) {
    console.error(`[pumpfun] ${address}:`, e.message);
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
          description: `👀 Already tracking **${existing.name} (${existing.symbol})** — first posted by **${existing.postedBy}** ${fmtTime(existing.postedAt)} in <#${existing.alertChannelId}>`,
          footer: { text: address }
        }]
      });
    }
    return;
  }

  const token = await fetchTokenData(address);
  if (!token) return;

  const ageFlag = getTokenAgeFlag(token.pairCreatedAt);

  const totalTxns = (token.buys24h || 0) + (token.sells24h || 0);
  let buyPressurePct = null;
  if (totalTxns > 0) {
    buyPressurePct = Math.round((token.buys24h / totalTxns) * 100);
  }

  const pressureIndicator = buyPressurePct !== null
    ? buyPressurePct >= 60 ? '🟢' : buyPressurePct <= 40 ? '🔴' : '🟡'
    : '🟡';

  const descParts = [
    `Posted by **${message.author.username}** · ${ageFlag.flag ? ageFlag.flag + ' ' : ''}${ageFlag.label}`,
    `Entry: **${token.price ? '$' + token.price : 'Bonding curve'}** · MCap: **${fmtUsd(token.marketCap)}**`,
  ];

  if (buyPressurePct !== null) {
    descParts.push(`${pressureIndicator} Buy pressure: **${buyPressurePct}%** buys / ${100 - buyPressurePct}% sells`);
  }

  if (token.platform === 'pumpfun' && !token.complete) {
    descParts.push(`⏳ Bonding curve: **${token.bondingProgress ? token.bondingProgress.toFixed(0) : 0}%** to Raydium`);
  }

  descParts.push(`[${token.platform === 'pumpfun' ? 'pump.fun' : 'DexScreener'}](${token.dexUrl})`);

  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setAuthor({ name: `📡 Auto-tracking: ${token.name} (${token.symbol})` })
    .setDescription(descParts.join('\n'))
    .setFooter({ text: `${address} · ${(token.chain || 'solana').toUpperCase()}` })
    .setTimestamp();

  if (token.imageUrl) embed.setThumbnail(token.imageUrl);

  await message.channel.send({ embeds: [embed] });

  db.tokens[address] = {
    address,
    name: token.name,
    symbol: token.symbol,
    chain: token.chain || 'solana',
    platform: token.platform,
    postedBy: message.author.username,
    postedByUserId: message.author.id,
    postedAt: Date.now(),
    calledInGuild: message.guildId,
    alertChannelId: message.channelId,
    priceAtCall: token.price || null,
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
    tokenAge: `${ageFlag.flag ? ageFlag.flag + ' ' : ''}${ageFlag.label}`,
    dexUrl: token.dexUrl,
    devWallet: token.creator || null,
    devHoldingAtCall: 0,
    devLastKnownHolding: 0,
    devDumpAlertFired: false,
    buyPressure: buyPressurePct || 0,
    sellPressure: buyPressurePct !== null ? 100 - buyPressurePct : 0,
  };

  saveDB(db);
  console.log(`[tracked] ${token.name} (${token.symbol}) — posted by ${message.author.username}`);
}

// Message listener
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const addresses = extractAddresses(message.content);
  if (addresses.length === 0) return;

  console.log(`[detect] Found ${addresses.length} address(es) from ${message.author.username}: ${addresses.join(', ')}`);

  for (const address of addresses) {
    await autoTrack(address, message).catch(e =>
      console.error(`[autotrack] Error for ${address}:`, e.message)
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
        ? `🚀 **${mult.toFixed(2)}x**`
        : mult >= 1
          ? `📈 ${mult.toFixed(2)}x`
          : `📉 ${mult.toFixed(2)}x`;
    }
    const buyPct = entry.buyPressure || 0;
    return [
      `**${entry.name} (${entry.symbol})** — ${multipleStr}`,
      `└ **${entry.postedBy}** · ${fmtTime(entry.postedAt)} · MCap: ${fmtUsd(live ? live.marketCap : null)} · ${buyPct}% buys`,
    ].join('\n');
  });

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle('Tracked Tokens')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: `${entries.length} token${entries.length !== 1 ? 's' : ''} being watched` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction) {
  const address = interaction.options.getString('address').trim();
  const db = loadDB();

  if (!db.tokens[address]) {
    return interaction.reply({ content: `Not tracking ${address}`, ephemeral: true });
  }

  const { name, symbol } = db.tokens[address];
  delete db.tokens[address];
  saveDB(db);
  await interaction.reply(`Stopped tracking **${name} (${symbol})**`);
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'calls') return handleCalls(interaction);
    if (interaction.commandName === 'remove') return handleRemove(interaction);
  } catch (e) {
    console.error('[interaction] error:', e);
    const msg = { content: `Error: ${e.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      interaction.editReply(msg).catch(() => null);
    } else {
      interaction.reply(msg).catch(() => null);
    }
  }
});

client.once('ready', () => {
  console.log(`Bot online as ${client.user.tag}`);
  console.log(`Watching all channels for contract addresses`);
  pollTokens(client);
  setInterval(() => pollTokens(client), 3 * 60 * 1000);
});

(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
