/**
 * fib/config.js — single tuning file for the Fibonacci retracement tracker.
 * Deploy-level switches read from env; everything else is a sane default here.
 * Mirrors the signals/config.js "single tuning file" convention.
 */

function envBool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

function envNum(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name, fallback) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function envRatios(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parts = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 1);
  return parts.length ? parts.sort((a, b) => b - a) : fallback;
}

export const FIB = {
  /** Master switch — false disables all fib evaluation, commands still respond with "disabled". */
  ENABLED: envBool('FIB_TRACKING_ENABLED', true),

  /** Auto-start fib tracking on every token the Take-Profits tracker adds (lazy — begins at MIN_MCAP). */
  AUTO: envBool('AUTO_FIB_TRACKING', false),

  /** Eligibility floor — tokens below this market cap sit in `waiting_mcap` (auto) or are rejected (/fibtrack add). */
  MIN_MCAP: envNum('FIB_MIN_MCAP', 300_000),

  /** Anchor-detection candle timeframe per mode. Valid: 1m, 5m, 15m, 1h, 4h. */
  DEFAULT_TIMEFRAME: envStr('FIB_DEFAULT_TIMEFRAME', '1h'),
  FAST_TIMEFRAME: envStr('FIB_FAST_TIMEFRAME', '5m'),

  /**
   * Golden-zone alert (text). Pelpa convention: golden = enter 0.382.
   * Lower 0.236 = the FULL pocket box on the chart (0.382 → entry), i.e. the classic
   * 0.618–0.786 retracement zone on low-anchored labels. Arming inside it announces
   * golden. Set both equal for a single line and no box.
   */
  GOLDEN_UPPER: envNum('FIB_GOLDEN_UPPER', 0.382),
  GOLDEN_LOWER: envNum('FIB_GOLDEN_LOWER', 0.236),

  /**
   * Retrace ratio used only by the swing detector to confirm the impulse high
   * (pivot candles OR price already back to this level). Kept at classic 0.786 so
   * changing the golden *alert* level does not delay arming.
   */
  HIGH_CONFIRM_RATIO: envNum('FIB_HIGH_CONFIRM_RATIO', 0.786),

  /**
   * Downward alert levels below the golden zone, highest first.
   * The LOWEST ratio is the ENTRY level (chart alert + arms target mode).
   * Default: chart fires at 0.236 only (0.50 re-pull / 1.618 exit dialed later).
   */
  ALERT_RATIOS: envRatios('FIB_ALERT_LEVELS', [0.236]),

  /** Swing detection */
  MIN_IMPULSE_PCT: envNum('FIB_MIN_IMPULSE_PCT', 1.0), // low→high gain ≥ 100% (2x) to count as a major impulse
  MIN_CANDLES: envNum('FIB_MIN_CANDLE_COUNT', 20), // standard-mode minimum history
  MIN_CANDLES_FAST: envNum('FIB_MIN_CANDLE_COUNT_FAST', 10),
  PIVOT_STRENGTH: envNum('FIB_PIVOT_STRENGTH', 3), // candles required to confirm a pivot / the high
  REVERSAL_PCT: envNum('FIB_REVERSAL_PCT', 0.3), // zigzag reversal floor (30%)
  ATR_MULT: envNum('FIB_ATR_MULT', 3), // zigzag threshold = max(REVERSAL_PCT, ATR% × ATR_MULT)
  CANDLE_LIMIT: envNum('FIB_CANDLE_LIMIT', 400), // candles fetched per detection (GT max 1000)

  /** Re-anchoring: new high beyond stored high × (1 + threshold) AFTER any alert fired → new cycle. */
  REANCHOR_THRESHOLD: envNum('FIB_REANCHOR_THRESHOLD', 0.25),

  /** Standard-mode crossing confirmation: consecutive 1-minute closes beyond the level. */
  CONFIRM_CLOSES: envNum('FIB_CONFIRM_CLOSES', 2),

  /** Behavior when a cycle arms with price already below levels: 'deepest' fires the zone price is in now; 'none' arms silently. */
  ALERT_ON_ARM: envStr('FIB_ALERT_ON_ARM', 'deepest'),

  /** Take-profit targets computed at arm time (both derived, never hardcoded):
   *  tp1 = low + 1.618 × range (classic extension)
   *  tp2 = high + 1.236 × (high − entryLevel) (the "re-pull: 0.5 on the entry" construction) */
  TARGETS_ENABLED: envBool('FIB_TARGETS_ENABLED', true),

  /** Detection retry cadence + provider behavior */
  DETECT_RETRY_MS: envNum('FIB_DETECT_RETRY_MS', 10 * 60_000),
  PROVIDER_TIMEOUT_MS: envNum('FIB_PROVIDER_TIMEOUT_MS', 9_000),
  PROVIDER_RETRIES: envNum('FIB_MAX_PROVIDER_RETRIES', 2),
  CANDLE_CACHE_MS: envNum('FIB_CANDLE_CACHE_MS', 10 * 60_000),

  /** Independent watchlist poll cadence (ms). Reuses dexBatch, so cost is one batched call per chain per tick. */
  WATCH_POLL_MS: envNum('FIB_WATCH_POLL_MS', 15_000),

  /** Chart rendering on the entry alert */
  CHART_ENABLED: envBool('FIB_CHART_ENABLED', true),
  CHART_CANDLES: envNum('FIB_CHART_CANDLES', 120),

  /** Comma-separated Discord role IDs allowed to run mutating /fibtrack subcommands. Empty = everyone. */
  ALLOWED_ROLES: envStr('FIB_COMMAND_ALLOWED_ROLES', ''),

  /** GeckoTerminal network slugs per chain id (override if GT names them differently). */
  GT_NETWORKS: {
    solana: envStr('FIB_GT_NETWORK_SOLANA', 'solana'),
    base: envStr('FIB_GT_NETWORK_BASE', 'base'),
    robinhood: envStr('FIB_GT_NETWORK_ROBINHOOD', 'robinhood'),
  },

  /** GeckoTerminal free tier ≈ 30 calls/min → min spacing between calls. */
  GT_MIN_INTERVAL_MS: envNum('FIB_GT_MIN_INTERVAL_MS', 2_100),
};

/** Ratio → level value on a low-anchored fib (0 at swing low, 1 at swing high). */
export function fibValue(low, high, ratio) {
  return low + (high - low) * ratio;
}

/** Map timeframe string → GeckoTerminal {timeframe, aggregate} and bar length in ms. */
export function timeframeSpec(tf) {
  const t = String(tf || '1h').toLowerCase();
  const map = {
    '1m': { gtTf: 'minute', agg: 1, ms: 60_000 },
    '5m': { gtTf: 'minute', agg: 5, ms: 5 * 60_000 },
    '15m': { gtTf: 'minute', agg: 15, ms: 15 * 60_000 },
    '1h': { gtTf: 'hour', agg: 1, ms: 60 * 60_000 },
    '4h': { gtTf: 'hour', agg: 4, ms: 4 * 60 * 60_000 },
  };
  return map[t] || map['1h'];
}
