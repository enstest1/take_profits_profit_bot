/**
 * nfttp/store.js — tracked NFT collections in db.nftTp.
 *
 * Patch-reload-write (same as xradar) so a concurrent token poll merge cannot
 * drop an OG floor lock.
 *
 * db.nftTp.collections[slug] = {
 *   slug, name, ticker, chain, address,
 *   postedBy, postedByUserId, postedAt, alertChannelId,
 *   floorAtCall, mcapAtCall, ownersAtCall, floorSymbol,
 *   lastFloor, lastMcap, lastOwners, lastChecked,
 *   peakMultiple, peakAt, milestonesFired, gainAlertFired, takeProfitFired,
 *   lowMultStreak, lastMilestoneResetAt, imageUrl, openseaUrl, createdAt
 * }
 */

import { loadDB, ensureDBSchema, patchNftTp } from '../dbStore.js';

function read() {
  const db = ensureDBSchema(loadDB());
  if (!db.nftTp) db.nftTp = { collections: {} };
  if (!db.nftTp.collections) db.nftTp.collections = {};
  return db;
}

export function listCollections() {
  return { ...read().nftTp.collections };
}

export function getCollection(slug) {
  if (!slug) return null;
  return read().nftTp.collections[String(slug).toLowerCase()] || null;
}

/**
 * First write wins — OG caller / floor never reset on a repost.
 * @returns {{ added: boolean, entry: object }}
 */
export function trackCollection(slug, fields) {
  const key = String(slug).toLowerCase();
  return patchNftTp((nft) => {
    const existing = nft.collections[key];
    if (existing) return { added: false, entry: existing };
    const entry = { slug: key, ...fields };
    nft.collections[key] = entry;
    return { added: true, entry };
  });
}

export function patchCollection(slug, patch) {
  const key = String(slug).toLowerCase();
  return patchNftTp((nft) => {
    const existing = nft.collections[key];
    if (!existing) return null;
    Object.assign(existing, patch);
    return existing;
  });
}

export function removeCollection(slug) {
  const key = String(slug).toLowerCase().replace(/^@/, '');
  return patchNftTp((nft) => {
    if (!nft.collections[key]) {
      const hit = Object.keys(nft.collections).find(
        (s) => s === key || nft.collections[s]?.ticker?.toLowerCase() === key,
      );
      if (!hit) return false;
      delete nft.collections[hit];
      return true;
    }
    delete nft.collections[key];
    return true;
  });
}
