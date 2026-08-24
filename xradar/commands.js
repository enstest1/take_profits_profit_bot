/**
 * xradar/commands.js — /xwatch add|remove|list
 *
 * /xwatch add does two writes: follow-radar (db.xRadar.users) and the X list
 * xfeed polls, so Discord users never have to add the same handle twice.
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { normalizeXHandle } from '../xSocial.js';
import { getUserByScreenName } from './xClient.js';
import { addWatched, removeWatched, listWatched } from './store.js';
import {
  syncHandleToFeedList,
  unsyncHandleFromFeedList,
  describeListSync,
} from './listSync.js';

export const xwatchCommand = new SlashCommandBuilder()
  .setName('xwatch')
  .setDescription('Watch an X account for new follows, posts, and replies')
  .addSubcommand((sc) =>
    sc
      .setName('add')
      .setDescription('Start watching an X handle (also adds them to the posts list)')
      .addStringOption((o) =>
        o.setName('handle').setDescription('X handle or profile URL').setRequired(true),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName('remove')
      .setDescription('Stop watching an X handle (also removes them from the posts list)')
      .addStringOption((o) =>
        o.setName('handle').setDescription('X handle or profile URL').setRequired(true),
      ),
  )
  .addSubcommand((sc) => sc.setName('list').setDescription('Show every watched X account'));

export async function handleXwatch(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') return handleAdd(interaction);
  if (sub === 'remove') return handleRemove(interaction);
  return handleList(interaction);
}

async function handleAdd(interaction) {
  const raw = interaction.options.getString('handle');
  const handle = normalizeXHandle(raw);
  if (!handle) {
    return interaction.editReply('That is not a valid X handle. Try `pelp333` or `https://x.com/pelp333`.');
  }

  let profile;
  try {
    profile = await getUserByScreenName(handle);
  } catch (e) {
    console.error('[xradar] /xwatch add @' + handle + ' lookup failed:', e.message);
    return interaction.editReply('Could not find **@' + handle + '** on X — ' + e.message);
  }

  const { added } = addWatched(handle, profile);
  // Re-running add still tries the list, so older follow-only watches get posts too.
  const sync = await syncHandleToFeedList(profile);
  const listLine = describeListSync(sync);
  const who = profile.username || handle;

  if (!added) {
    return interaction.editReply('Already watching **@' + who + '**. ' + listLine);
  }

  return interaction.editReply(
    'Watching **@' + who + '** for new follows.\n' + listLine,
  );
}

async function handleRemove(interaction) {
  const handle = normalizeXHandle(interaction.options.getString('handle'));
  if (!handle) return interaction.editReply('That is not a valid X handle.');

  const cached = listWatched()[handle];
  if (!removeWatched(handle)) {
    return interaction.editReply("You weren't watching **@" + handle + '**.');
  }

  let profile = cached?.id ? { id: cached.id, username: cached.username || handle } : null;
  if (!profile) {
    try {
      profile = await getUserByScreenName(handle);
    } catch (e) {
      console.warn('[xradar] /xwatch remove lookup failed for @' + handle + ':', e.message);
    }
  }

  const sync = profile ? await unsyncHandleFromFeedList(profile) : { skipped: 'no_user_id' };
  return interaction.editReply('Stopped watching **@' + handle + '**. ' + describeListSync(sync));
}

async function handleList(interaction) {
  const users = listWatched();
  const handles = Object.keys(users);
  if (!handles.length) {
    return interaction.editReply('No X accounts yet. `/xwatch add handle: someone` to start.');
  }

  const lines = handles.map((h) => {
    const u = users[h];
    const name = u.name ? ' · ' + u.name : '';
    return '• **@' + (u.username || h) + '**' + name;
  });

  const embed = new EmbedBuilder()
    .setColor(0x1d9bf0)
    .setTitle('X radar — ' + handles.length + ' account' + (handles.length === 1 ? '' : 's'))
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: 'Follows via radar · posts/comments via the synced X list' });

  return interaction.editReply({ embeds: [embed] });
}
