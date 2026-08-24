/**
 * xradar/card.js — "this watched account just followed someone" embed.
 *
 * Compact on purpose: a busy KOL can follow several accounts in a session.
 * Handle + name + follower count + bio snippet + tap-through is enough to
 * decide whether to look.
 */

import { EmbedBuilder } from 'discord.js';
import { fmtCompact } from '../xSocial.js';

const X_BLUE = 0x1d9bf0;

export function clip(text, max = 180) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function profileUrl(username) {
  return 'https://x.com/' + (username || '');
}

/** Prefer the real X CDN avatar; unavatar is fallback only. */
export function pfpUrl(user, handle) {
  const raw = String(user?.avatarUrl || '').trim();
  if (raw && !/default_profile/i.test(raw)) {
    return raw
      .replace('_normal.', '_400x400.')
      .replace('_200x200.', '_400x400.')
      .replace('_bigger.', '_400x400.');
  }
  const h = handle || user?.username || '';
  return h ? 'https://unavatar.io/twitter/' + h : undefined;
}

/**
 * @param {object} watcher watched account
 * @param {object} followed newly followed account
 */
export function buildFollowCard(watcher, followed) {
  const wHandle = watcher.username || watcher.handle || 'unknown';
  const fHandle = followed.username || 'unknown';
  const bio = clip(followed.bio);
  const followers = fmtCompact(followed.followersCount || 0);
  const following = fmtCompact(followed.followingCount || 0);

  const lines = [
    '**@' + wHandle + '** followed **[@' + fHandle + '](' + profileUrl(fHandle) + ')**',
  ];
  if (followed.name) lines.push(followed.name);
  if (bio) lines.push(bio);
  lines.push(followers + ' followers · following ' + following);

  const followedPfp = pfpUrl(followed, fHandle);
  const watcherPfp = pfpUrl(watcher, wHandle);

  const embed = new EmbedBuilder()
    .setColor(X_BLUE)
    .setAuthor({
      name: '@' + wHandle + ' followed someone',
      iconURL: watcherPfp || followedPfp,
      url: profileUrl(wHandle),
    })
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'X follow radar' })
    .setTimestamp(new Date());

  if (followedPfp) embed.setThumbnail(followedPfp);
  return embed;
}

