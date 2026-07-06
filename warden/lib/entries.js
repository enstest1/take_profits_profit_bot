/** Shared snapshot entry helpers — used by all Warden checks. */

export function* allEntries(snap) {
  if (!snap) return;
  for (const [key, entry] of Object.entries(snap.tokens || {})) {
    yield [key, entry, 'tokens'];
  }
  for (const [key, entry] of Object.entries(snap.archived || {})) {
    yield [key, entry, 'archived'];
  }
}

export function findEntry(snap, key) {
  return snap?.tokens?.[key] ?? snap?.archived?.[key] ?? null;
}

export function countActive(snap) {
  return Object.keys(snap?.tokens || {}).length;
}

export function countArchived(snap) {
  return Object.keys(snap?.archived || {}).length;
}

/** Mint-case repair: entry moved from all-lowercase Solana key to mixed-case twin. */
export function findRepairedTwin(snap, oldKey, prev) {
  if (!prev || !snap) return null;
  const { chainId, address } = parseStorageKeyLocal(oldKey);
  if (chainId !== 'solana') return null;
  if (address !== address.toLowerCase()) return null;
  if (address === oldKey) return null;
  for (const [key, entry] of allEntries(snap)) {
    const p = parseStorageKeyLocal(key);
    if (p.chainId !== 'solana') continue;
    if (p.address.toLowerCase() !== address.toLowerCase()) continue;
    if (key === oldKey) continue;
    if (ogFieldsMatch(prev, entry)) return entry;
  }
  return null;
}

export function ogFieldsMatch(a, b) {
  const fields = ['postedBy', 'postedByUserId', 'postedAt', 'priceAtCall', 'calledInGuild'];
  return fields.every((f) => String(a?.[f]) === String(b?.[f]));
}

export function isRepairTwinMove(prevSnap, currSnap, key) {
  if (findEntry(currSnap, key)) return false;
  const prev = findEntry(prevSnap, key);
  if (!prev) return false;
  return !!findRepairedTwin(currSnap, key, prev);
}

function parseStorageKeyLocal(key) {
  const i = key.indexOf(':');
  if (i > 0) return { chainId: key.slice(0, i), address: key.slice(i + 1) };
  if (/^0x/i.test(key)) return { chainId: 'legacy-evm', address: key };
  return { chainId: 'solana', address: key };
}

export function repairTwinKeys(prevSnap, currSnap) {
  const moved = new Set();
  for (const [key, prev] of allEntries(prevSnap)) {
    if (!findEntry(currSnap, key) && findRepairedTwin(currSnap, key, prev)) {
      moved.add(key);
    }
  }
  return moved;
}
