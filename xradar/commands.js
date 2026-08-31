/**
 * xradar/commands.js — /xwatch add|remove|list|ping
 *
 * /xwatch add does two writes: follow-radar (dest store) and the dest's X list
 * xfeed polls. Guild picks the dest: tp4aph → empty TP radar + TP list;
 * Bitcernals → personal radar + personal list.
 *
 * Cards always post. /xwatch ping (or ping= on add) @s a Discord user only
 * for the events they opt into — posts, follows, replies/comments.
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { normalizeXHandle } from '../xSocial.js';
import { getUserByScreenName } from './xClient.js';
import { addWatched, removeWatched, listWatched, getWatched, setWatchedPings } from './store.js';
import { destFromGuildId, DEST_TP } from './config.js';
import {
  applyPingPatch,
  summarizePings,
  anyPingFlagSet,
} from './pings.js';
import {
  syncHandleToFeedList,
  unsyncHandleFromFeedList,
  describeListSync,
} from './listSync.js';

/** Shared posts/follows/replies toggles — keep names identical on add + ping. */
function addEventOptions(sc) {
  return sc
    .addBooleanOption((o) =>
      o.setName('posts').setDescription('Ping when they post (not replies/comments)'),
    )
    .addBooleanOption((o) =>
      o.setName('follows').setDescription('Ping when they follow someone new'),
    )
    .addBooleanOption((o) =>
      o.setName('replies').setDescription('Ping when they reply or comment'),
    );
}

export const xwatchCommand = new SlashCommandBuilder()
  .setName('xwatch')
  .setDescription('Watch an X account for new follows, posts, and replies')
  .addSubcommand((sc) =>
    addEventOptions(
      sc
        .setName('add')
        .setDescription('Start watching an X handle (also adds them to the posts list)')
        .addStringOption((o) =>
          o.setName('handle').setDescription('X handle or profile URL').setRequired(true),
        )
        .addUserOption((o) =>
          o.setName('ping').setDescription('Discord user to @ on chosen events (cards still always post)'),
        ),
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
  .addSubcommand((sc) => sc.setName('list').setDescription('Show every watched X account'))
  .addSubcommand((sc) =>
    addEventOptions(
      sc
        .setName('ping')
        .setDescription('Who to @ for this X account, and on which events')
        .addStringOption((o) =>
          o.setName('handle').setDescription('X handle already on /xwatch').setRequired(true),
        )
        .addUserOption((o) =>
          o.setName('user').setDescription('Discord user to @ (defaults to you)'),
        )
        .addBooleanOption((o) =>
          o.setName('off').setDescription('Remove pings for this user (or all, if user is omitted)'),
        ),
    ),
  );

function destLabel(dest) {
  return dest === DEST_TP ? 'Take Profits' : 'personal';
}

function flagsFromInteraction(interaction) {
  return {
    post: interaction.options.getBoolean('posts'),
    follow: interaction.options.getBoolean('follows'),
    reply: interaction.options.getBoolean('replies'),
  };
}

/**
 * Persist ping flags for a Discord user on a watched handle.
 * @returns {string} human summary line (may be empty)
 */
function applyPings(handle, dest, discordUserId, flags) {
  const current = getWatched(handle, dest);
  if (!current) return '';
  const next = applyPingPatch(current.pings, discordUserId, flags);
  setWatchedPings(handle, dest, next);
  const summary = summarizePings(next);
  return summary ? 'Pings: ' + summary : 'No pings — cards still post silently.';
}

export async function handleXwatch(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const dest = destFromGuildId(interaction.guildId);
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') return handleAdd(interaction, dest);
  if (sub === 'remove') return handleRemove(interaction, dest);
  if (sub === 'ping') return handlePing(interaction, dest);
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

  const pingUser = interaction.options.getUser('ping');
  const flags = flagsFromInteraction(interaction);
  let pingLine = '';
  if (pingUser || anyPingFlagSet(flags)) {
    const userId = (pingUser || interaction.user).id;
    // Ping user with no event flags → posts only (the usual "ping me when they tweet" case).
    const resolved = anyPingFlagSet(flags) ? flags : { post: true, follow: null, reply: null };
    if (!resolved.post && !resolved.follow && !resolved.reply) {
      pingLine = 'Pick at least one of `posts` / `follows` / `replies` to ping.';
    } else {
      pingLine = applyPings(handle, dest, userId, resolved);
    }
  }

  const pingBlock = pingLine ? '\n' + pingLine : '';
  if (!added) {
    return interaction.editReply('Already watching **@' + who + '** on ' + destLabel(dest) + '. ' + listLine + pingBlock);
  }

  return interaction.editReply(
    'Watching **@' + who + '** on **' + destLabel(dest) + '**. Cards always post.\n' + listLine + pingBlock,
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

async function handlePing(interaction, dest) {
  const handle = normalizeXHandle(interaction.options.getString('handle'));
  if (!handle) return interaction.editReply('That is not a valid X handle.');

  const watched = getWatched(handle, dest);
  if (!watched) {
    return interaction.editReply(
      "You aren't watching **@" + handle + '** on ' + destLabel(dest) + '. `/xwatch add` first.',
    );
  }

  const off = interaction.options.getBoolean('off');
  const pingUser = interaction.options.getUser('user');
  const flags = flagsFromInteraction(interaction);

  if (off) {
    const line = applyPings(handle, dest, pingUser?.id || '', { clear: true });
    return interaction.editReply('Updated **@' + handle + '**. ' + line);
  }

  if (!anyPingFlagSet(flags) && !pingUser) {
    const summary = summarizePings(watched.pings);
    return interaction.editReply(
      summary
        ? '**@' + handle + '** pings: ' + summary
        : '**@' + handle + '** has no pings — cards still post. Set `user` + `posts`/`follows`/`replies`.',
    );
  }

  const userId = (pingUser || interaction.user).id;
  const resolved = anyPingFlagSet(flags) ? flags : { post: true, follow: null, reply: null };
  if (!resolved.post && !resolved.follow && !resolved.reply) {
    return interaction.editReply('Pick at least one of `posts` / `follows` / `replies` (or `off:true` to clear).');
  }
  const line = applyPings(handle, dest, userId, resolved);
  return interaction.editReply('Updated **@' + handle + '**. ' + line);
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
    const pings = summarizePings(u.pings);
    const pingBit = pings ? '\n  ping ' + pings : '';
    return '• **@' + (u.username || h) + '**' + name + pingBit;
  });

  const embed = new EmbedBuilder()
    .setColor(0x1d9bf0)
    .setTitle(destLabel(dest) + ' X radar — ' + handles.length + ' account' + (handles.length === 1 ? '' : 's'))
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: 'Cards always post · /xwatch ping to @ someone on posts, follows, or replies' });

  return interaction.editReply({ embeds: [embed] });
}
