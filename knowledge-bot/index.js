// index.js — Knowledge Bot entry point.
//
// A standalone Discord bot (separate app + token from any trading bot) that
// archives full server history, curates it into a knowledge base with an LLM,
// and serves it back: /ask (cited answers), /search (verbatim + jump links),
// /guide, /faq, /roundup, /kbstats, /backfill — plus @mention-to-ask and
// 👍/👎 feedback buttons. See README.md for setup.

import 'dotenv/config';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import cron from 'node-cron';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { initDb, stats, setQaFeedback } from './db.js';
import { runBackfill, isBackfillRunning, attachLiveSync } from './archive.js';
import { runExtraction, startExtractCron, backlogReport } from './extract.js';
import { ask, verbatimSearch, makeGuide, makeFaq, makeRoundup } from './answer.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const KB_COLOR = 0x2ecc71; // green

// ---------------------------------------------------------------------------
// Boot checks
// ---------------------------------------------------------------------------

for (const v of ['DISCORD_TOKEN', 'CLIENT_ID', 'KB_GUILD_ID', 'OPENROUTER_API_KEY']) {
  if (!process.env[v]) {
    console.error('[boot] ' + v + ' missing — cannot start');
    process.exit(1);
  }
}

initDb(DATA_DIR);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the server knowledge base — answers cite the original messages')
    .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Verbatim search of the message archive (with jump links)')
    .addStringOption((o) => o.setName('query').setDescription('What to find').setRequired(true)),
  new SlashCommandBuilder()
    .setName('guide')
    .setDescription('Generate a structured guide on a topic from archived knowledge')
    .addStringOption((o) => o.setName('topic').setDescription('e.g. "agentic engineering"').setRequired(true)),
  new SlashCommandBuilder()
    .setName('faq')
    .setDescription('Generate an FAQ from questions the community has answered')
    .addStringOption((o) => o.setName('topic').setDescription('Optional topic filter').setRequired(false)),
  new SlashCommandBuilder()
    .setName('roundup')
    .setDescription("Post 'what the server learned' for the last N days")
    .addIntegerOption((o) =>
      o.setName('days').setDescription('Lookback (default 7)').setMinValue(1).setMaxValue(30).setRequired(false),
    ),
  new SlashCommandBuilder().setName('kbstats').setDescription('Knowledge base stats and extraction backlog'),
  new SlashCommandBuilder()
    .setName('backfill')
    .setDescription('Start/resume the full history backfill (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.KB_GUILD_ID), {
      body: commands,
    });
    console.log('[boot] slash commands registered (guild — instant)');
  } catch (e) {
    console.error('[boot] command registration failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

function answerEmbeds(answer, citations) {
  const embeds = [new EmbedBuilder().setColor(KB_COLOR).setDescription(answer.slice(0, 3900))];
  if (citations.length) {
    embeds.push(
      new EmbedBuilder()
        .setColor(KB_COLOR)
        .setTitle('📎 Receipts')
        .setDescription(citations.join('\n').slice(0, 3900)),
    );
  }
  return embeds;
}

function feedbackRow(qaId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('kbfb:' + qaId + ':1').setLabel('Helpful').setStyle(ButtonStyle.Success).setEmoji('👍'),
    new ButtonBuilder().setCustomId('kbfb:' + qaId + ':0').setLabel('Off').setStyle(ButtonStyle.Secondary).setEmoji('👎'),
  );
}

function mdAttachment(md, name) {
  return new AttachmentBuilder(Buffer.from(md, 'utf8'), { name });
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'topic';
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleAsk(interaction) {
  const question = interaction.options.getString('question');
  await interaction.deferReply();
  const { answer, citations, qaId } = await ask(question, interaction.user.id);
  await interaction.editReply({
    embeds: answerEmbeds(answer, citations),
    components: qaId ? [feedbackRow(qaId)] : [],
  });
}

async function handleSearch(interaction) {
  const query = interaction.options.getString('query');
  await interaction.deferReply({ ephemeral: true });
  const hits = verbatimSearch(query, 6);
  if (!hits.length) return interaction.editReply('No archived messages matched that.');
  const lines = hits.map(
    (h) => '**' + h.author + '** (' + h.when + '): ' + h.snippet + (h.link ? '\n' + h.link : ''),
  );
  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(KB_COLOR).setTitle('🔎 Archive matches').setDescription(lines.join('\n\n').slice(0, 3900))],
  });
}

async function handleGuide(interaction) {
  const topic = interaction.options.getString('topic');
  await interaction.deferReply();
  const { md, note } = await makeGuide(topic);
  if (!md) return interaction.editReply(note);
  const preview = md.length > 1800 ? md.slice(0, 1800) + '\n…(full guide attached)' : md;
  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(KB_COLOR).setTitle('📘 Guide: ' + topic).setDescription(preview)],
    files: [mdAttachment(md, 'guide-' + slug(topic) + '.md')],
  });
}

async function handleFaq(interaction) {
  const topic = interaction.options.getString('topic');
  await interaction.deferReply();
  const { md, note } = await makeFaq(topic);
  if (!md) return interaction.editReply(note);
  const preview = md.length > 1800 ? md.slice(0, 1800) + '\n…(full FAQ attached)' : md;
  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(KB_COLOR).setTitle('❓ FAQ' + (topic ? ': ' + topic : '')).setDescription(preview)],
    files: [mdAttachment(md, 'faq-' + slug(topic || 'server') + '.md')],
  });
}

async function handleRoundup(interaction) {
  const days = interaction.options.getInteger('days') || 7;
  await interaction.deferReply();
  const { text, citations, note } = await makeRoundup(days);
  if (!text) return interaction.editReply(note);
  return interaction.editReply({ embeds: answerEmbeds(text, citations || []) });
}

async function handleStats(interaction) {
  const s = stats();
  const backlog = backlogReport();
  const kindLines = s.byKind.map((k) => k.kind + ': ' + k.n).join(' · ') || 'none yet';
  const backlogLines = backlog.length
    ? backlog.slice(0, 10).map((b) => b.name + ': ' + b.backlog).join('\n')
    : 'fully caught up';
  const fb = s.qa.n ? s.qa.n + ' questions asked, ' + (s.qa.up || 0) + ' marked helpful' : 'no questions yet';
  return interaction.reply({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(KB_COLOR)
        .setTitle('📊 Knowledge base')
        .setDescription(
          '**Messages archived:** ' + s.messages.toLocaleString() +
          ' across ' + s.channels + ' channels (' + s.backfilled + ' fully backfilled)\n' +
          '**Knowledge units:** ' + s.knowledge.toLocaleString() + ' — ' + kindLines + '\n' +
          '**/ask feedback:** ' + fb + '\n\n' +
          '**Extraction backlog (messages):**\n' + backlogLines,
        ),
    ],
  });
}

async function handleBackfill(interaction) {
  if (isBackfillRunning()) return interaction.reply({ content: 'Backfill already running.', ephemeral: true });
  await interaction.reply({ content: '📥 Backfill started — progress in the logs. Run /kbstats to watch counts climb.', ephemeral: true });
  runBackfill(client, (name, n) => {
    if (n % 2000 === 0) console.log('[archive] ' + name + ': ' + n + ' messages...');
  }).catch((e) => console.error('[archive] backfill failed:', e.message));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('kbfb:')) {
      const [, qaId, val] = interaction.customId.split(':');
      setQaFeedback(Number(qaId), Number(val));
      return interaction.reply({ content: val === '1' ? 'Noted — thanks! 👍' : 'Noted — I\'ll get better. 👎', ephemeral: true });
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'ask') return await handleAsk(interaction);
    if (interaction.commandName === 'search') return await handleSearch(interaction);
    if (interaction.commandName === 'guide') return await handleGuide(interaction);
    if (interaction.commandName === 'faq') return await handleFaq(interaction);
    if (interaction.commandName === 'roundup') return await handleRoundup(interaction);
    if (interaction.commandName === 'kbstats') return await handleStats(interaction);
    if (interaction.commandName === 'backfill') return await handleBackfill(interaction);
  } catch (e) {
    console.error('[interaction] error:', e);
    const msg = { content: 'Error: ' + e.message, ephemeral: true };
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => null);
    else interaction.reply(msg).catch(() => null);
  }
});

// @mention the bot with a question -> same as /ask (30s per-user cooldown)
const mentionCooldown = new Map();
client.on('messageCreate', async (m) => {
  if (process.env.KB_MENTION_ANSWERS === '0') return;
  if (m.author.bot || !m.guild || m.guildId !== process.env.KB_GUILD_ID) return;
  if (!m.mentions.has(client.user)) return;
  const q = m.content.replace(/<@!?\d+>/g, '').trim();
  if (q.length < 8) return;
  const last = mentionCooldown.get(m.author.id) || 0;
  if (Date.now() - last < 30_000) return;
  mentionCooldown.set(m.author.id, Date.now());
  try {
    await m.channel.sendTyping().catch(() => null);
    const { answer, citations, qaId } = await ask(q, m.author.id);
    await m.reply({ embeds: answerEmbeds(answer, citations), components: qaId ? [feedbackRow(qaId)] : [] });
  } catch (e) {
    console.error('[mention-ask] failed:', e.message);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

client.once('ready', async () => {
  console.log('[boot] Knowledge Bot online as ' + client.user.tag + ' — data in ' + DATA_DIR);
  await registerCommands();
  attachLiveSync(client);
  startExtractCron();

  const roundupCron = process.env.KB_ROUNDUP_CRON || '0 17 * * 5'; // Fri 5pm
  const postId = process.env.KB_POST_CHANNEL_ID;
  if (postId) {
    cron.schedule(roundupCron, async () => {
      try {
        const { text, citations, note } = await makeRoundup(7);
        if (!text) return console.log('[roundup] ' + note);
        const channel = await client.channels.fetch(postId);
        if (channel?.isTextBased()) await channel.send({ embeds: answerEmbeds(text, citations || []) });
      } catch (e) {
        console.error('[roundup] failed:', e.message);
      }
    }, { timezone: process.env.KB_TZ || 'UTC' });
    console.log("[boot] weekly roundup cron '" + roundupCron + "' -> channel " + postId);
  } else {
    console.log('[boot] KB_POST_CHANNEL_ID not set — weekly roundup disabled (use /roundup manually)');
  }

  if (process.env.KB_BACKFILL_ON_BOOT !== '0') {
    console.log('[boot] starting/resuming backfill (set KB_BACKFILL_ON_BOOT=0 to disable)');
    runBackfill(client).catch((e) => console.error('[archive] backfill failed:', e.message));
  }
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('[boot] login failed:', e.message);
  process.exit(1);
});
