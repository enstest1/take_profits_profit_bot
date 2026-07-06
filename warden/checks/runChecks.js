import { checkOgImmutability } from './ogImmutability.js';
import { checkMassDeletion } from './massDeletion.js';
import { checkKeyHygiene } from './keyHygiene.js';
import { checkMilestones } from './milestones.js';
import { checkSchemaBounds } from './schemaBounds.js';
import { checkPriceTruth } from './priceTruth.js';
import { checkCanaries } from './canary.js';

export function runSnapshotChecks(prevSnap, currSnap, raise, ctx) {
  checkOgImmutability(prevSnap, currSnap, raise);
  checkMassDeletion(prevSnap, currSnap, raise);
  checkKeyHygiene(currSnap, raise, ctx);
  checkMilestones(prevSnap, currSnap, raise);
  checkSchemaBounds(currSnap, raise);
}

export async function runLayer2Checks(currSnap, status, raise, ctx) {
  await checkPriceTruth(currSnap, status, raise, ctx);
  checkCanaries(currSnap, status, raise);
}

/** Live /audit — no shadow copy; schema + key hygiene only. */
export function runLiveAudit(snap, raise, ctx) {
  checkKeyHygiene(snap, raise, { ...ctx, prevSnap: null });
  checkSchemaBounds(snap, raise);
}

export { checkOgImmutability, checkMassDeletion, checkKeyHygiene, checkMilestones, checkSchemaBounds };
