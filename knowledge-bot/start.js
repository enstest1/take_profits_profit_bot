/**
 * knowledge-bot/start.js — profit-bot wiring (mintscan-style).
 *
 * startKnowledge(client) runs only when KB_ENABLED=true. SQLite lives in
 * /data/knowledge/ (never tracked.json). Telegram never imports this file.
 * better-sqlite3 is loaded only inside startKnowledge so a disabled flag
 * does not open a database.
 */

import path from 'path';
import cron from 'node-cron';
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { DATA_DIR } from '../dbStore.js';
import { isBlockedChannel } from '../blockedChannels.js';

const KB_COLOR = 0x2ecc71;
const KB_COMMANDS = new Set(['ask', 'search', 'guide', 'faq', 'roundup', 'kbstats', 'backfill']);

let kbReady = false;
let kbClient = null;

function envBool(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return fallback;
}

/** Unset = off — same convention as mintscan / xradar. */
export function isKbEnabled() {
  return envBool('KB_ENABLED', false);
}

function kbDataDir() {
  return process.env.KB_DATA_DIR?.trim() || path.join(DATA_DIR, 'knowledge');
}

/** Guild the archive + /ask live in. KB_GUILD_ID wins so BitCERNials GUILD_ID can stay put. */
export function kbGuildId() {
  return (process.env.KB_GUILD_ID || process.env.GUILD_ID || '').trim();
}

/** Slash builders appended to the profit-bot command PUT (never a second PUT). */
export function kbSlashCommands() {
  return [
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
      .addStringOption((o) => o.setName('topic').setDescription('e.g. how we call tokens').setRequired(true)),
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
      .setDescription('Start/resume the 72h knowledge backfill (admin)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ];
}

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

async function disabledReply(interaction) {
  const msg = { content: 'Knowledge base is off (set KB_ENABLED=true).', ephemeral: true };
  if (interaction.deferred || interaction.replied) return interaction.editReply(msg).catch(() => null);
  return interaction.reply(msg).catch(() => null);
}

/**
 * Boot SQLite, live sync, hourly extract, optional weekly roundup, 72h backfill.
 * Failures stay inside this module — they must not kill the poller.
 * @param {import('discord.js').Client} client
 */
export async function startKnowledge(client) {
  if (!isKbEnabled()) {
    console.log('[kb] disabled (KB_ENABLED not true)');
    return;
  }
  if (process.env.PLATFORM === 'telegram') {
    console.log('[kb] skipped on PLATFORM=telegram');
    return;
  }
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error('[kb] OPENROUTER_API_KEY missing — refusing to start (profit bot continues)');
    return;
  }
  if (!kbGuildId()) {
    console.error('[kb] KB_GUILD_ID / GUILD_ID missing — refusing to start');
    return;
  }

  // archive.js reads KB_GUILD_ID; reuse the profit-bot guild when unset.
  if (!process.env.KB_GUILD_ID?.trim()) process.env.KB_GUILD_ID = kbGuildId();

  try {
    const { initDb } = await import('./db.js');
    const { runBackfill, attachLiveSync } = await import('./archive.js');
    const { startExtractCron, runExtraction } = await import('./extract.js');
    const { makeRoundup } = await import('./answer.js');

    const dir = kbDataDir();
    initDb(dir);
    kbClient = client;
    kbReady = true;
    console.log('[kb] SQLite at ' + dir + '/knowledge.db (separate from tracked.json)');
    console.log(
      '[kb] guild ' +
        kbGuildId() +
        ' channels ' +
        (process.env.KB_CHANNEL_IDS?.trim() || 'all'),
    );

    attachLiveSync(client);
    startExtractCron();

    const roundupCron = process.env.KB_ROUNDUP_CRON || '0 17 * * 5';
    const postId = process.env.KB_POST_CHANNEL_ID;
    if (postId && !isBlockedChannel(postId)) {
      cron.schedule(
        roundupCron,
        async () => {
          try {
            const { text, citations, note } = await makeRoundup(7);
            if (!text) return console.log('[kb/roundup] ' + note);
            const channel = await client.channels.fetch(postId);
            if (channel?.isTextBased()) await channel.send({ embeds: answerEmbeds(text, citations || []) });
          } catch (e) {
            console.error('[kb/roundup] failed:', e.message);
          }
        },
        { timezone: process.env.KB_TZ || 'UTC' },
      );
      console.log("[kb] weekly roundup cron '" + roundupCron + "' -> channel " + postId);
    } else {
      console.log('[kb] KB_POST_CHANNEL_ID unset — weekly roundup off (use /roundup)');
    }

    // Mentions default OFF so @profit-bot does not become an LLM call.
    if (envBool('KB_MENTION_ANSWERS', false)) {
      const mentionCooldown = new Map();
      client.on('messageCreate', async (m) => {
        if (m.author.bot || !m.guild || m.guildId !== kbGuildId()) return;
        if (isBlockedChannel(m.channelId)) return;
        if (!m.mentions.has(client.user)) return;
        const q = m.content.replace(/<@!?\d+>/g, '').trim();
        if (q.length < 8) return;
        const last = mentionCooldown.get(m.author.id) || 0;
        if (Date.now() - last < 30_000) return;
        mentionCooldown.set(m.author.id, Date.now());
        try {
          const { ask } = await import('./answer.js');
          await m.channel.sendTyping().catch(() => null);
          const { answer, citations, qaId } = await ask(q, m.author.id);
          await m.reply({
            embeds: answerEmbeds(answer, citations),
            components: qaId ? [feedbackRow(qaId)] : [],
          });
        } catch (e) {
          console.error('[kb/mention] failed:', e.message);
        }
      });
      console.log('[kb] @mention answers on');
    }

    if (process.env.KB_BACKFILL_ON_BOOT !== '0') {
      console.log('[kb] starting 72h backfill (KB_BACKFILL_ON_BOOT=0 to skip)');
      runBackfill(client).catch((e) => console.error('[kb] backfill failed:', e.message));
    }

    // First extract after backfill has a chance to finish a channel — cron still runs hourly.
    setTimeout(() => {
      runExtraction().catch((e) => console.error('[kb] first extract failed:', e.message));
    }, 5 * 60 * 1000);
  } catch (e) {
    kbReady = false;
    console.error('[kb] start failed (profit bot continues):', e.message);
  }
}

/**
 * @returns {Promise<boolean>} true if this interaction was a KB command/button
 */
export async function handleKbInteraction(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith('kbfb:')) {
    if (!kbReady) {
      await disabledReply(interaction);
      return true;
    }
    const { setQaFeedback } = await import('./db.js');
    const [, qaId, val] = interaction.customId.split(':');
    setQaFeedback(Number(qaId), Number(val));
    await interaction.reply({
      content: val === '1' ? 'Noted — thanks! 👍' : "Noted — I'll get better. 👎",
      ephemeral: true,
    });
    return true;
  }

  if (!interaction.isChatInputCommand() || !KB_COMMANDS.has(interaction.commandName)) return false;
  const home = kbGuildId();
  if (home && interaction.guildId && interaction.guildId !== home) {
    await interaction
      .reply({ content: 'Knowledge archive is not enabled in this server.', ephemeral: true })
      .catch(() => null);
    return true;
  }
  if (isBlockedChannel(interaction.channelId)) return true;
  if (!isKbEnabled() || !kbReady) {
    await disabledReply(interaction);
    return true;
  }

  const { ask, verbatimSearch, makeGuide, makeFaq, makeRoundup } = await import('./answer.js');
  const { stats } = await import('./db.js');
  const { runBackfill, isBackfillRunning } = await import('./archive.js');
  const { backlogReport } = await import('./extract.js');

  const name = interaction.commandName;
  if (name === 'ask') {
    const question = interaction.options.getString('question');
    await interaction.deferReply();
    const { answer, citations, qaId } = await ask(question, interaction.user.id);
    await interaction.editReply({
      embeds: answerEmbeds(answer, citations),
      components: qaId ? [feedbackRow(qaId)] : [],
    });
    return true;
  }
  if (name === 'search') {
    const query = interaction.options.getString('query');
    await interaction.deferReply({ ephemeral: true });
    const hits = verbatimSearch(query, 6);
    if (!hits.length) {
      await interaction.editReply('No archived messages matched that.');
      return true;
    }
    const lines = hits.map(
      (h) => '**' + h.author + '** (' + h.when + '): ' + h.snippet + (h.link ? '\n' + h.link : ''),
    );
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(KB_COLOR)
          .setTitle('🔎 Archive matches')
          .setDescription(lines.join('\n\n').slice(0, 3900)),
      ],
    });
    return true;
  }
  if (name === 'guide') {
    const topic = interaction.options.getString('topic');
    await interaction.deferReply();
    const { md, note } = await makeGuide(topic);
    if (!md) {
      await interaction.editReply(note);
      return true;
    }
    const preview = md.length > 1800 ? md.slice(0, 1800) + '\n…(full guide attached)' : md;
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(KB_COLOR).setTitle('📘 Guide: ' + topic).setDescription(preview)],
      files: [mdAttachment(md, 'guide-' + slug(topic) + '.md')],
    });
    return true;
  }
  if (name === 'faq') {
    const topic = interaction.options.getString('topic');
    await interaction.deferReply();
    const { md, note } = await makeFaq(topic);
    if (!md) {
      await interaction.editReply(note);
      return true;
    }
    const preview = md.length > 1800 ? md.slice(0, 1800) + '\n…(full FAQ attached)' : md;
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(KB_COLOR)
          .setTitle('❓ FAQ' + (topic ? ': ' + topic : ''))
          .setDescription(preview),
      ],
      files: [mdAttachment(md, 'faq-' + slug(topic || 'server') + '.md')],
    });
    return true;
  }
  if (name === 'roundup') {
    const days = interaction.options.getInteger('days') || 7;
    await interaction.deferReply();
    const { text, citations, note } = await makeRoundup(days);
    if (!text) {
      await interaction.editReply(note);
      return true;
    }
    await interaction.editReply({ embeds: answerEmbeds(text, citations || []) });
    return true;
  }
  if (name === 'kbstats') {
    const s = stats();
    const backlog = backlogReport();
    const kindLines = s.byKind.map((k) => k.kind + ': ' + k.n).join(' · ') || 'none yet';
    const backlogLines = backlog.length
      ? backlog.slice(0, 10).map((b) => b.name + ': ' + b.backlog).join('\n')
      : 'fully caught up';
    const fb = s.qa.n ? s.qa.n + ' questions asked, ' + (s.qa.up || 0) + ' marked helpful' : 'no questions yet';
    await interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(KB_COLOR)
          .setTitle('📊 Knowledge base')
          .setDescription(
            '**Messages archived:** ' +
              s.messages.toLocaleString() +
              ' across ' +
              s.channels +
              ' channels (' +
              s.backfilled +
              ' fully backfilled)\n' +
              '**Knowledge units:** ' +
              s.knowledge.toLocaleString() +
              ' — ' +
              kindLines +
              '\n' +
              '**/ask feedback:** ' +
              fb +
              '\n\n' +
              '**Extraction backlog (messages):**\n' +
              backlogLines,
          ),
      ],
    });
    return true;
  }
  if (name === 'backfill') {
    if (isBackfillRunning()) {
      await interaction.reply({ content: 'Backfill already running.', ephemeral: true });
      return true;
    }
    await interaction.reply({
      content: '📥 Backfill started (last 72h) — silent in chat. Run /kbstats to watch counts.',
      ephemeral: true,
    });
    runBackfill(kbClient, (chanName, n) => {
      if (n % 2000 === 0) console.log('[kb] ' + chanName + ': ' + n + ' messages...');
    }).catch((e) => console.error('[kb] backfill failed:', e.message));
    return true;
  }
  return true;
}
