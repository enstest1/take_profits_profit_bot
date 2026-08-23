import { CHAINS, parseStorageKey } from '../../chains.js';
import { allEntries } from '../lib/entries.js';

const lastCanaryChecked = new Map();

export function checkCanaries(snap, status, raise) {
  if (!snap || !status) return;
  const pollInterval = status.pollIntervalMs || 180_000;
  const staleMs = pollInterval * 2;

  for (const [key, entry] of allEntries(snap)) {
    if (!entry?.canary && !(entry?.tags || []).includes('canary')) continue;
    const { chainId } = parseStorageKey(key);
    if (chainId !== 'solana' && CHAINS[chainId]?.kind !== 'evm') continue;

    const lc = Number(entry.lastChecked) || 0;
    const prev = lastCanaryChecked.get(key) || 0;

    if (status.lastCycleAt && Date.now() - status.lastCycleAt < staleMs) {
      if (lc > 0 && lc <= prev && prev > 0) {
        raise('C7', 'CRITICAL', key, 'Canary stale while bot status healthy — pipeline wedged', {
          lastChecked: lc,
          previous: prev,
          chainId,
        });
      }
    }
    if (lc > prev) lastCanaryChecked.set(key, lc);
  }
}

export function findCanaries(snap) {
  const out = [];
  for (const [key, entry] of allEntries(snap)) {
    if (entry?.canary || (entry?.tags || []).includes('canary')) out.push(key);
  }
  return out;
}
