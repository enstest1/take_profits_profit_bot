import { parseStorageKey } from '../../chains.js';
import { BOUNDS } from '../config.js';
import { allEntries } from '../lib/entries.js';

export function checkSchemaBounds(snap, raise) {
  if (!snap) return;
  const now = Date.now();

  for (const [key, entry] of allEntries(snap)) {
    if (!entry || typeof entry !== 'object') {
      raise('C5', 'CRITICAL', key, 'Entry is not an object');
      continue;
    }

    if (!entry.alertChannelId) {
      raise('C5', 'WARN', key, 'Missing alertChannelId');
    }
    if (entry.postedAt && Number(entry.postedAt) > now + 60_000) {
      raise('C5', 'WARN', key, 'postedAt in the future', { postedAt: entry.postedAt });
    }

    const { chainId } = parseStorageKey(key);
    const inTokens = !!snap.tokens?.[key];
    if (inTokens && chainId !== 'legacy-evm' && !entry.canary) {
      if (!entry.lastChecked) {
        raise('C5', 'WARN', key, 'Active token missing lastChecked');
      }
    }

    if (Array.isArray(entry.velocityWindow) && entry.velocityWindow.length > BOUNDS.velocityWindow) {
      raise('C5b', 'WARN', key, 'velocityWindow exceeds cap (' + entry.velocityWindow.length + ')', {
        cap: BOUNDS.velocityWindow,
      });
    }
    if (Array.isArray(entry.callChannels) && entry.callChannels.length > BOUNDS.callChannels) {
      raise('C5b', 'WARN', key, 'callChannels exceeds cap', { len: entry.callChannels.length });
    }
    if (Array.isArray(entry.tags) && entry.tags.length > BOUNDS.tags) {
      raise('C5b', 'WARN', key, 'tags exceeds cap', { len: entry.tags.length });
    }
    if (entry.positions && typeof entry.positions === 'object') {
      const n = Object.keys(entry.positions).length;
      if (n > BOUNDS.positionsPerToken) {
        raise('C5b', 'WARN', key, 'positions map exceeds cap', { count: n });
      }
    }
    if (Array.isArray(entry.milestonesFired) && entry.milestonesFired.length > BOUNDS.milestonesFired) {
      raise('C5b', 'WARN', key, 'milestonesFired exceeds cap', { len: entry.milestonesFired.length });
    }

    if (chainId === 'robinhood') {
      if (entry.rugScan) raise('C5', 'WARN', key, 'Robinhood entry has rugScan (Solana-only)');
      if (entry.devWallet) raise('C5', 'WARN', key, 'Robinhood entry has devWallet');
    }
  }
}
