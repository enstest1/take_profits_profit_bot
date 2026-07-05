/** Caller reputation cache — rebuilt from token entries; db.callers is not source of truth. */
import { CFG } from './signals/config.js';

const MS_24H = CFG.RESOLVED_CALL_AGE_MS;

function allCallsForUser(db, userId) {
  const out = [];
  for (const e of Object.values(db.tokens || {})) {
    if (e.postedByUserId === userId) out.push(e);
  }
  for (const e of Object.values(db.archived || {})) {
    if (e.postedByUserId === userId) out.push(e);
  }
  return out;
}

function isResolved(entry, now) {
  return now - (entry.postedAt || 0) >= MS_24H;
}

function isRug(entry, now) {
  if (!isResolved(entry, now)) return false;
  return (Number(entry.peakMultiple) || 1) < 0.5;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function computeStatsForUser(db, userId, displayName, now = Date.now()) {
  const calls = allCallsForUser(db, userId);
  if (!calls.length) return null;

  const totalCalls = calls.length;
  const hits2x = calls.filter((e) => (Number(e.peakMultiple) || 1) >= 2).length;
  const rugs = calls.filter((e) => isRug(e, now)).length;

  const peaks = calls
    .map((e) => Number(e.peakMultiple))
    .filter((p) => Number.isFinite(p));
  const avgPeak =
    peaks.length > 0
      ? Math.round((peaks.reduce((a, b) => a + b, 0) / peaks.length) * 10) / 10
      : 1;

  const minsTo2x = [];
  for (const e of calls) {
    if ((Number(e.peakMultiple) || 1) < 2) continue;
    // Approximation: athLedger.peakAt or peakAt when per-tier timestamps absent.
    const firstTierAt = e.athLedger?.peakAt || e.peakAt || e.postedAt;
    if (firstTierAt && e.postedAt) {
      minsTo2x.push((firstTierAt - e.postedAt) / 60000);
    }
  }
  const medianMinsTo2x = median(minsTo2x);

  let bestCall = null;
  let bestPeak = 0;
  for (const e of calls) {
    const p = Number(e.peakMultiple) || 1;
    if (p > bestPeak) {
      bestPeak = p;
      bestCall = {
        mint: e.address,
        symbol: e.symbol || '?',
        peak: p,
        at: e.peakAt || e.postedAt,
      };
    }
  }

  const sorted = [...calls].sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
  let streak2x = 0;
  for (const e of sorted) {
    if (!isResolved(e, now)) continue;
    if ((Number(e.peakMultiple) || 1) >= 2) streak2x += 1;
    else break;
  }

  return {
    name: displayName || calls[0]?.postedBy || userId,
    totalCalls,
    hits2x,
    rugs,
    avgPeak,
    medianMinsTo2x: medianMinsTo2x != null ? Math.round(medianMinsTo2x) : null,
    bestCall,
    streak2x,
    updatedAt: now,
  };
}

export function ensureCallersDb(db) {
  db.callers = db.callers || {};
  return db.callers;
}

/** Rebuild db.callers from scratch. Pure — caller must saveDB. */
export function rebuildCallerStats(db, now = Date.now()) {
  const callers = ensureCallersDb(db);
  const byUser = new Map();
  for (const e of Object.values(db.tokens || {})) {
    if (!e.postedByUserId) continue;
    if (!byUser.has(e.postedByUserId)) {
      byUser.set(e.postedByUserId, e.postedBy || e.postedByUserId);
    }
  }
  for (const e of Object.values(db.archived || {})) {
    if (!e.postedByUserId) continue;
    if (!byUser.has(e.postedByUserId)) {
      byUser.set(e.postedByUserId, e.postedBy || e.postedByUserId);
    }
  }
  for (const [userId, name] of byUser) {
    const stats = computeStatsForUser(db, userId, name, now);
    if (stats) callers[userId] = stats;
  }
  return callers;
}

export function updateCallerStatsForUser(db, userId, displayName) {
  if (!userId) return;
  const stats = computeStatsForUser(db, userId, displayName);
  if (!stats) return;
  ensureCallersDb(db)[userId] = stats;
}

export function callerStatLine(db, userId) {
  const c = db.callers?.[userId];
  if (!c || c.totalCalls < 3) return '';
  const resolved = Math.max(1, c.totalCalls);
  const hitPct = Math.round((c.hits2x / resolved) * 100);
  return hitPct + '% hit rate · ' + c.avgPeak + 'x avg peak · ' + c.totalCalls + ' calls';
}

export function getCallerStats(db, userId) {
  return db.callers?.[userId] || null;
}

export function callsInPeriod(db, userId, sinceMs) {
  return allCallsForUser(db, userId).filter((e) => (e.postedAt || 0) >= sinceMs);
}

export function computeInlineCallerStats(db, userId, displayName) {
  const stats = computeStatsForUser(db, userId, displayName);
  if (stats) ensureCallersDb(db)[userId] = stats;
  return stats;
}

export function formatDurationMins(mins) {
  if (mins == null || !Number.isFinite(mins)) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
