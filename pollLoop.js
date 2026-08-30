/**
 * Shared volume-poll loop for every Discord / Telegram instance.
 *
 * Why: a hung await inside pollTokens used to stall milestone cards in every
 * guild on that process (Bitcernals + TP4APH share one bot). New communities
 * are their own Railway service — they still run this loop, so a hang must
 * self-restart instead of going silent.
 */
import { pollTokens as defaultPollTokens, resetPollCycleLock } from './poller.js';
import { markCycleStarted, pollHealth } from './cycleStats.js';
import { withTimeout } from './asyncTimeout.js';

export const TOKEN_POLL_INTERVAL_MS = Number(process.env.TOKEN_POLL_INTERVAL_MS) || 3 * 60 * 1000;
export const TOKEN_POLL_MIN_GAP_MS = 5000;
/** Hard ceiling per cycle. Prod cycles are seconds; 8m is headroom for a fat /data volume. */
export const TOKEN_POLL_CYCLE_TIMEOUT_MS = Number(process.env.TOKEN_POLL_CYCLE_TIMEOUT_MS) || 8 * 60 * 1000;

/**
 * Exit if last successful cycle is older than Warden C9 (3× interval) after boot grace.
 * Railway restartPolicy ON_FAILURE brings the instance back.
 * @param {{ exit?: (code: number) => void, everyMs?: number, pollHealthFn?: Function }} [opts]
 */
export function startPollWatchdog(opts = {}) {
  const exit = opts.exit || ((code) => process.exit(code));
  const everyMs = opts.everyMs || 30_000;
  const healthFn = opts.pollHealthFn || pollHealth;
  const timer = setInterval(() => {
    const h = healthFn();
    if (h.ok) return;
    console.error('[poll] watchdog: ' + h.reason + ' — exiting so Railway restarts this instance');
    exit(1);
  }, everyMs);
  timer.unref();
  return timer;
}

/**
 * @param {object} client
 * @param {{
 *   pollTokens?: Function,
 *   intervalMs?: number,
 *   minGapMs?: number,
 *   cycleTimeoutMs?: number,
 *   exit?: (code: number) => void,
 *   watchdog?: boolean,
 *   watchdogEveryMs?: number,
 * }} [opts]
 */
export async function runTokenPollLoop(client, opts = {}) {
  const poll = opts.pollTokens || defaultPollTokens;
  const intervalMs = opts.intervalMs ?? TOKEN_POLL_INTERVAL_MS;
  const minGapMs = opts.minGapMs ?? TOKEN_POLL_MIN_GAP_MS;
  const cycleTimeoutMs = opts.cycleTimeoutMs ?? TOKEN_POLL_CYCLE_TIMEOUT_MS;
  const exit = opts.exit || ((code) => process.exit(code));
  if (opts.watchdog !== false) {
    startPollWatchdog({ exit, everyMs: opts.watchdogEveryMs });
  }

  while (true) {
    markCycleStarted();
    const t0 = Date.now();
    try {
      await withTimeout(poll(client), cycleTimeoutMs, 'pollTokens');
    } catch (e) {
      console.error('[poll] loop error:', e);
      if (/timed out/i.test(String(e && e.message))) {
        resetPollCycleLock('cycle timeout');
        console.error('[poll] cycle hung — exiting so Railway restarts this instance');
        exit(1);
        return;
      }
    }
    const elapsed = Date.now() - t0;
    const wait = Math.max(minGapMs, intervalMs - elapsed);
    console.log('[poll] cycle ' + Math.round(elapsed / 1000) + 's — next in ' + Math.round(wait / 1000) + 's');
    await new Promise((r) => setTimeout(r, wait));
  }
}
