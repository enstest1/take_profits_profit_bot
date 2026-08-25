/**
 * nfttp/cards.js — trencher-layout NFT cards (same skeleton as alertCards/).
 *
 * Token card:  chain · SYMBOL · 5x  /  💎 mcap → mcap · 💧 liq
 * NFT card:    chain · TICKER · 5x  /  💎 floor → floor · 💧 owners
 */

import { EmbedBuilder } from 'discord.js';
import { fmtRick, fmtCompactK, fmtClockTime, fmtCallerAgeShort, fmtWindowInline } from '../alertCards/format.js';
import { chainLogoAttachment, CHART_ATTACHMENT_NAME } from '../alertCards/assets.js';

const IND = '  ';

/** Floor formatter. Pass `''` to omit the unit (left side of 💎 call → now). */
export function fmtEth(n, symbol = 'ETH') {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const num = Number(n);
  const abs = Math.abs(num);
  let body;
  if (abs >= 1e3) body = fmtRick(num);
  else if (abs >= 1) body = num.toFixed(2).replace(/\.?0+$/, '');
  else if (abs >= 0.01) body = num.toFixed(3).replace(/\.?0+$/, '');
  else body = num.toFixed(4).replace(/\.?0+$/, '');
  if (symbol === '') return body;
  return body + ' ' + (symbol || 'ETH');
}

export function nftMarketLinks(entry) {
  const slug = entry.slug;
  const chain = String(entry.chain || 'ethereum').toLowerCase();
  const addr = entry.address;
  const parts = ['[OpenSea](https://opensea.io/collection/' + slug + ')'];
  if (addr && (chain === 'ethereum' || chain === 'eth')) {
    parts.push('[Blur](https://blur.io/eth/collection/' + addr.toLowerCase() + ')');
  }
  if (addr) {
    const meChain = chain === 'ethereum' ? 'ethereum' : chain;
    parts.push('[Magic Eden](https://magiceden.io/collections/' + meChain + '/' + addr + ')');
  }
  return parts.join(' · ');
}

function takeProfitBanner() {
  return '💰💰💰 **Take Profit** 💰💰💰';
}

function chainLabel(chain) {
  const id = String(chain || 'ethereum');
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function authorLine(entry, alertKind, tier) {
  const chain = chainLabel(entry.chain);
  const ticker = entry.ticker || 'NFT';
  if (alertKind === 'gain75') return chain + ' · ' + ticker + ' · +75% 🚀';
  const mult = tier != null ? tier : String(alertKind).replace('tier', '');
  return chain + ' · ' + ticker + ' · ' + mult + 'x 🚀';
}

function ageFromCreated(createdAt) {
  if (!createdAt) return null;
  const ageHours = (Date.now() - Number(createdAt)) / 3600000;
  if (ageHours < 1) return '⚡ ' + Math.max(1, Math.round(ageHours * 60)) + 'm old';
  if (ageHours < 24) return '⚡ ' + Math.floor(ageHours) + 'h old';
  const days = Math.floor(ageHours / 24);
  if (days < 60) return '⚡ ' + days + 'd old';
  const years = (days / 365).toFixed(1).replace(/\.0$/, '');
  return '⚡ ' + years + 'y old';
}

/**
 * Auto-track payload — v29 trencher skeleton.
 */
export function buildNftAutotrackPayload(message, entry) {
  const logo = chainLogoAttachment(entry.chain);
  const ageStr = ageFromCreated(entry.createdAt);
  const title = entry.ticker
    ? '**' + entry.name + '**' + IND + '— **' + entry.ticker + '**'
    : '**' + entry.name + '**';
  const poster = IND + '☎️ **' + message.author.username + '**' + (ageStr ? ' · ' + ageStr : '');
  const floorTime =
    IND +
    '💎 `' +
    fmtEth(entry.floorAtCall, entry.floorSymbol) +
    '` · ⌚ ' +
    fmtClockTime(message.createdTimestamp);

  const embed = new EmbedBuilder()
    .setColor(0x00ccff)
    .setAuthor({
      name: chainLabel(entry.chain) + ' · Auto-Tracking 📡',
      iconURL: logo ? 'attachment://' + logo.name : undefined,
    })
    .setDescription([title, poster, floorTime].join('\n'));

  if (entry.imageUrl) embed.setThumbnail(entry.imageUrl);
  if (entry.openseaUrl) embed.setURL(entry.openseaUrl);

  return { embed, files: logo ? [logo.file] : [] };
}

/**
 * Milestone / +75% payload — v26 trencher skeleton.
 * @param {{ chartFile?: import('discord.js').AttachmentBuilder|null, windows?: object[] }} extras
 */
export function buildNftMilestoneAlert({ entry, live, alertKind, tier = null, chartFile = null, windows = [] }) {
  const logo = chainLogoAttachment(entry.chain);
  const callFloor = live?.floorAtCall ?? entry.floorAtCall;
  const nowFloor = live?.floor ?? entry.lastFloor;
  const owners = live?.numOwners ?? entry.lastOwners ?? entry.ownersAtCall;
  const sym = live?.floorSymbol || entry.floorSymbol || 'ETH';

  const description = [
    (entry.name || entry.ticker) + ' · `' + fmtEth(nowFloor, sym) + '`',
    '💎 `' +
      fmtEth(callFloor, '') +
      '` → `' +
      fmtEth(nowFloor, sym) +
      '` · 💧 `' +
      fmtCompactK(owners) +
      '`',
    fmtWindowInline(windows),
    nftMarketLinks(entry),
    '',
    takeProfitBanner(),
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(alertKind === 'gain75' ? 0x00ff88 : 0xffd700)
    .setAuthor({
      name: authorLine(entry, alertKind, tier),
      iconURL: logo ? 'attachment://' + logo.name : undefined,
    })
    .setDescription(description)
    .setFooter({ text: '📞 ' + entry.postedBy + ' · ' + fmtCallerAgeShort(entry.postedAt) });

  if (entry.imageUrl) embed.setThumbnail(entry.imageUrl);
  if (entry.openseaUrl) embed.setURL(entry.openseaUrl);
  if (chartFile) embed.setImage('attachment://' + CHART_ATTACHMENT_NAME);

  const files = [];
  if (logo) files.push(logo.file);
  if (chartFile) files.push(chartFile);
  return { embed, files };
}
