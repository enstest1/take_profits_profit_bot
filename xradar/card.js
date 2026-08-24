/**
 * xradar/card.js — "this watched account just followed someone" embed.
 *
 * Compact on purpose: a busy KOL can follow several accounts in a session.
 * Handle + name + follower count + bio snippet + tap-through is enough to
 * decide whether to look.
 */

import { EmbedBuilder } from 'discord.js';
import { fmtCompact } from '../xSocial.js';

const X_LOGO = 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
const X_BLUE = 0x1d9bf0;

export function clip(text, max = 180) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function profileUrl(username) {
  return 'https://x.com/' + (username || '');
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

  return new EmbedBuilder()
    .setColor(X_BLUE)
    .setAuthor({
      name: '@' + wHandle + ' followed someone',
      iconURL: followed.avatarUrl || 'https://unavatar.io/twitter/' + wHandle,
      url: profileUrl(wHandle),
    })
    .setDescription(lines.join('\n'))
    .setThumbnail(X_LOGO)
    .setFooter({ text: 'X follow radar' })
    .setTimestamp(new Date());
}
