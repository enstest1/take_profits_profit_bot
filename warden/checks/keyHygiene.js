import { CHAINS, parseStorageKey, isBrokenSolKey } from '../../chains.js';
import { allEntries } from '../lib/entries.js';

export function checkKeyHygiene(snap, raise, { legacyFrozen, statusBroken, prevBroken, prevSnap }) {
  if (!snap) return;
  const keysByLower = new Map();

  for (const [key, entry] of allEntries(snap)) {
    const { chainId, address } = parseStorageKey(key);

    if (chainId === 'solana') {
      if (key !== (entry?.address || key)) {
        raise('C3', 'CRITICAL', key, 'Solana key !== entry.address', { key, address: entry?.address });
      }
      if (isBrokenSolKey(key, entry)) {
        raise('REG-2', 'CRITICAL', key, 'Lowercase Solana mint regression', { key });
      }
      const lower = key.toLowerCase();
      const dup = keysByLower.get('sol:' + lower);
      if (dup && dup !== key) {
        raise('C3', 'CRITICAL', key, 'Duplicate Solana key (case-insensitive)', { other: dup });
      }
      keysByLower.set('sol:' + lower, key);
      continue;
    }

    if (chainId === 'legacy-evm') {
      if (legacyFrozen && !legacyFrozen.includes(key)) {
        raise('REG-4', 'CRITICAL', key, 'New bare 0x key outside frozen legacy set', { key });
      }
      if (legacyFrozen?.includes(key)) {
        const prevEntry = prevSnap?.tokens?.[key] ?? prevSnap?.archived?.[key];
        const prevLc = prevEntry?.lastChecked;
        const currLc = entry?.lastChecked;
        if (prevLc != null && currLc != null && Number(currLc) > Number(prevLc)) {
          raise('REG-5', 'CRITICAL', key, 'Legacy EVM row lastChecked advanced (resurrected polling)', {
            before: prevLc,
            after: currLc,
          });
        }
      }
      continue;
    }

    if (chainId === 'robinhood') {
      const suffix = key.slice('robinhood:'.length);
      if (suffix !== suffix.toLowerCase()) {
        raise('C3', 'CRITICAL', key, 'Robinhood key suffix must be lowercase hex', { key });
      }
      if ((entry?.address || '') !== suffix) {
        raise('C3', 'CRITICAL', key, 'Robinhood entry.address mismatch', { key, address: entry?.address });
      }
      if (entry?.chain && entry.chain !== 'robinhood') {
        raise('C3', 'CRITICAL', key, 'Robinhood entry.chain must be robinhood', { chain: entry.chain });
      }
      if (entry?.bondingProgress != null || entry?.graduationAlertFired) {
        raise('C5', 'WARN', key, 'Robinhood entry has bonding/graduation fields', {
          bondingProgress: entry.bondingProgress,
          graduationAlertFired: entry.graduationAlertFired,
        });
      }
      continue;
    }

    if (!CHAINS[chainId]) {
      raise('C3', 'WARN', key, 'Unknown chain prefix `' + chainId + '`', { key });
    }
  }

  if (statusBroken != null && prevBroken != null && statusBroken > prevBroken) {
    raise('REG-2', 'CRITICAL', 'global', 'Broken Solana key count increased (' + prevBroken + ' → ' + statusBroken + ')', {
      before: prevBroken,
      after: statusBroken,
    });
  }
}
