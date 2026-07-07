/** In-memory poll / alert stats exposed on GET /warden/status. */
import { resolveGitSha } from './deploySha.js';

export const cycleStats = {
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
