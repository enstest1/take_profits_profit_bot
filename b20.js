// b20.js — read-only native-B20 detection for Base tokens.
// Safe to call on any address; returns { isB20:false } for non-B20 / errors.
import { createPublicClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';

const B20_FACTORY = '0xB20f000000000000000000000000000000000000';

// Minimal ABIs — copied from base-std interface definitions.
const FACTORY_ABI = [
  {
    type: 'function',
    name: 'isB20',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
];

const STABLECOIN_ABI = [
  {
    type: 'function',
    name: 'currency',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
];

let _client = null;
function client() {
  if (_client) return _client;
  _client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
  });
  return _client;
}

/** Variant is encoded in address byte [10] (zero-indexed). 0x00=ASSET, 0x01=STABLECOIN. */
function variantFromAddress(addr) {
  const hex = String(addr).toLowerCase().replace(/^0x/, '');
  const b = hex.slice(20, 22); // byte index 10
  if (b === '01') return 'STABLECOIN';
  if (b === '00') return 'ASSET';
  return 'UNKNOWN';
}

/**
 * Detect whether an EVM address is a native B20 token on Base.
 * @returns {Promise<{isB20:boolean, variant?:string, currency?:string}>}
 */
export async function detectB20(address) {
  let token;
  try {
    token = getAddress(address); // checksums / validates; throws on bad input
  } catch {
    return { isB20: false };
  }

  let is;
  try {
    is = await client().readContract({
      address: B20_FACTORY,
      abi: FACTORY_ABI,
      functionName: 'isB20',
      args: [token],
    });
  } catch {
    return { isB20: false }; // RPC error / not activated → treat as non-B20
  }
  if (!is) return { isB20: false };

  const variant = variantFromAddress(token);

  if (variant === 'STABLECOIN') {
    try {
      const currency = await client().readContract({
        address: token,
        abi: STABLECOIN_ABI,
        functionName: 'currency',
      });
      return { isB20: true, variant, currency };
    } catch {
      return { isB20: true, variant }; // currency read failed; still a B20 stablecoin
    }
  }

  return { isB20: true, variant };
}

/** Render a short badge for alerts. Returns '' when not a B20. */
export function formatB20Badge(b20) {
  if (!b20 || !b20.isB20) return '';
  if (b20.variant === 'STABLECOIN') {
    return b20.currency ? `⬡ B20 · Stablecoin (${b20.currency})` : '⬡ B20 · Stablecoin';
  }
  if (b20.variant === 'ASSET') return '⬡ B20 · Asset';
  return '⬡ B20';
}

/**
 * Convenience: enrich a token object in place (only for Base). Attaches `token.b20`.
 * Call this ONCE when a Base token is first added to tracking — B20 status is immutable,
 * so there is no need to re-detect on every poll.
 */
export async function enrichWithB20(token) {
  if (!token || String(token.chain).toLowerCase() !== 'base') return token;
  token.b20 = await detectB20(token.address);
  return token;
}
