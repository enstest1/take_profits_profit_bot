/**
 * fib/minuteBars.js — builds sampled OHLC bars from the ~15s live poll stream.
 *
 * Default behavior remains 1-minute bars for existing fib logic. Telegram Golden
 * Pocket also asks for a separate 5-minute stream so its pre-buy confirmation
 * costs zero extra provider calls.
 */

const bars = new Map(); // interval:key -> { start, o, h, l, c }

function barStart(ms, intervalMs) {
  return Math.floor(ms / intervalMs) * intervalMs;
}

function mapKey(key, intervalMs) {
  return String(intervalMs) + ':' + String(key);
}

/**
 * update(key, value, now, intervalMs?) -> just-closed sampled bar when a new
 * interval begins, otherwise null.
 */
export function update(key, value, now = Date.now(), intervalMs = 60_000) {
  if (value == null || !Number.isFinite(value)) return null;
  const span = Number(intervalMs);
  if (!Number.isFinite(span) || span < 1_000) throw new Error('invalid bar interval');

  const k = mapKey(key, span);
  const start = barStart(now, span);
  const cur = bars.get(k);

  if (!cur) {
    bars.set(k, { start, o: value, h: value, l: value, c: value });
    return null;
  }

  if (start > cur.start) {
    const closed = { ...cur, end: cur.start + span };
    bars.set(k, { start, o: value, h: value, l: value, c: value });
    return closed;
  }

  cur.h = Math.max(cur.h, value);
  cur.l = Math.min(cur.l, value);
  cur.c = value;
  return null;
}

export function currentBar(key, intervalMs = 60_000) {
  return bars.get(mapKey(key, intervalMs)) || null;
}

export function reset(key) {
  if (key == null) {
    bars.clear();
    return;
  }
  const suffix = ':' + String(key);
  for (const k of bars.keys()) {
    if (k.endsWith(suffix)) bars.delete(k);
  }
}
