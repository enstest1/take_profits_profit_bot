/**
 * xfeed/card.js — the live tweet card.
 *
 * Deliberately compact: X mark top-right (same treatment as the chain logo on
 * token cards), author line, the tweet itself, and a tap-through. A busy feed
 * means many of these in a channel, so anything that isn't scannable is noise.
 *
 * If the tweet contains a contract address it's surfaced in backticks so it can
 * be copied — or pasted straight back into the channel to auto-track.
 */

import { EmbedBuilder } from 'discord.js';
import { extractCA } from './filter.js';

const X_LOGO = 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
const X_BLUE = 0x1d9bf0;

export function fmtCount(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/** Discord embed descriptions cap at 4096; tweets are short but quote-tweets aren't. */
export function clip(text, max = 900) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function tweetUrl(t) {
  return 'https://x.com/' + (t.username || 'i') + '/status/' + t.id;
}

export function buildTweetCard(tweet, opts = {}) {
  const url = tweetUrl(tweet);
  const ca = extractCA(tweet.text);

  const lines = [clip(tweet.text)];
  if (ca) lines.push('`' + ca + '`');
  lines.push(
    '💬 ' + fmtCount(tweet.replies) + ' · 🔁 ' + fmtCount(tweet.retweets) +
      ' · ❤️ ' + fmtCount(tweet.likes) + ' · 👁 ' + fmtCount(tweet.views) +
      ' · [open](' + url + ')',
  );

  const embed = new EmbedBuilder()
    .setColor(X_BLUE)
    .setAuthor({
      name: '@' + (tweet.username || 'unknown') + (tweet.name ? ' · ' + tweet.name : ''),
      iconURL: 'https://unavatar.io/twitter/' + (tweet.username || 'x'),
      url: 'https://x.com/' + (tweet.username || ''),
    })
    .setDescription(lines.join('\n\n'))
    .setThumbnail(X_LOGO)
    .setTimestamp(tweet.timestamp ? new Date(tweet.timestamp * 1000) : new Date());

  if (opts.listLabel) embed.setFooter({ text: opts.listLabel });
  return embed;
}
