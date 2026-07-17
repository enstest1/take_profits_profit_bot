/**
 * fib/minuteBars.js — builds 1-minute bars from the ~15s live poll samples, in memory only.
 * Used for standard-mode crossing confirmation, entry-held detection, and invalidation
 * (all bar-CLOSE based) with zero extra API calls. Never persisted (keeps tracked.json
 * lean and Warden's schema bounds untouched).
 *
 * update(key, value, now) → the just-CLOSED bar { start, o, h, l, c } when a new minute
 * begins (possibly several missed minutes collapse into the last known bar), else null.
 */

const bars = new Map(); // key → { start, o, h, l, c }

const minuteStart = (ms) => Math.floor(ms / 60_000) * 60_000;

export function update(key, value, now = Date.now()) {
  if (value == null || !Number.isFinite(value)) return null;
  const start = minuteStart(now);
  const cur = bars.get(key);

  if (!cur) {
    bars.set(key, { start, o: value, h: value, l: value, c: value });
    return null;
  }

  if (start > cur.start) {
    const closed = { ...cur };
    bars.set(key, { start, o: value, h: value, l: value, c: value });
    return closed;
  }

  cur.h = Math.max(cur.h, value);
  cur.l = Math.min(cur.l, value);
  cur.c = value;
  return null;
}

export function currentBar(key) {
  return bars.get(key) || null;
}

export function reset(key) {
  if (key == null) bars.clear();
  else bars.delete(key);
}
