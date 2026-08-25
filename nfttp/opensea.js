/**
 * nfttp/opensea.js — OpenSea API v2 client for floor tracking.
 *
 * Endpoints:
 *   GET /api/v2/collections/{slug}              identity + supply + image
 *   GET /api/v2/collections/{slug}/stats        live floor + volume windows
 *   GET /api/v2/collections/{slug}/floor_prices 1h candle series for charts
 *   GET /api/v2/chain/{chain}/contract/{addr}   0x → slug
 *
 * Soft-fails to null so a 429/timeout never kills the poll loop.
 */

import { getNftTpConfig } from './config.js';

const OS_BASE = 'https://api.opensea.io/api/v2';

function headers() {
  const key = process.env.OPENSEA_API_KEY?.trim();
  if (!key) return null;
  return { accept: 'application/json', 'x-api-key': key };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let lastCallAt = 0;
const MIN_GAP_MS = 260; // ~4 req/s — OpenSea's public ceiling

async function osJson(path, { timeoutMs } = {}) {
  const hdrs = headers();
  if (!hdrs) return { ok: false, status: 0, data: null, error: 'no_api_key' };

  const cfg = getNftTpConfig();
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const url = path.startsWith('http') ? path : OS_BASE + path;
  try {
    const res = await fetch(url, {
      headers: hdrs,
      signal: AbortSignal.timeout(timeoutMs || cfg.timeoutMs),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || 2;
      console.warn('[nfttp/os] 429 — backing off ' + retry + 's');
      await sleep(retry * 1000);
      return { ok: false, status: 429, data: null, error: 'rate_limited' };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, error: 'http_' + res.status };
    }
    return { ok: true, status: res.status, data: await res.json(), error: null };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message };
  }
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function unixMs(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Map OpenSea interval labels onto card windows. Native stats only ship
 * one_day / seven_day / thirty_day — 1h comes from floor history instead.
 */
export function windowsFromStats(stats) {
  const intervals = Array.isArray(stats?.intervals) ? stats.intervals : [];
  const by = Object.create(null);
  for (const row of intervals) {
    if (row?.interval) by[row.interval] = row;
  }
  const pick = (label, keys) => {
    for (const k of keys) {
      const row = by[k];
      if (!row) continue;
      return { label, vol: num(row.volume), pct: null, sales: num(row.sales) };
    }
    return null;
  };
  return [
    pick('1h', ['one_hour', 'one_hour_volume']),
    pick('24h', ['one_day', 'one_day_volume']),
    pick('7d', ['seven_day', 'seven_days', 'seven_day_volume']),
  ].filter(Boolean);
}

/**
 * Floor % over lookback windows, used when stats have volume but no 1h/30m/15m.
 * @param {Array<{ t: number, c: number }>} candles chronological
 */
export function floorChangeWindows(candles, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  const last = candles[candles.length - 1];
  const lastPx = Number(last?.c);
  if (!Number.isFinite(lastPx) || lastPx <= 0) return [];

  const looks = [
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '30m', ms: 30 * 60 * 1000 },
    { label: '15m', ms: 15 * 60 * 1000 },
  ];
  const out = [];
  for (const w of looks) {
    const cutoff = now - w.ms;
    let prior = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (Number(candles[i].t) <= cutoff) {
        prior = candles[i];
        break;
      }
    }
    if (!prior) prior = candles[0];
    const base = Number(prior.c);
    if (!Number.isFinite(base) || base <= 0) continue;
    out.push({
      label: w.label,
      vol: lastPx,
      pct: ((lastPx - base) / base) * 100,
    });
  }
  return out;
}

/** Prefer 1h/30m/15m floor %; fall back to 24h/7d volume from stats. */
export function resolveNftWindows({ candles, stats }) {
  const floorWins = floorChangeWindows(candles);
  if (floorWins.length) return floorWins;
  return windowsFromStats(stats);
}

export async function fetchCollection(slug) {
  const { data, error } = await osJson('/collections/' + encodeURIComponent(slug));
  if (!data) return { collection: null, error };
  const contracts = Array.isArray(data.contracts) ? data.contracts : [];
  const primary = contracts[0] || {};
  return {
    collection: {
      slug: data.collection || slug,
      name: data.name || slug,
      imageUrl: data.image_url || data.banner_image_url || null,
      twitterUsername: data.twitter_username?.replace(/^@/, '') || null,
      totalSupply: num(data.total_supply),
      createdAt: data.created_date ? Date.parse(data.created_date) : null,
      openseaUrl: data.opensea_url || 'https://opensea.io/collection/' + slug,
      chain: primary.chain || null,
      address: primary.address || null,
      isNsfw: Boolean(data.is_nsfw),
      isDisabled: Boolean(data.is_disabled),
    },
    error: null,
  };
}

export async function fetchCollectionStats(slug) {
  const { data, error } = await osJson('/collections/' + encodeURIComponent(slug) + '/stats');
  if (!data) return { stats: null, error };
  const total = data.total || {};
  return {
    stats: {
      floor: num(total.floor_price),
      floorSymbol: total.floor_price_symbol || 'ETH',
      numOwners: num(total.num_owners),
      volume: num(total.volume),
      sales: num(total.sales),
      intervals: Array.isArray(data.intervals) ? data.intervals : [],
    },
    error: null,
  };
}

/**
 * Floor history → OHLC candles (900×400 trencher chart).
 * `timeframe=one_hour` is the closest analog to the token 1h Gecko chart.
 */
export async function fetchFloorCandles(slug, { timeframe = 'one_hour', resolution = 80 } = {}) {
  const q = new URLSearchParams({ timeframe, resolution: String(resolution) });
  const { data, error } = await osJson(
    '/collections/' + encodeURIComponent(slug) + '/floor_prices?' + q.toString(),
  );
  if (!data) return { candles: [], error };
  const points = Array.isArray(data.floor_prices) ? data.floor_prices : [];
  const candles = [];
  for (const p of points) {
    const t = unixMs(p.time);
    const c = num(p.token_unit);
    if (t == null || c == null || c < 0) continue;
    const prev = candles[candles.length - 1];
    const o = prev ? prev.c : c;
    candles.push({
      t,
      o,
      h: Math.max(o, c),
      l: Math.min(o, c),
      c,
      v: 0,
      symbol: p.symbol || null,
    });
  }
  return { candles, error: null };
}

export async function fetchContractCollection(chain, address) {
  const { data, error } = await osJson(
    '/chain/' + encodeURIComponent(chain) + '/contract/' + encodeURIComponent(address),
  );
  if (!data) return { slug: null, name: null, error };
  return {
    slug: data.collection?.trim() || null,
    name: data.name?.trim() || null,
    error: null,
  };
}

/**
 * Resolve a parsed ref to a live snapshot (identity + floor).
 * @returns {Promise<{ snapshot: object|null, error: string|null }>}
 */
export async function resolveNftSnapshot(ref) {
  let slug = ref.kind === 'slug' ? ref.slug : null;
  let chain = ref.chain || null;

  if (!slug && ref.kind === 'contract') {
    const cfg = getNftTpConfig();
    const chains = ref.chain ? [ref.chain] : cfg.chains;
    for (const c of chains) {
      const hit = await fetchContractCollection(c, ref.address);
      if (hit.slug) {
        slug = hit.slug;
        chain = c;
        break;
      }
    }
    if (!slug) return { snapshot: null, error: 'contract_not_on_opensea' };
  }

  if (!slug) return { snapshot: null, error: 'no_slug' };

  const [col, st] = await Promise.all([fetchCollection(slug), fetchCollectionStats(slug)]);
  if (!col.collection) return { snapshot: null, error: col.error || 'collection_missing' };
  if (col.collection.isDisabled) return { snapshot: null, error: 'disabled' };

  const stats = st.stats;
  const floor = stats?.floor ?? null;
  const supply = col.collection.totalSupply;
  const mcap =
    floor != null && supply != null && floor > 0 && supply > 0 ? floor * supply : null;

  return {
    snapshot: {
      slug: col.collection.slug,
      name: col.collection.name,
      ticker: null, // filled by caller via tickerFromSlug
      imageUrl: col.collection.imageUrl,
      twitterUsername: col.collection.twitterUsername,
      totalSupply: supply,
      createdAt: col.collection.createdAt,
      openseaUrl: col.collection.openseaUrl,
      chain: col.collection.chain || chain,
      address: col.collection.address || ref.address || null,
      floor,
      floorSymbol: stats?.floorSymbol || 'ETH',
      numOwners: stats?.numOwners ?? null,
      volume: stats?.volume ?? null,
      mcap,
      stats,
    },
    error: null,
  };
}

export function hasOpenSeaKey() {
  return Boolean(process.env.OPENSEA_API_KEY?.trim());
}
