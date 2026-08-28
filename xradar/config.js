/**
 * xradar/config.js — follow-radar settings.
 *
 * Watches X handles you add (/xwatch or XRADAR_HANDLES) and alerts when they
 * follow someone new. Distinct from xfeed/ (posts + replies from X lists).
 *
 * Personal and Take Profits do NOT share a watch list. Fan-out of the same
 * radar to both Discords leaked personal follows (e.g. @BIL_818) into TP.
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

/** Personal Bitcernals radar (existing db.xRadar). */
export const DEST_PERSONAL = 'personal';
/** Take Profits radar (empty db.xRadarTp until /xwatch in that guild). */
export const DEST_TP = 'tp';

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

/** Comma-separated Discord channel ids. Empty parts dropped. */
export function parseChannelIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Guild that owns the Take Profits /xwatch list (tp4aph). */
export function tpRadarGuildId(env = process.env) {
  return (env.XRADAR_TP_GUILD_ID || env.KB_GUILD_ID || '').trim();
}

/**
 * Pick the radar dest from the slash-command guild.
 * tp4aph → empty TP store; everywhere else → personal store.
 * @param {string|null|undefined} guildId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function destFromGuildId(guildId, env = process.env) {
  const tpGuild = tpRadarGuildId(env);
  if (tpGuild && String(guildId || '') === tpGuild) return DEST_TP;
  return DEST_PERSONAL;
}

/**
 * Isolated radar destinations. TP is omitted until XRADAR_TP_CHANNEL_ID is set
 * so a misconfigured env cannot leak personal follows into trenches.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{id: string, channelId: string, guildId: string}>}
 */
export function getRadarDestinations(env = process.env) {
  const personalChannel =
    env.XRADAR_CHANNEL_ID?.trim() ||
    env.X_SCANNER_CHANNEL_ID?.trim() ||
    DEFAULT_X_SCANNER_CHANNEL_ID;
  const dests = [
    {
      id: DEST_PERSONAL,
      channelId: personalChannel,
      guildId: (env.GUILD_ID || '').trim(),
    },
  ];
  const tpChannel = env.XRADAR_TP_CHANNEL_ID?.trim();
  if (tpChannel) {
    dests.push({
      id: DEST_TP,
      channelId: tpChannel,
      guildId: tpRadarGuildId(env),
    });
  }
  return dests.filter((d) => d.channelId);
}

export function getXRadarConfig() {
  const dests = getRadarDestinations();
  const channelId = dests[0]?.channelId || '';
  return {
    enabled: envBool('XRADAR_ENABLED', false),
    channelId,
    /** One channel per dest — do not fan the same watch list out. */
    channelIds: dests.map((d) => d.channelId),
    dests,
    /** Seed the *personal* watch list on boot; TP stays empty. */
    handles: parseHandleList(process.env.XRADAR_HANDLES),
    pollSec: envInt('XRADAR_POLL_SEC', 300),
    /** Newest-first page only — enough to catch new follows between ticks. */
    pageCount: envInt('FOLLOWING_PAGE_COUNT', 20),
    maxNewPerUser: envInt('XRADAR_MAX_NEW_PER_USER', 8),
    userGapMs: envInt('XRADAR_USER_GAP_MS', 1500),
    debug: envBool('XRADAR_DEBUG', false),
  };
}
