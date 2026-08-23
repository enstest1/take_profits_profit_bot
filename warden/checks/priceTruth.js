import { batchFetch } from '../../dexBatch.js';
import { CHAINS, parseStorageKey } from '../../chains.js';

const PERSISTENCE = new Map();

function magnitude(n) {
  if (!n || !Number.isFinite(n) || n <= 0) return null;
  return Math.floor(Math.log10(n));
}

function pickSample(snap, chainId, n = 30) {
  const keys = Object.keys(snap?.tokens || {}).filter((k) => {
    const p = parseStorageKey(k);
    if (p.chainId !== chainId) return false;
    const e = snap.tokens[k];
    if (e?.canary) return false;
    const px = Number(e?.priceAtCall);
    return px > 0 && e?.lastPrice;
  });
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys.slice(0, n);
}

export async function checkPriceTruth(snap, status, raise, { pollIntervalMs }) {
  if (!snap) return;
  const chains = ['solana', ...Object.keys(CHAINS).filter((id) => CHAINS[id]?.kind === 'evm')];
  const freshMs = (pollIntervalMs || 180_000) * 2;

  for (const chainId of chains) {
    const keys = pickSample(snap, chainId, 30);
    if (!keys.length) continue;
    const addrs = keys.map((k) => parseStorageKey(k).address);
    const liveMap = await batchFetch(chainId, addrs);

    for (const key of keys) {
      const entry = snap.tokens[key];
      const { address } = parseStorageKey(key);
      const lookup = chainId === 'solana' ? address : address.toLowerCase();
      const live = liveMap.get(lookup);
      if (!live?.price) continue;

      const botPx = Number(entry.lastPrice);
      const apiPx = Number(live.price);
      if (!botPx || !apiPx) continue;

      const lc = Number(entry.lastChecked) || 0;
      if (Date.now() - lc > freshMs) {
        PERSISTENCE.delete(key);
        continue;
      }

      const magDiff = Math.abs((magnitude(botPx) || 0) - (magnitude(apiPx) || 0));
      const ratio = botPx / apiPx;
      const disagree = magDiff >= 1 || ratio > 10 || ratio < 0.1;

      if (!disagree) {
        PERSISTENCE.delete(key);
        continue;
      }

      const streak = (PERSISTENCE.get(key) || 0) + 1;
      PERSISTENCE.set(key, streak);
      if (streak >= 2) {
        raise('C6', 'CRITICAL', key, 'Price truth: poller price disagrees with DexScreener on fresh data (2 passes)', {
          botPrice: botPx,
          apiPrice: apiPx,
          passes: streak,
        });
        PERSISTENCE.delete(key);
      }
    }
  }
}
