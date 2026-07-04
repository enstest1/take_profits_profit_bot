// rateLimiter.js — single token-bucket + global 429 backoff for DexScreener
const MAX_RPS = 4;
const BUCKET_MAX = 8;
let tokens = BUCKET_MAX;
let pausedUntil = 0;

setInterval(() => {
  tokens = Math.min(BUCKET_MAX, tokens + MAX_RPS);
}, 1000).unref();

async function acquire() {
  for (;;) {
    const now = Date.now();
    if (now < pausedUntil) {
      await new Promise((r) => setTimeout(r, pausedUntil - now));
      continue;
    }
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

let consecutive429 = 0;

export const rateLimiter = {
  async fetch(url, opts = {}) {
    await acquire();
    const res = await fetch(url, opts);
    if (res.status === 429) {
      consecutive429 += 1;
      const backoffMs = Math.min(60_000, 2_000 * 2 ** (consecutive429 - 1));
      pausedUntil = Date.now() + backoffMs;
      console.warn('[rate] 429 — global pause ' + backoffMs + 'ms (streak ' + consecutive429 + ')');
    } else if (res.ok) {
      consecutive429 = 0;
    }
    return res;
  },
  stats() {
    return { tokens, pausedUntil, consecutive429 };
  },
};
