/**
 * Trencher alert cards — shared Discord templates (Telegram phase B).
 * Default ON for every Discord channel. Legacy embeds in poller/autotrackHelpers
 * are reference-only and only run when ALERT_CARDS_ENABLED=false.
 */
export { fmtCompactK, fmtClockTime, fmtRick, fmtCallerAgeShort, fmtWindowInline } from './format.js';
export { buildTradeLinksMarkdown, dexScreenerUrl, gmgnUrl, basedBotUrl, fomoUrl } from './links.js';
export { extractVolumeWindowsFromPair, windowsFrom5mCandles, resolveVolumeWindows } from './windows.js';
export { buildMilestoneAlert, sendMilestoneAlert } from './milestone.js';
export { buildAutotrackPayload, buildAutotrackDescription } from './autotrack.js';
export { chainLogoAttachment, CHART_ATTACHMENT_NAME } from './assets.js';

/** @deprecated Channel scoping removed — trencher cards apply to every channel when enabled. */
export const DEFAULT_ALERT_CHANNEL_ID = process.env.ALERT_CARDS_CHANNEL_ID || '1452152164699869298';

/**
 * Master switch — defaults ON. Set ALERT_CARDS_ENABLED=false only to render
 * the old EmbedBuilder cards (kept in-repo for reference, not used in prod).
 */
export function isAlertCardsEnabled() {
  const raw = process.env.ALERT_CARDS_ENABLED;
  if (raw == null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Trencher cards for a Discord channel. Rollout used to pin one channel ID;
 * that gate is retired — every channel gets the updated layout when enabled.
 * @param {string} [_channelId] unused; kept so call sites stay unchanged
 */
export function isAlertCardsEnabledForChannel(_channelId) {
  return isAlertCardsEnabled();
}
