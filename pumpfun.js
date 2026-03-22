"use strict";

/**
 * pump.fun pre-graduation API wrapper
 */

/**
 * Fetch token data from pump.fun.
 * @param {string} mintAddress - Solana mint address
 * @returns {object|null}
 */
async function fetchPumpFunToken(mintAddress) {
  try {
    const res = await fetch(
      `https://frontend-api.pump.fun/coins/${mintAddress}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.mint) return null;
    return data;
    // Shape: { name, symbol, price, marketCap, usd_market_cap, bonding_curve_progress,
    //          complete (bool = graduated), virtual_sol_reserves, virtual_token_reserves,
    //          created_timestamp, creator, total_supply, image_uri }
  } catch (err) {
    console.error(`[PumpFun] fetchPumpFunToken(${mintAddress}) error:`, err.message);
    return null;
  }
}

/**
 * Fetch current SOL price in USD from CoinGecko.
 * Cache this for one poll cycle — call once, reuse for all pump.fun tokens.
 * @returns {number|null}
 */
async function fetchSolPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json?.solana?.usd ?? null;
  } catch (err) {
    console.error("[PumpFun] fetchSolPrice error:", err.message);
    return null;
  }
}

/**
 * Calculate token price in USD from pump.fun virtual reserves.
 *
 * virtual_sol_reserves  → lamports (divide by 1e9)
 * virtual_token_reserves → raw units (divide by 1e6)
 *
 * price = (sol_reserves / token_reserves) * solPriceUsd
 *
 * @param {object} pumpData - raw pump.fun API response
 * @param {number} solPriceUsd
 * @returns {number|null}
 */
function calculatePumpFunPrice(pumpData, solPriceUsd) {
  try {
    const sol = Number(pumpData?.virtual_sol_reserves);
    const tok = Number(pumpData?.virtual_token_reserves);
    if (!sol || !tok || !solPriceUsd) return null;
    return (sol / 1e9) / (tok / 1e6) * solPriceUsd;
  } catch {
    return null;
  }
}

module.exports = { fetchPumpFunToken, fetchSolPrice, calculatePumpFunPrice };
