/** X handle normalization + group call-graph index (pure — no I/O). */

export function ensureXAccountsDb(db) {
  db.xAccounts = db.xAccounts || {};
  return db.xAccounts;
}

/** Normalize any handle/URL form to bare lowercase handle, or null if unparseable. */
export function normalizeXHandle(input) {
  if (!input) return null;
  let s = String(input).trim();
  const m = /(?:twitter\.com|x\.com)\/(@?[A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(s);
  if (m) s = m[1];
  s = s.replace(/^@/, '');
  if (/^(status|i|home|search|explore|intent|hashtag)$/i.test(s)) return null;
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s.toLowerCase() : null;
}

/** Extract the X handle from a DexScreener pair object, or null. */
export function xHandleFromPair(pair) {
  const socials = pair?.info?.socials || [];
  const tw = socials.find(
    (s) =>
      /^(twitter|x)$/i.test(s?.type || '') || /(?:twitter\.com|x\.com)\//i.test(s?.url || ''),
  );
  return tw ? normalizeXHandle(tw.url || tw.handle) : null;
}

/** Incremental index update — called on every successful autoTrack. */
export function indexXAccount(db, handle, storageKey) {
  if (!handle || !storageKey) return;
  const accounts = ensureXAccountsDb(db);
  const a = (accounts[handle] = accounts[handle] || { tokens: [], updatedAt: 0 });
  if (!a.tokens.includes(storageKey)) a.tokens.push(storageKey);
  if (a.tokens.length > 50) a.tokens = a.tokens.slice(-50);
  a.updatedAt = Date.now();
}

function entryPeakBadge(entry) {
  const peak = Number(entry?.peakMultiple) || 1;
  const badge = peak < 0.5 ? '💀' : peak >= 2 ? '🚀' : '➖';
  return { peak, badge };
}

/** Group-history line for auto-track embed (excludes currentKey). */
export function xHistoryLine(db, handle, currentKey) {
  const keys = (db.xAccounts?.[handle]?.tokens || []).filter((k) => k !== currentKey);
  if (keys.length === 0) return '';
  const entries = keys.map((k) => db.tokens[k] || db.archived?.[k]).filter(Boolean);
  if (!entries.length) return '';
  const parts = entries.slice(-4).map((e) => {
    const { peak, badge } = entryPeakBadge(e);
    return '$' + (e.symbol || '?') + ' ' + badge + ' ' + peak.toFixed(1) + 'x';
  });
  const rugs = entries.filter((e) => (Number(e.peakMultiple) || 1) < 0.5).length;
  const prefix = rugs > 0 && rugs === entries.length ? '☠️' : '📜';
  return (
    prefix +
    ' X history: ran ' +
    entries.length +
    ' tracked token' +
    (entries.length > 1 ? 's' : '') +
    ' — ' +
    parts.join(', ')
  );
}

/** /x report — history across handle chain, prefixed per handle. */
export function xHistoryReportLine(db, handles) {
  const parts = [];
  for (const h of handles) {
    const keys = db.xAccounts?.[h]?.tokens || [];
    const entries = keys.map((k) => db.tokens[k] || db.archived?.[k]).filter(Boolean);
    for (const e of entries.slice(-3)) {
      const { peak, badge } = entryPeakBadge(e);
      parts.push('@' + h + ' ran $' + (e.symbol || '?') + ' ' + badge + ' ' + peak.toFixed(1) + 'x');
    }
  }
  if (!parts.length) return '';
  return '📜 Your history: ' + parts.join(' · ');
}

/** D1 — any handle in chain tied to a rugged tracked token. */
export function chainHasRuggedToken(db, handles) {
  for (const h of handles) {
    const keys = db.xAccounts?.[h]?.tokens || [];
    for (const k of keys) {
      const e = db.tokens[k] || db.archived?.[k];
      if (e && (Number(e.peakMultiple) || 1) < 0.5) {
        return { hit: true, handle: h, symbol: e.symbol || '?' };
      }
    }
  }
  return { hit: false };
}

export function fmtCompact(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return String(num);
}
