/** In-memory poll / alert stats exposed on GET /warden/status. */
import { resolveGitSha } from './deploySha.js';

/** Same multiplier Warden C9 uses — lastCycleAt older than 3× interval is dead. */
export const POLL_STALE_MULT = 3;
/** First minutes after boot: /health stays 200 so Railway does not kill a still-starting deploy. */
export const BOOT_GRACE_MS = Number(process.env.POLL_BOOT_GRACE_MS) || 8 * 60 * 1000;

export const cycleStats = {
  bootAt: Date.now(),
  lastCycleStartedAt: 0,
  lastCycleAt: 0,
  lastCycleMs: 0,
  scheduledSol: 0,
  scheduledRh: 0,
  broken: 0,
  rate429Streak: 0,
  alertsSentToday: 0,
  gitSha: resolveGitSha(),
  lastSummaryAt: 0,
  pollIntervalMs: Number(process.env.TOKEN_POLL_INTERVAL_MS) || 3 * 60 * 1000,
};

/** Call at the top of each poll loop iteration so a hang is distinguishable from "never started". */
export function markCycleStarted(now = Date.now()) {
  cycleStats.lastCycleStartedAt = now;
}

/**
 * Process-local poll liveness. Shared by /health and the self-restart watchdog.
 * @param {number} [now]
 * @returns {{ ok: boolean, reason: string, lastCycleAt: number, ageMs?: number }}
 */
export function pollHealth(now = Date.now()) {
  const interval = cycleStats.pollIntervalMs || 180_000;
  const staleAfter = interval * POLL_STALE_MULT;
  if (!cycleStats.lastCycleAt) {
    if (now - cycleStats.bootAt < BOOT_GRACE_MS) {
      return { ok: true, reason: 'booting', lastCycleAt: 0 };
    }
    return { ok: false, reason: 'no-cycle', lastCycleAt: 0 };
  }
  const ageMs = now - cycleStats.lastCycleAt;
  if (ageMs > staleAfter) {
    return { ok: false, reason: 'stale', lastCycleAt: cycleStats.lastCycleAt, ageMs };
  }
  return { ok: true, reason: 'ok', lastCycleAt: cycleStats.lastCycleAt, ageMs };
}

/** Test helper — do not call from runtime paths. */
export function resetCycleStatsForTests(overrides = {}) {
  cycleStats.bootAt = Date.now();
  cycleStats.lastCycleStartedAt = 0;
  cycleStats.lastCycleAt = 0;
  cycleStats.lastCycleMs = 0;
  cycleStats.scheduledSol = 0;
  cycleStats.scheduledRh = 0;
  cycleStats.broken = 0;
  cycleStats.rate429Streak = 0;
  cycleStats.alertsSentToday = 0;
  cycleStats.lastSummaryAt = 0;
  cycleStats.pollIntervalMs = Number(process.env.TOKEN_POLL_INTERVAL_MS) || 3 * 60 * 1000;
  Object.assign(cycleStats, overrides);
}

export function refreshGitSha() {
  cycleStats.gitSha = resolveGitSha();
}

let alertDay = null;

export function bumpAlertSent() {
  const today = new Date().toISOString().slice(0, 10);
  if (alertDay !== today) {
    alertDay = today;
    cycleStats.alertsSentToday = 0;
  }
  cycleStats.alertsSentToday += 1;
}

export function recordCycle({ ms, scheduledSol, scheduledRh, broken, rate429Streak }) {
  cycleStats.lastCycleAt = Date.now();
  cycleStats.lastCycleMs = ms;
  cycleStats.scheduledSol = scheduledSol;
  cycleStats.scheduledRh = scheduledRh;
  cycleStats.broken = broken;
  cycleStats.rate429Streak = rate429Streak;
}

export function markSummaryPosted() {
  cycleStats.lastSummaryAt = Date.now();
}
