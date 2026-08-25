/**
 * nfttp/evaluate.js — same take-profit ladder as tokens, against floor.
 *
 *   +75%  fires in [1.75×, 2×)
 *   tier N fires at (N+1)× call floor  (tier 1 = 2× → card says "1x")
 *
 * Pure function so tests don't need Discord or OpenSea.
 */

import { MAX_MILESTONE_TIER, normalizeTakeProfitTiers } from '../milestones.js';

export const GAIN75_MIN = 1.75;
export const GAIN75_MAX = 2.0;
export const RESET_MULT = 0.99;
export const RESET_STREAK = 3;
export const RESET_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Multiple vs OG floor. Uses max(floor×, mcap×) so supply-complete collections
 * still count when OpenSea's floor tick lags listed count.
 */
export function nftMultiple(entry, live) {
  const callFloor = Number(entry?.floorAtCall);
  const liveFloor = Number(live?.floor);
  if (!Number.isFinite(callFloor) || callFloor <= 0 || !Number.isFinite(liveFloor) || liveFloor <= 0) {
    return null;
  }
  const multFloor = liveFloor / callFloor;
  const callMcap = Number(entry?.mcapAtCall);
  const liveMcap = Number(live?.mcap);
  if (Number.isFinite(callMcap) && callMcap > 0 && Number.isFinite(liveMcap) && liveMcap > 0) {
    return Math.max(multFloor, liveMcap / callMcap);
  }
  return multFloor;
}

/**
 * @param {object} entry stored collection
 * @param {object} live { floor, mcap }
 * @param {{ now?: number, maxTier?: number, lastCheckedAgeMs?: number }} opts
 * @returns {{ patch: object, alerts: Array<{ kind: string, tier: number|null, label: string }> }}
 */
export function evaluateNftMilestones(entry, live, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxTier = Math.min(opts.maxTier ?? 20, MAX_MILESTONE_TIER);
  const patch = {};
  const alerts = [];

  const liveFloor = Number(live?.floor);
  let callFloor = Number(entry?.floorAtCall);

  if (Number.isFinite(liveFloor) && liveFloor > 0 && (!Number.isFinite(callFloor) || callFloor <= 0)) {
    patch.floorAtCall = liveFloor;
    patch.floorAtCallBackfilled = true;
    patch.lastFloor = liveFloor;
    patch.lastChecked = now;
    return { patch, alerts };
  }

  const currentMultiple = nftMultiple({ ...entry, ...patch }, live);
  if (currentMultiple == null) {
    patch.lastChecked = now;
    return { patch, alerts };
  }

  let milestonesFired = normalizeTakeProfitTiers(entry.milestonesFired || []);
  let gainAlertFired = Boolean(entry.gainAlertFired);
  let takeProfitFired = Boolean(entry.takeProfitFired);
  let lowStreak = Number(entry.lowMultStreak) || 0;

  if (currentMultiple < RESET_MULT) {
    lowStreak += 1;
    patch.lowMultStreak = lowStreak;
    const lastResetAt = Number(entry.lastMilestoneResetAt) || 0;
    const cooldownOk = now - lastResetAt >= RESET_COOLDOWN_MS;
    if (
      cooldownOk &&
      lowStreak >= RESET_STREAK &&
      (milestonesFired.length > 0 || takeProfitFired || gainAlertFired)
    ) {
      milestonesFired = [];
      gainAlertFired = false;
      takeProfitFired = false;
      patch.milestonesFired = [];
      patch.gainAlertFired = false;
      patch.takeProfitFired = false;
      patch.lowMultStreak = 0;
      patch.peakMultiple = currentMultiple;
      patch.peakAt = now;
      patch.lastMilestoneResetAt = now;
    }
  } else {
    patch.lowMultStreak = 0;
  }

  if (currentMultiple >= GAIN75_MIN && currentMultiple < GAIN75_MAX && !gainAlertFired) {
    alerts.push({ kind: 'gain75', tier: null, label: '+75%' });
    gainAlertFired = true;
    patch.gainAlertFired = true;
  }

  const newlyPassed = [];
  for (let tier = 1; tier <= maxTier; tier++) {
    if (!milestonesFired.includes(tier) && currentMultiple >= tier + 1) {
      newlyPassed.push(tier);
    }
  }

  if (newlyPassed.length > 0) {
    const silentTiers = newlyPassed.slice(0, -1);
    const alertTier = newlyPassed[newlyPassed.length - 1];
    const staleCatchUp = (opts.lastCheckedAgeMs || 0) > 10 * 60 * 1000;

    if (silentTiers.length >= 2 && milestonesFired.length === 0 && currentMultiple >= 4 && staleCatchUp) {
      milestonesFired = [...new Set([...milestonesFired, ...newlyPassed])].sort((a, b) => a - b);
      patch.milestonesFired = milestonesFired;
      patch.gainAlertFired = true;
      patch.takeProfitFired = true;
    } else {
      if (silentTiers.length > 0) {
        milestonesFired = [...new Set([...milestonesFired, ...silentTiers])].sort((a, b) => a - b);
      }
      alerts.push({ kind: 'tier' + alertTier, tier: alertTier, label: alertTier + 'x' });
      milestonesFired = [...new Set([...milestonesFired, alertTier])].sort((a, b) => a - b);
      patch.milestonesFired = milestonesFired;
      patch.gainAlertFired = true;
      patch.takeProfitFired = true;
    }
  }

  const storedPeak = Number(entry.peakMultiple) || 1;
  const newPeak = Math.max(storedPeak, currentMultiple);
  patch.lastFloor = liveFloor;
  patch.lastChecked = now;
  patch.peakMultiple = newPeak;
  if (newPeak > storedPeak) patch.peakAt = now;
  if (live?.numOwners != null) patch.lastOwners = live.numOwners;
  if (live?.mcap != null) patch.lastMcap = live.mcap;

  return { patch, alerts };
}
