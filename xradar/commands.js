/**
 * xradar/commands.js — /xwatch add|remove|list
 *
 * /xwatch add does two writes: follow-radar (dest store) and the dest's X list
 * xfeed polls. Guild picks the dest: tp4aph → empty TP radar + TP list;
 * Bitcernals → personal radar + personal list.
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { normalizeXHandle } from '../xSocial.js';
import { getUserByScreenName } from './xClient.js';
import { addWatched, removeWatched, listWatched } from './store.js';
import { destFromGuildId, DEST_TP } from './config.js';
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

function destLabel(dest) {
  return dest === DEST_TP ? 'Take Profits' : 'personal';
}

export async function handleXwatch(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const dest = destFromGuildId(interaction.guildId);
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') return handleAdd(interaction, dest);
  if (sub === 'remove') return handleRemove(interaction, dest);
  return handleList(interaction, dest);
}

async function handleAdd(interaction, dest) {
  const raw = interaction.options.getString('handle');
  const handle = normalizeXHandle(raw);
  if (!handle) {
    return interaction.editReply('That is not a valid X handle. Try `pelp333` or `https://x.com/pelp333`.');
  }

  let profile;
  try {
    profile = await getUserByScreenName(handle);
  } catch (e) {
    console.error('[xradar] /xwatch add @' + handle + ' dest=' + dest + ' lookup failed:', e.message);
    return interaction.editReply('Could not find **@' + handle + '** on X — ' + e.message);
  }

  const { added } = addWatched(handle, profile, dest);
  // Re-running add still tries the list, so older follow-only watches get posts too.
  const sync = await syncHandleToFeedList(profile, dest);
  const listLine = describeListSync(sync);
  const who = profile.username || handle;

  if (!added) {
    return interaction.editReply('Already watching **@' + who + '** on ' + destLabel(dest) + '. ' + listLine);
  }

  return interaction.editReply(
    'Watching **@' + who + '** for new follows on **' + destLabel(dest) + '**.\n' + listLine,
  );
}

async function handleRemove(interaction, dest) {
  const handle = normalizeXHandle(interaction.options.getString('handle'));
  if (!handle) return interaction.editReply('That is not a valid X handle.');

  const cached = listWatched(dest)[handle];
  if (!removeWatched(handle, dest)) {
    return interaction.editReply("You weren't watching **@" + handle + '** on ' + destLabel(dest) + '.');
  }

  let profile = cached?.id ? { id: cached.id, username: cached.username || handle } : null;
  if (!profile) {
    try {
      profile = await getUserByScreenName(handle);
    } catch (e) {
      console.warn('[xradar] /xwatch remove lookup failed for @' + handle + ' dest=' + dest + ':', e.message);
    }
  }

  const sync = profile ? await unsyncHandleFromFeedList(profile, dest) : { skipped: 'no_user_id' };
  return interaction.editReply('Stopped watching **@' + handle + '** on ' + destLabel(dest) + '. ' + describeListSync(sync));
}

async function handleList(interaction, dest) {
  const users = listWatched(dest);
  const handles = Object.keys(users);
  if (!handles.length) {
    return interaction.editReply(
      'No X accounts on **' + destLabel(dest) + '** yet. `/xwatch add handle: someone` to start.',
    );
  }

  const lines = handles.map((h) => {
    const u = users[h];
    const name = u.name ? ' · ' + u.name : '';
    return '• **@' + (u.username || h) + '**' + name;
  });

  const embed = new EmbedBuilder()
    .setColor(0x1d9bf0)
    .setTitle(destLabel(dest) + ' X radar — ' + handles.length + ' account' + (handles.length === 1 ? '' : 's'))
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: 'Follows via radar · posts/comments via this dest\'s X list' });

  return interaction.editReply({ embeds: [embed] });
}
