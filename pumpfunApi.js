import { rateLimiter } from './rateLimiter.js';

/** v1 host no longer resolves (Cloudflare 1016). v3 is what scanners read for FDV. */
const PUMP_COIN_URLS = [
  (address) => 'https://frontend-api-v3.pump.fun/coins-v2/' + address,
  (address) => 'https://frontend-api.pump.fun/coins/' + address,
];

/**
 * @param {object} d
 * @returns {object|null}
 */
function normalizePumpCoin(d) {
  if (!d || !d.mint) return null;
  if (d.usd_market_cap == null && Number(d.market_cap_usd) > 0) d.usd_market_cap = d.market_cap_usd;
  if (d.bonding_curve_progress == null) d.bonding_curve_progress = d.complete ? 100 : 0;
  return d;
}

export async function fetchPumpFun(address) {
  let lastErr = null;
  for (const urlFor of PUMP_COIN_URLS) {
    try {
      const res = await rateLimiter.fetch(urlFor(address), {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status);
        continue;
      }
      const coin = normalizePumpCoin(await res.json());
      if (coin) return coin;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error('[pumpfun] failed for ' + address + ':', lastErr?.message || 'no coin');
  return null;
}

/**
 * Replace a frozen Dex curve print with pump.fun's live USD cap.
 * Dex keeps the pre-migration pair (Tweetcraft showed 49.8k while the scan was ~195k).
 * Drops pairAddress so that dead pool is not pinned.
 * @param {object} token
 * @param {object} pump
 * @returns {boolean}
 */
export function applyLivePumpCap(token, pump) {
  const mc = Number(pump?.usd_market_cap);
  if (!token || !(mc > 0)) return false;
  const decimals = Number(pump.base_decimals);
  const dec = Number.isFinite(decimals) && decimals > 0 ? decimals : 6;
  const rawSupply = Number(pump.total_supply);
  const supply = rawSupply > 0 ? rawSupply / 10 ** dec : 1e9;
  const price = mc / supply;
  if (!(price > 0)) return false;
  token.price = String(price);
  token.marketCap = mc;
  token.fdv = mc;
  token.priceSource = 'pump-curve';
  token.pairAddress = null;
  return true;
}

export async function fetchSolPrice() {
  try {
    const res = await rateLimiter.fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(8000) },
    );
    const data = await res.json();
    return (data && data.solana && data.solana.usd) || null;
  } catch {
    return null;
  }
}

export function calcPumpFunPrice(pumpData, solPrice) {
  try {
    const solRes = Number(pumpData.virtual_sol_reserves);
    const tokRes = Number(pumpData.virtual_token_reserves);
    if (!tokRes) return null;
    return (solRes / 1e9) / (tokRes / 1e6) * solPrice;
  } catch {
    return null;
  }
}
