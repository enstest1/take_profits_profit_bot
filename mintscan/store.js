/**
 * mintscan/store.js — scanner state in dbStore (survives redeploys via the
 * Railway volume, same as every other feature in this bot).
 *
 * db.mintScanner = {
 *   lastScannedBlock: number,
 *   cards: { "<contract>": { messageIds, tier, lastUpdated } },
 *   nearMisses: { "<contract>": { tier, mintPct, mints, unique, at, ... } },
 * }
 *
 * `cards` lets a rising collection EDIT its existing card (WARM → HOT →
 * MOONING) instead of posting three times.
 */

import { loadDB, saveDB, ensureDBSchema } from '../dbStore.js';

const NEAR_MISS_MAX = 200;
const TIER_RANK = { WARM: 1, HOT: 2, MOONING: 3 };

function read() {
  const db = ensureDBSchema(loadDB());
  if (!db.mintScanner) db.mintScanner = { lastScannedBlock: 0, cards: {}, nearMisses: {} };
  if (!db.mintScanner.cards) db.mintScanner.cards = {};
  if (!db.mintScanner.nearMisses) db.mintScanner.nearMisses = {};
  return db;
}

function update(mutator) {
  const db = read();
  const out = mutator(db.mintScanner, db);
  saveDB(db);
  return out;
}

export function getLastScannedBlock() {
  return read().mintScanner.lastScannedBlock || 0;
}

export function setLastScannedBlock(n) {
  update((ms) => {
    ms.lastScannedBlock = n;
  });
}

export function getCard(contract) {
  return read().mintScanner.cards[String(contract).toLowerCase()] || null;
}

export function setCard(contract, card) {
  update((ms) => {
    ms.cards[String(contract).toLowerCase()] = card;
  });
}

/** Drop cards older than `maxAgeMs` so state can't grow forever. */
export function pruneCards(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  update((ms) => {
    for (const [contract, card] of Object.entries(ms.cards)) {
      if ((card.lastUpdated || 0) < cutoff) delete ms.cards[contract];
    }
  });
}

/**
 * Persist a sub-threshold tier hit for later review. Updates in place when the
 * same contract re-qualifies on velocity with a higher tier or mint %.
 */
export function recordNearMiss(entry) {
  update((ms) => {
    const key = String(entry.contract).toLowerCase();
    const prev = ms.nearMisses[key];
    const nextTierRank = TIER_RANK[entry.tier] || 0;
    const prevTierRank = TIER_RANK[prev?.tier] || 0;
    const prevPct = prev?.mintPct ?? -1;
    const nextPct = entry.mintPct ?? -1;

    // Keep the strongest signal we've seen for this contract.
    if (prev && nextTierRank < prevTierRank) return;
    if (prev && nextTierRank === prevTierRank && nextPct <= prevPct) return;

    ms.nearMisses[key] = { ...entry, contract: key, at: Date.now() };

    const entries = Object.entries(ms.nearMisses);
    if (entries.length <= NEAR_MISS_MAX) return;

    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    ms.nearMisses = Object.fromEntries(entries.slice(0, NEAR_MISS_MAX));
  });
}
