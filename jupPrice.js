/**
 * Jupiter USD prices — DexScreener leaves meteoradbc (Meteora DBC) rows
 * with priceNative only and priceUsd/mcap null. Without this, auto-track
 * cards show "—" and the 1x ladder never starts.
 */

const JUP_PRICE_URL = 'https://lite-api.jup.ag/price/v3';
const CACHE_TTL_MS = 20_000;

/** @type {Map<string, { usd: number, exp: number }>} */
const cache = new Map();

function cacheGet(mint) {
  const hit = cache.get(mint);
  if (!hit || hit.exp < Date.now()) return null;
  return hit.usd;
}

function cacheSet(mint, usd) {
  cache.set(mint, { usd, exp: Date.now() + CACHE_TTL_MS });
}

/**
 * @param {string} mint
 * @returns {Promise<number|null>}
 */
export async function fetchJupiterUsd(mint) {
  const addr = String(mint || '');
  if (!addr) return null;
  const cached = cacheGet(addr);
  if (cached != null) return cached;
  try {
    const res = await fetch(JUP_PRICE_URL + '?ids=' + encodeURIComponent(addr), {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.warn('[jup] HTTP ' + res.status + ' for ' + addr.slice(0, 8) + '…');
      return null;
    }
    const data = await res.json();
    const row = data?.[addr] || data?.[Object.keys(data || {})[0]];
    const usd = Number(row?.usdPrice);
    if (!(usd > 0)) return null;
    cacheSet(addr, usd);
    return usd;
  } catch (e) {
    console.warn('[jup] ' + addr.slice(0, 8) + '…: ' + (e.message || e));
    return null;
  }
}

/**
 * Fill token.price from Jupiter when Dex gave us a name but no USD.
 * @param {object} token
 * @returns {Promise<object>}
 */
export async function enrichTokenUsdFromJupiter(token) {
  if (!token) return token;
  const existing = Number(token.price);
  if (existing > 0) return token;
  const usd = await fetchJupiterUsd(token.address);
  if (!(usd > 0)) return token;
  token.price = String(usd);
  token.priceSource = 'jupiter';
  console.log(
    '[jup] ' + (token.symbol || token.address?.slice(0, 8)) + ' usd=' + usd +
      ' (Dex had no priceUsd — typical meteoradbc)',
  );
  return token;
}
