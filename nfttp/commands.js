/**
 * nfttp/commands.js — /nfttrack /nftcalls /nftremove
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { isNftTpEnabled } from './config.js';
import { parseNftQuery } from './parse.js';
import { autoTrackNft } from './autotrack.js';
import { listCollections, removeCollection, getCollection } from './store.js';
import { nftMultiple } from './evaluate.js';
import { fmtEth } from './cards.js';
import { fmtCallerAgeShort } from '../alertCards/format.js';

export const nfttrackCommand = new SlashCommandBuilder()
  .setName('nfttrack')
  .setDescription('Track an NFT collection floor from the OG call (OpenSea URL, slug, or contract)')
  .addStringOption((o) =>
    o.setName('collection').setDescription('OpenSea URL, slug, or 0x contract').setRequired(true),
  );

export const nftcallsCommand = new SlashCommandBuilder()
  .setName('nftcalls')
  .setDescription('Show tracked NFT collections and floor multiple vs call');

export const nftremoveCommand = new SlashCommandBuilder()
  .setName('nftremove')
  .setDescription('Stop tracking an NFT collection')
  .addStringOption((o) =>
    o.setName('collection').setDescription('OpenSea slug or ticker').setRequired(true),
  );

function disabledReply(interaction) {
  return interaction.reply({
    content: 'NFT take-profits is off. Set `NFT_TP_ENABLED=true` and `OPENSEA_API_KEY` on this service.',
    ephemeral: true,
  });
}

export async function handleNfttrack(interaction) {
  if (!isNftTpEnabled()) return disabledReply(interaction);
  const raw = interaction.options.getString('collection', true);
  const ref = parseNftQuery(raw);
  if (!ref) {
    return interaction.reply({
      content: 'Could not parse that. Paste an OpenSea collection URL, slug (`pudgy-penguins`), or 0x contract.',
      ephemeral: true,
    });
  }
  await interaction.deferReply();
  const result = await autoTrackNft(ref, {
    client: interaction.client,
    author: interaction.user,
    channelId: interaction.channelId,
    createdTimestamp: Date.now(),
  });
  if (result.error === 'no_api_key') {
    return interaction.editReply('Missing `OPENSEA_API_KEY` on this Railway service.');
  }
  if (result.error) {
    return interaction.editReply('Could not resolve that collection (`' + result.error + '`).');
  }
  if (!result.added) {
    const e = result.entry;
    return interaction.editReply(
      'Already tracking **' + e.name + '** — OG call by **' + e.postedBy + '** is locked.',
    );
  }
  return interaction.editReply(
    '📡 Tracking **' + result.entry.name + '** · floor `' +
      fmtEth(result.entry.floorAtCall, result.entry.floorSymbol) + '`',
  );
}

export async function handleNftcalls(interaction) {
  if (!isNftTpEnabled()) return disabledReply(interaction);
  await interaction.deferReply();
  const rows = Object.values(listCollections()).sort(
    (a, b) => (Number(b.postedAt) || 0) - (Number(a.postedAt) || 0),
  );
  if (!rows.length) {
    return interaction.editReply('📭 No NFT collections tracked yet — paste an OpenSea URL in chat.');
  }

  const lines = rows.slice(0, 40).map((e, i) => {
    const live = { floor: e.lastFloor, mcap: e.lastMcap };
    const mult = nftMultiple(e, live);
    const multStr = mult != null ? mult.toFixed(2) + 'x' : '—';
    const stale = Date.now() - (Number(e.lastChecked) || 0) > 15 * 60 * 1000 ? ' ⏳' : '';
    return (
      (i + 1) +
      '. **' +
      (e.ticker || e.slug) +
      '** `' +
      multStr +
      '` · ' +
      fmtEth(e.lastFloor ?? e.floorAtCall, e.floorSymbol) +
      ' · 📞 ' +
      e.postedBy +
      ' · ' +
      fmtCallerAgeShort(e.postedAt) +
      stale
    );
  });

  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setTitle('🖼 NFT calls')
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: rows.length + ' collection' + (rows.length === 1 ? '' : 's') + ' · vs OG floor' });

  return interaction.editReply({ embeds: [embed] });
}

export async function handleNftremove(interaction) {
  if (!isNftTpEnabled()) return disabledReply(interaction);
  const raw = interaction.options.getString('collection', true).trim();
  const slug = raw.replace(/^@/, '').toLowerCase();
  const existing = getCollection(slug);
  const ok = removeCollection(slug);
  if (!ok) {
    return interaction.reply({ content: 'Not tracking `' + raw + '`.', ephemeral: true });
  }
  const name = existing?.name || slug;
  return interaction.reply('Removed **' + name + '** from NFT take-profits.');
}
