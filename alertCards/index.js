/**
 * Trencher alert cards — shared Discord templates (Telegram phase B).
 * Gated by ALERT_CARDS_ENABLED; legacy cards remain in poller/autotrackHelpers when off.
 */
export { fmtCompactK, fmtClockTime, fmtRick, fmtCallerAgeShort, fmtWindowInline } from './format.js';
export { buildTradeLinksMarkdown, dexScreenerUrl, gmgnUrl, basedBotUrl, fomoUrl } from './links.js';
export { extractVolumeWindowsFromPair, windowsFrom5mCandles, resolveVolumeWindows } from './windows.js';
export { buildMilestoneAlert, sendMilestoneAlert } from './milestone.js';
export { buildAutotrackPayload, buildAutotrackDescription } from './autotrack.js';
export { chainLogoAttachment, CHART_ATTACHMENT_NAME } from './assets.js';

/** Trenches Discord channel — first production rollout target. */
export const DEFAULT_ALERT_CHANNEL_ID = process.env.ALERT_CARDS_CHANNEL_ID || '1452152164699869298';

/**
 * Master switch — defaults ON on feature/alert-cards.
 * Set ALERT_CARDS_ENABLED=false to force legacy cards everywhere.
 */
export function isAlertCardsEnabled() {
  const raw = process.env.ALERT_CARDS_ENABLED;
  if (raw == null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Trencher cards for a specific Discord channel.
 * Scoped to DEFAULT_ALERT_CHANNEL_ID unless ALERT_CARDS_ALL_CHANNELS=true.
 * @param {string} channelId Discord channel snowflake
 */
export function isAlertCardsEnabledForChannel(channelId) {
  if (!isAlertCardsEnabled()) return false;
  const all = String(process.env.ALERT_CARDS_ALL_CHANNELS || '').trim().toLowerCase();
  if (all === '1' || all === 'true' || all === 'yes') return true;
  return String(channelId) === String(DEFAULT_ALERT_CHANNEL_ID);
}
