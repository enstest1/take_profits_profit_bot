/**
 * Trencher auto-tracking embed (v29 layout).
 */
import { EmbedBuilder } from 'discord.js';
import { chainAuthorName, parseStorageKey } from '../chains.js';
import { fmtCompactK, fmtClockTime } from './format.js';
import { chainLogoAttachment } from './assets.js';

const IND = '  ';

export function buildAutotrackDescription(message, ageStr, token) {
  const title = token.symbol
    ? '**' + token.name + '**' + IND + '— **' + token.symbol + '**'
    : '**' + token.name + '**';
  const poster = IND + '☎️ **' + message.author.username + '**' + (ageStr ? ' · ' + ageStr : '');
  const mcapTime =
    IND + '💎 `' + fmtCompactK(token.marketCap) + '` · ⌚ ' + fmtClockTime(message.createdTimestamp);
  return [title, poster, mcapTime].join('\n');
}

/**
 * @returns {{ embed: EmbedBuilder, files: import('discord.js').AttachmentBuilder[] }}
 */
export function buildAutotrackPayload(message, token, storageKey) {
  const { chainId } = parseStorageKey(storageKey);
  const chainKey = token.chain || chainId;
  const logo = chainLogoAttachment(chainKey);
  const ageStr = token.ageStr || null;

  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setAuthor({
      name: chainAuthorName(chainKey) + ' · Auto-Tracking 📡',
      iconURL: logo ? 'attachment://' + logo.name : undefined,
    })
    .setDescription(buildAutotrackDescription(message, ageStr, token));

  if (token.imageUrl) embed.setThumbnail(token.imageUrl);

  const files = logo ? [logo.file] : [];
  return { embed, files };
}
