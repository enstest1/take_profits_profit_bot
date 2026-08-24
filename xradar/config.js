/**
 * xradar/config.js — follow-radar settings.
 *
 * Watches X handles you add (/xwatch or XRADAR_HANDLES) and alerts when they
 * follow someone new. Distinct from xfeed/ (posts + replies from the same
 * accounts). Both default to the personal test channel so flipping the flag
 * is enough to see cards.
 */

function envInt(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return fallback;
}

/** Personal Discord test channel — override with XRADAR_CHANNEL_ID or X_SCANNER_CHANNEL_ID. */
export const DEFAULT_X_SCANNER_CHANNEL_ID = '1541180128564875304';

export function parseHandleList(raw) {
  return String(raw || '')
    .split(/[, \s]+/)
    .map((s) => s.replace(/^@/, '').trim().toLowerCase())
    .filter((s) => /^[a-z0-9_]{1,15}$/.test(s));
}

export function scannerChannelId(specificEnv) {
  return (
    process.env[specificEnv]?.trim() ||
    process.env.X_SCANNER_CHANNEL_ID?.trim() ||
    DEFAULT_X_SCANNER_CHANNEL_ID
  );
}

export function getXRadarConfig() {
  return {
    enabled: envBool('XRADAR_ENABLED', false),
    channelId: scannerChannelId('XRADAR_CHANNEL_ID'),
    /** Seed watch list on boot; /xwatch can add more at runtime. */
    handles: parseHandleList(process.env.XRADAR_HANDLES),
    pollSec: envInt('XRADAR_POLL_SEC', 300),
    /** Newest-first page only — enough to catch new follows between ticks. */
    pageCount: envInt('FOLLOWING_PAGE_COUNT', 20),
    maxNewPerUser: envInt('XRADAR_MAX_NEW_PER_USER', 8),
    userGapMs: envInt('XRADAR_USER_GAP_MS', 1500),
    debug: envBool('XRADAR_DEBUG', false),
  };
}
