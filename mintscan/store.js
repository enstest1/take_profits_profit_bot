/**
 * mintscan/store.js — scanner state in dbStore (survives redeploys via the
 * Railway volume, same as every other feature in this bot).
 *
 * db.mintScanner = {
 *   lastScannedBlock: number,
 *   cards: { "<contract>": { messageId, channelId, tier, lastUpdated } },
 * }
 *
 * `cards` lets a rising collection EDIT its existing card (WARM → HOT →
 * MOONING) instead of posting three times.
 */

import { loadDB, saveDB, ensureDBSchema } from '../dbStore.js';

function read() {
  const db = ensureDBSchema(loadDB());
  if (!db.mintScanner) db.mintScanner = { lastScannedBlock: 0, cards: {} };
  if (!db.mintScanner.cards) db.mintScanner.cards = {};
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
