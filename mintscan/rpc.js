/**
 * mintscan/rpc.js — JSON-RPC client for the mint scanner's chain.
 *
 * Ported from take_profi_bot/src/public-rpc.ts. Round-robins across the
 * configured endpoints and fails over on error, so a rate-limited public RPC
 * degrades instead of dying.
 *
 * URL precedence: MINT_SCANNER_RPC_URLS (comma list) → Alchemy (if
 * ALCHEMY_API_KEY is set; Robinhood's recommended provider) → the chain's
 * public endpoint. Robinhood's public RPC is documented as rate-limited and
 * "not for production", so an Alchemy key is strongly recommended.
 */

import { getChain, getMintScannerConfig } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getRpcUrls() {
  const explicit = (process.env.MINT_SCANNER_RPC_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;

  const chain = getChain();
  const urls = [];
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (key && chain.alchemyHost) {
    urls.push('https://' + chain.alchemyHost + '.g.alchemy.com/v2/' + key);
  }
  urls.push(...chain.publicRpcUrls);
  return urls;
}

let _rr = 0;

async function rpcFetch(url, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('RPC non-JSON (HTTP ' + res.status + '): ' + text.slice(0, 120).replace(/\s+/g, ' ').trim());
  }
  if (!res.ok) throw new Error('RPC HTTP ' + res.status + ': ' + (data.error?.message || 'unknown'));
  if (data.error) throw new Error('RPC error: ' + (data.error.message || 'unknown'));
  return data;
}

export async function rpcCall(method, params = []) {
  const urls = getRpcUrls();
  if (!urls.length) throw new Error('No RPC URLs configured for the mint scanner');
  const timeoutMs = getMintScannerConfig().rpcTimeoutMs;

  const start = _rr++ % urls.length;
  let lastErr = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[(start + i) % urls.length];
    try {
      const data = await rpcFetch(url, { jsonrpc: '2.0', id: 1, method, params }, timeoutMs);
      return data.result;
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  throw lastErr || new Error('RPC call failed');
}

export async function getBlockNumber() {
  const hex = await rpcCall('eth_blockNumber', []);
  return parseInt(hex, 16);
}

export async function getLogs(filter) {
  const res = await rpcCall('eth_getLogs', [filter]);
  return Array.isArray(res) ? res : [];
}
