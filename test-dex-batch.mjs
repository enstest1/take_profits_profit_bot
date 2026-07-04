#!/usr/bin/env node
/**
 * DexScreener batch endpoint validation (run before PR 2 merge).
 * Usage: node scripts/test-dex-batch.mjs
 */
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function test(label, url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const count = Array.isArray(body) ? body.length : 0;
  console.log(label + ': HTTP ' + res.status + ', pairs returned=' + count);
  return { status: res.status, count };
}

const base = 'https://api.dexscreener.com/tokens/v1/solana/';
const thirty = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? SOL : USDC)).join(',');

await test('30 valid mints', base + thirty);
await test('29 valid + 1 garbage', base + thirty.split(',').slice(0, 29).join(',') + ',notavalidbase58mintaddress000000000');
const thirtyOne = Array.from({ length: 31 }, () => SOL).join(',');
await test('31 mints (limit probe)', base + thirtyOne);

console.log('\nChunk size stays at 30 per fablereview plan.');
