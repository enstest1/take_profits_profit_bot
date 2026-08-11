/**
 * Trencher milestone / +75% Discord embed builder (v26 layout).
 */
import { EmbedBuilder } from 'discord.js';
import { chainAuthorName, parseStorageKey } from '../chains.js';
import { fmtRick, fmtCompactK, fmtCallerAgeShort, fmtWindowInline } from './format.js';
import { linksForStorageKey } from './links.js';
import { chainLogoAttachment, CHART_ATTACHMENT_NAME } from './assets.js';
import { resolveVolumeWindows } from './windows.js';
import { buildMilestoneChart } from './chart.js';

const IND = '  ';

function takeProfitBanner() {
  return '💰💰💰 **Take Profit** 💰💰💰';
}

function buildAuthorLine(chainName, symbol, alertKind, tier) {
  if (alertKind === 'gain75') return chainName + ' · ' + symbol + ' · +75% 🚀';
  const mult = tier != null ? tier : String(alertKind).replace('tier', '');
  return chainName + ' · ' + symbol + ' · ' + mult + 'x 🚀';
}

function buildMcapLiqLine(callMcap, nowMcap, liquidity) {
  return (
    '💎 `' +
    fmtRick(callMcap) +
    '` → `' +
    fmtRick(nowMcap) +
    '` · 💧 `' +
    fmtRick(liquidity) +
    '`'
  );
}

function tokenThumbnail(entry, live) {
  if (entry?.imageUrl) return entry.imageUrl;
  if (live?.rawPump?.image_uri) return live.rawPump.image_uri;
  if (live?.imageUrl) return live.imageUrl;
  return null;
}

/**
 * Build milestone embed + file attachments (chain logo, optional chart).
 * @param {object} opts
 * @returns {Promise<{ embed: EmbedBuilder, files: import('discord.js').AttachmentBuilder[] }>}
 */
export async function buildMilestoneAlert({
  entry,
  live,
  storageKey,
  alertKind,
  tier = null,
  skipChart = false,
}) {
  const { chainId, address } = parseStorageKey(storageKey);
  const chainKey = entry.chain || chainId;
  const chainName = chainAuthorName(chainKey);
  const symbol = entry.symbol || live?.symbol || '?';
  const name = entry.name || live?.name || symbol;
  const callMcap = entry.mcapAtCall ?? null;
  const nowMcap = live?.marketCap ?? null;
  const liquidity = live?.liquidity ?? entry.liquidityAtCall ?? null;
  const links = linksForStorageKey(storageKey);

  let windows = resolveVolumeWindows({ liveWindows: live?.volumeWindows });
  let chartFile = null;

  if (!skipChart) {
    const chart = await buildMilestoneChart({
      chainId: chainKey,
      address: entry.address || address,
      symbol,
      callMcap,
      currentMcap: nowMcap,
      pairAddress: live?.pairAddress || entry.pairAddress,
    });
    chartFile = chart.chartFile;
    windows = resolveVolumeWindows({ liveWindows: live?.volumeWindows, candles5m: chart.candles5m });
  }

  const description = [
    name + ' · `' + fmtRick(nowMcap) + '`',
    buildMcapLiqLine(callMcap, nowMcap, liquidity),
    fmtWindowInline(windows),
    links.markdown,
    '',
    takeProfitBanner(),
  ].join('\n');

  const logo = chainLogoAttachment(chainKey);
  const color = alertKind === 'gain75' ? 0x00ff88 : 0xffd700;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: buildAuthorLine(chainName, symbol, alertKind, tier),
      iconURL: logo ? 'attachment://' + logo.name : undefined,
    })
    .setDescription(description)
    .setFooter({ text: '📞 ' + entry.postedBy + ' · ' + fmtCallerAgeShort(entry.postedAt) });

  const thumb = tokenThumbnail(entry, live);
  if (thumb) embed.setThumbnail(thumb);
  if (chartFile) embed.setImage('attachment://' + CHART_ATTACHMENT_NAME);

  const files = [];
  if (logo) files.push(logo.file);
  if (chartFile) files.push(chartFile);

  return { embed, files };
}

/**
 * Send a milestone alert via channelAlert.sendTokenAlert.
 */
export async function sendMilestoneAlert(client, db, storageKey, entry, live, { alertKind, tier, label, sendTokenAlert }) {
  const { embed, files } = await buildMilestoneAlert({
    entry,
    live,
    storageKey,
    alertKind,
    tier,
  });
  return sendTokenAlert(client, db, storageKey, embed, alertKind, label, files.length ? files : null);
}
