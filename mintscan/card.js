/**
 * mintscan/card.js — the mint alert card.
 *
 * Compact one-liner: supply · unique minters · OpenSea link.
 */

import { EmbedBuilder } from 'discord.js';

const TIER_STYLE = {
  WARM: { emoji: '🌤️', color: 0xf59e0b },
  HOT: { emoji: '🔥', color: 0xef4444 },
  MOONING: { emoji: '🚀', color: 0x22c55e },
};

export function formatEth(eth) {
  if (eth == null || !Number.isFinite(eth)) return null;
  if (eth < 0.0001) return eth.toFixed(6) + ' ETH';
  if (eth < 1) return eth.toFixed(4) + ' ETH';
  return eth.toFixed(2) + ' ETH';
}

export function formatSupply(n) {
  return Number(n).toLocaleString('en-US');
}

/** Supply / price / floor lines — kept for tests and optional future use. */
export function marketLines(meta) {
  const lines = [];
  if (meta.totalSupply != null && meta.maxSupply != null && meta.mintPct != null) {
    lines.push(
      'Supply: **' + formatSupply(meta.totalSupply) + ' / ' + formatSupply(meta.maxSupply) +
        '** (' + meta.mintPct.toFixed(1) + '% minted)',
    );
  } else if (meta.totalSupply != null) {
    lines.push('Supply: **' + formatSupply(meta.totalSupply) + '** minted');
  }

  const bits = [];
  const mint = formatEth(meta.mintPriceEth);
  const floor = formatEth(meta.floorPriceEth);
  if (mint) bits.push('Mint: **' + mint + '**');
  if (floor) bits.push('Floor: **' + floor + '**');
  if (meta.numOwners != null) bits.push('Owners: **' + formatSupply(meta.numOwners) + '**');
  if (bits.length) lines.push(bits.join(' · '));

  return lines;
}

/**
 * One-line body: supply · unique minters · OpenSea.
 * @param {object} alert
 * @returns {string}
 */
export function buildMintCardLine(alert) {
  const supply =
    alert.totalSupply != null && alert.maxSupply != null
      ? formatSupply(alert.totalSupply) + '/' + formatSupply(alert.maxSupply)
      : alert.totalSupply != null
        ? formatSupply(alert.totalSupply)
        : '—';

  const parts = ['**' + supply + '** supply', '**' + formatSupply(alert.unique) + '** unique'];
  if (alert.openSeaSlug) {
    parts.push('[OpenSea](https://opensea.io/collection/' + alert.openSeaSlug + ')');
  }
  return parts.join(' · ');
}

/**
 * buildMintCard(alert, chain) → EmbedBuilder
 */
export function buildMintCard(alert, _chain) {
  const style = TIER_STYLE[alert.tier] || TIER_STYLE.WARM;

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(style.emoji + ' ' + alert.tier + ' · ' + (alert.collectionName || 'Unknown Collection'))
    .setDescription(buildMintCardLine(alert));

  if (alert.openSeaSlug) embed.setURL('https://opensea.io/collection/' + alert.openSeaSlug);
  if (alert.imageUrl && String(alert.imageUrl).startsWith('http')) embed.setThumbnail(alert.imageUrl);

  return embed;
}
