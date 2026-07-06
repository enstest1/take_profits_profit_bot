/** Shared auto-track completion — embed, rugscan, deployer, subscriptions. */
import { EmbedBuilder } from 'discord.js';
import { chainBadge, chainLabel, parseStorageKey } from './chains.js';
import { callerStatLine } from './callerStats.js';
import { scanOnTrack } from './risk/rugscan.js';
import { indexDeployer, deployerHistoryLine } from './risk/deployers.js';
import { notifyFollowSubscribers } from './subscriptions.js';
import { recordChannelSighting } from './signals/confluence.js';
import { subscribeDevWallet } from './webhooks/devSell.js';
import { saveDB } from './dbStore.js';
import { xHistoryLine, indexXAccount } from './xSocial.js';

export function fmtUsd(n) {
  if (!n || isNaN(Number(n))) return '—';
  const num = Number(n);
  if (num >= 1000000000) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1000000) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1000) return '$' + (num / 1e3).toFixed(1) + 'K';
  return '$' + num.toFixed(4);
}

export async function onAlreadyTracking(client, db, storageKey, message) {
  await recordChannelSighting(client, db, storageKey, message.channelId);
  saveDB(db);
}

export function buildTrackingDescription(message, ageStr, token, db, storageKey) {
  const statLine = callerStatLine(db, message.author.id);
  const { chainId } = parseStorageKey(storageKey);
  const poster =
    'Posted by **' + message.author.username + '**' +
    (statLine ? ' — ' + statLine : '') +
    (ageStr ? ' · ' + ageStr : '');
  const parts = [poster, 'MCap: **' + fmtUsd(token.marketCap) + '**'];
  if (token.platform === 'pumpfun' && !token.complete) {
    parts.push('⏳ Bonding curve: **' + (token.bondingProgress ? token.bondingProgress.toFixed(0) : 0) + '%** to Raydium');
  }
  if (token.liquidity > 0) {
    parts.push('Liq at call: **' + fmtUsd(token.liquidity) + '**');
  }
  const devLine = token.creator ? deployerHistoryLine(db, token.creator, storageKey) : '';
  if (devLine) parts.push(devLine);
  if (token.xHandle) {
    const xLine = xHistoryLine(db, token.xHandle, storageKey);
    if (xLine) parts.push(xLine);
  }
  return parts.join('\n');
}

export async function sendTrackingEmbed(message, token, storageKey, db, buildEntryFn) {
  const ageStr = token.ageStr || null;
  const { chainId } = parseStorageKey(storageKey);
  const chainKey = token.chain || chainId;

  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setAuthor({
      name: chainBadge(chainKey) + ' 📡 Auto-tracking: ' + token.name + ' (' + token.symbol + ')',
    })
    .setDescription(buildTrackingDescription(message, ageStr, token, db, storageKey))
    .setFooter({ text: chainLabel(chainKey) })
    .setTimestamp();
  if (token.imageUrl) embed.setThumbnail(token.imageUrl);

  const sentMsg = await message.channel.send({ embeds: [embed] });
  const entry = buildEntryFn();
  if (token.liquidity > 0) entry.liquidityAtCall = token.liquidity;
  db.tokens[storageKey] = entry;
  if (entry.xHandle) indexXAccount(db, entry.xHandle, storageKey);
  saveDB(db);

  if (entry.devWallet) {
    indexDeployer(db, entry.devWallet, storageKey);
    subscribeDevWallet(db, storageKey, entry.devWallet).catch((e) =>
      console.error('[devsell] subscribe:', e.message),
    );
  }

  scanOnTrack(null, db, storageKey, entry, sentMsg).catch((e) =>
    console.error('[rugscan] non-fatal:', e.message),
  );
  notifyFollowSubscribers(message.client, db, entry, storageKey, embed).catch((e) =>
    console.error('[follow] notify:', e.message),
  );

  console.log(
    '[tracked] ' + token.name + ' (' + token.symbol + ') [' + chainLabel(chainKey) + '] — posted by ' +
    message.author.username,
  );
  return entry;
}
