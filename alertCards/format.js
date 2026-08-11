/** Shared formatters for trencher alert cards (Discord + future Telegram). */

/** Rick-style compact number — 673K, 1.2M (no dollar sign). */
export function fmtRick(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const num = Number(n);
  const abs = Math.abs(num);
  if (abs >= 1e9) return (num / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (abs >= 1e6) return (num / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (abs >= 1e3) {
    const k = num / 1e3;
    const s = k >= 100 ? k.toFixed(0) : k.toFixed(1);
    return s.replace(/\.0$/, '') + 'K';
  }
  if (abs >= 1) return num.toFixed(2).replace(/\.?0+$/, '');
  return num.toPrecision(3);
}

/** Compact mcap — 711K style, no dollar sign. */
export function fmtCompactK(n) {
  if (!n || isNaN(Number(n))) return '—';
  const num = Number(n);
  if (num >= 1e9) return (num / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return num.toFixed(2).replace(/\.?0+$/, '');
}

/** Local clock time — 10:08pm. */
export function fmtClockTime(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0') + ampm;
}

/** Caller age for milestone footer — 4h 18m. */
export function fmtCallerAgeShort(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  const mi = Math.floor(diff / 60000);
  const h = Math.floor(mi / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + (mi % 60) + 'm';
  if (mi > 0) return mi + 'm';
  return 'just now';
}

/** Inline window row — 1h 673K +58.4% · 30m … */
export function fmtWindowInline(windows) {
  if (!Array.isArray(windows) || !windows.length) return '';
  return windows
    .map((w) => {
      const sign = w.pct != null && w.pct >= 0 ? '+' : '';
      const pctStr = w.pct != null && Number.isFinite(w.pct) ? sign + w.pct.toFixed(1) + '%' : '—';
      return w.label + ' ' + fmtRick(w.vol) + ' ' + pctStr;
    })
    .join(' · ');
}
