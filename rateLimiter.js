// rateLimiter.js — single token-bucket + global 429 backoff for DexScreener
const MAX_RPS = 4;
const BUCKET_MAX = 8;
/** Cap acquire wait so a wedged pause cannot stall the volume poller forever. */
export let MAX_ACQUIRE_WAIT_MS = Number(process.env.RATE_ACQUIRE_TIMEOUT_MS) || 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
let tokens = BUCKET_MAX;
let pausedUntil = 0;

setInterval(() => {
  tokens = Math.min(BUCKET_MAX, tokens + MAX_RPS);
}, 1000).unref();

async function acquire() {
  const deadline = Date.now() + MAX_ACQUIRE_WAIT_MS;
  for (;;) {
    const now = Date.now();
    if (now >= deadline) {
      throw new Error('rate limiter acquire timed out after ' + MAX_ACQUIRE_WAIT_MS + 'ms');
    }
    if (now < pausedUntil) {
      // Sleep only until pause *or* deadline — never a multi-hour setTimeout.
      await new Promise((r) => setTimeout(r, Math.min(pausedUntil - now, deadline - now, 5_000)));
      continue;
    }
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(120, deadline - now)));
  }
}

let consecutive429 = 0;

function fetchSignal(opts) {
  if (opts.signal) return opts.signal;
  return AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS);
}

export const rateLimiter = {
  async fetch(url, opts = {}) {
    await acquire();
    const res = await fetch(url, { ...opts, signal: fetchSignal(opts) });
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

/** Test helper — do not call from runtime paths. */
export function setMaxAcquireWaitMsForTests(ms) {
  MAX_ACQUIRE_WAIT_MS = ms;
}

/** Test helper — do not call from runtime paths. */
export function resetRateLimiterForTests() {
  tokens = BUCKET_MAX;
  pausedUntil = 0;
  consecutive429 = 0;
  MAX_ACQUIRE_WAIT_MS = Number(process.env.RATE_ACQUIRE_TIMEOUT_MS) || 15_000;
}

/** Test helper — force a global pause without a real 429. */
export function pauseRateLimiterUntilForTests(ts) {
  pausedUntil = ts;
}
