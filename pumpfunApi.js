import { rateLimiter } from './rateLimiter.js';

export async function fetchPumpFun(address) {
  try {
    const res = await rateLimiter.fetch('https://frontend-api.pump.fun/coins/' + address, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.mint) return null;
    return d;
  } catch (e) {
    console.error('[pumpfun] failed for ' + address + ':', e.message);
    return null;
  }
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
