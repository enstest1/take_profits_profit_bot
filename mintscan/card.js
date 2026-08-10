/**
 * mintscan/card.js — the mint alert card.
 *
 * Trencher styling to match the rest of the bot: chain identity leads, the
 * numbers that drive a decision come next, links last. Pure function → fully
 * testable without a chain or Discord.
 *
 * Layout:
 *   🔥 Glitch Demon                          [collection image thumb]
 *   HOT · 99 mints in ~25 blocks · 19.8/min
 *   20 unique minters
 *   Supply: 197 / 1,000 (19.7% minted)
 *   Mint: 0.001 ETH · Floor: 0.0033 ETH · Owners: 388
 *   `0x…`
 *   OpenSea · X · Contract · TX
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

/** Supply / price / floor lines — omitted entirely when unknown. */
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
 * buildMintCard(alert, chain) → EmbedBuilder
 * alert: { tier, contract, collectionName, openSeaSlug, twitterUsername, imageUrl,
 *          totalSupply, maxSupply, mintPct, mintPriceEth, floorPriceEth, numOwners,
 *          mints, perMin, unique, sampleTx, windowBlocks }
 */
export function buildMintCard(alert, chain) {
  const style = TIER_STYLE[alert.tier] || TIER_STYLE.WARM;

  const lines = [
    '**' + alert.tier + '** · **' + formatSupply(alert.mints) + '** mints in ~' +
      alert.windowBlocks + ' blocks · **' + alert.perMin.toFixed(1) + '/min**',
    '**' + formatSupply(alert.unique) + '** unique minters',
    ...marketLines(alert),
    '`' + alert.contract + '`',
  ];

  // Links: OpenSea (chain-filtered), project X, explorer contract + tx.
  const links = [];
  if (alert.openSeaSlug) {
    links.push('[OpenSea](https://opensea.io/collection/' + alert.openSeaSlug + ')');
  }
  if (alert.twitterUsername) {
    links.push('[X](https://x.com/' + alert.twitterUsername + ')');
  }
  links.push('[Contract](' + chain.explorerBase + '/address/' + alert.contract + ')');
  if (alert.sampleTx) {
    links.push('[TX](' + chain.explorerBase + '/tx/' + alert.sampleTx + ')');
  }
  lines.push(links.join(' · '));

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(style.emoji + ' ' + (alert.collectionName || 'Unknown Collection'))
    .setDescription(lines.join('\n'))
    .setFooter({ text: chain.label + ' · mint scanner' })
    .setTimestamp();

  if (alert.openSeaSlug) embed.setURL('https://opensea.io/collection/' + alert.openSeaSlug);
  if (alert.imageUrl && String(alert.imageUrl).startsWith('http')) embed.setThumbnail(alert.imageUrl);

  return embed;
}
