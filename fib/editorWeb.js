/**
 * fib/editorWeb.js — signed web editor for manual Fib anchors + take-profit alert line.
 * Served by the bot's existing Railway HTTP server. No extra service/database.
 */
import crypto from 'crypto';
import * as engine from './engine.js';
import { FIB } from './config.js';
import { fetchCandles, resolveTopPool } from './geckoTerminal.js';
import { pairFromDexUrl, updateFibWatch } from './store.js';
import { ensureDBSchema, loadDB } from '../dbStore.js';
import { parseStorageKey } from '../chains.js';

const EDIT_TTL_SEC = 14 * 24 * 60 * 60;
const VALID_TF = new Set(['1m', '5m', '15m', '1h', '4h']);

function secret() {
  return process.env.FIB_EDITOR_SECRET || '';
}

function baseUrl() {
  const raw = process.env.FIB_EDITOR_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '';
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/$/, '') : 'https://' + raw.replace(/\/$/, '');
}

function hmac(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 40);
}

function safeEqual(a, b) {
  try {
    const aa = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

export function buildFibEditorUrl(key, cycleId, now = Date.now()) {
  const base = baseUrl();
  if (!base || !secret() || !key || !cycleId) return null;
  const exp = Math.floor(now / 1000) + EDIT_TTL_SEC;
  const cycle = Number(cycleId);
  const payload = String(key) + '|' + cycle + '|' + exp;
  const sig = hmac(payload);
  return (
    base + '/fib-editor?key=' + encodeURIComponent(String(key)) +
    '&cycle=' + cycle + '&exp=' + exp + '&sig=' + sig
  );
}

function authQuery(url) {
  if (!secret()) return { ok: false, error: 'editor_disabled' };
  const u = new URL(url || '/', 'http://fib.local');
  const key = u.searchParams.get('key') || '';
  const cycle = Number(u.searchParams.get('cycle'));
  const exp = Number(u.searchParams.get('exp'));
  const sig = u.searchParams.get('sig') || '';
  if (!key || !Number.isInteger(cycle) || cycle < 1 || !Number.isFinite(exp) || !sig) {
    return { ok: false, error: 'bad_link' };
  }
  if (Math.floor(Date.now() / 1000) > exp) return { ok: false, error: 'link_expired' };
  const expected = hmac(key + '|' + cycle + '|' + exp);
  if (!safeEqual(sig, expected)) return { ok: false, error: 'bad_signature' };
  return { ok: true, key, cycle, exp, sig, url: u };
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(body);
}

async function readJson(req, limit = 32_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function locate(db, key) {
  const t = db.tokens?.[key];
  if (t?.fib) return { where: 'tokens', entry: t, fib: t.fib };
  const w = db.fibWatch?.[key];
  if (w?.fib) return { where: 'watch', entry: w, fib: w.fib };
  return null;
}

function convertCandles(candles, fib) {
  if (fib.metric !== 'marketCap' || !fib.supplyFactor) return candles;
  const f = Number(fib.supplyFactor);
  if (!Number.isFinite(f) || f <= 0) return candles;
  return candles.map((c) => ({
    t: c.t,
    o: c.o * f,
    h: c.h * f,
    l: c.l * f,
    c: c.c * f,
    v: c.v,
  }));
}

async function candlesFor(key, loc, tf, { fresh = false, limit = 1000 } = {}) {
  const parsed = parseStorageKey(key);
  const chainId = (loc.entry.chain || parsed.chainId || '').toLowerCase();
  const address = loc.entry.address || parsed.address;
  let pool = loc.fib.poolAddress || loc.entry.pairAddress || pairFromDexUrl(loc.entry.dexUrl);
  if (!pool) {
    const r = await resolveTopPool(chainId, address);
    if (r.error) throw new Error('pool_' + r.error);
    pool = r.poolAddress;
  }
  const got = await fetchCandles(chainId, pool, tf, { limit, fresh });
  if (got.error) throw new Error('candles_' + got.error);
  return { candles: convertCandles(got.candles, loc.fib), pool, chainId, address };
}

function publicState(key, loc, tf, candles) {
  const fib = loc.fib;
  return {
    key,
    symbol: loc.entry.symbol || key.slice(0, 10),
    name: loc.entry.name || loc.entry.symbol || 'Token',
    chain: (loc.entry.chain || parseStorageKey(key).chainId || '').toLowerCase(),
    address: loc.entry.address || parseStorageKey(key).address,
    dexUrl: loc.entry.dexUrl || null,
    cycleId: fib.cycleId,
    status: fib.status,
    mode: fib.mode,
    timeframe: tf,
    fibTimeframe: fib.timeframe,
    metric: fib.metric || 'marketCap',
    anchorSource: fib.anchorSource || 'auto',
    anchorRevision: fib.anchorRevision || 1,
    anchors: fib.anchors,
    levels: fib.levels,
    targets: fib.targets,
    takeProfitAlert: fib.takeProfitAlert || null,
    lastValue: fib.lastValue,
    ratios: {
      goldenUpper: Number(FIB.GOLDEN_UPPER),
      goldenLower: Number(FIB.GOLDEN_LOWER),
      entry: Number(fib.entryRatio ?? Math.min(...FIB.ALERT_RATIOS)),
    },
    candles,
  };
}

async function stateResponse(auth, tf) {
  const db = ensureDBSchema(loadDB());
  const loc = locate(db, auth.key);
  if (!loc) return { status: 404, body: { error: 'fib_not_found' } };
  if (Number(loc.fib.cycleId) !== auth.cycle) {
    return { status: 409, body: { error: 'cycle_changed', currentCycle: loc.fib.cycleId } };
  }
  const pickedTf = VALID_TF.has(tf) ? tf : (VALID_TF.has(loc.fib.timeframe) ? loc.fib.timeframe : '1h');
  const got = await candlesFor(auth.key, loc, pickedTf, { fresh: true, limit: 1000 });
  return { status: 200, body: publicState(auth.key, loc, pickedTf, got.candles) };
}

function queueIntegratedOverride(key, loc, override) {
  updateFibWatch((fw) => {
    const cur = fw[key] || {
      chain: loc.entry.chain,
      address: loc.entry.address,
      symbol: loc.entry.symbol,
    };
    cur.manualOverride = override;
    cur.manualAt = override.at;
    cur.rev = (cur.rev || 0) + 1;
    delete cur.suppress;
    fw[key] = cur;
  });
}

function applyWatchOverride(key, override) {
  return updateFibWatch((fw) => {
    const w = fw[key];
    if (!w?.fib) return false;
    engine.applyManualAnchors(w.fib, override, w.fib.lastValue, override.at);
    w.rev = (w.rev || 0) + 1;
    return true;
  });
}

function revertWatchToAuto(key) {
  return updateFibWatch((fw) => {
    const w = fw[key];
    if (!w?.fib) return false;
    const shell = engine.initStateShell(w.fib.mode, w.fib.timeframe);
    shell.cycleId = w.fib.cycleId || 0;
    shell.createdAt = w.fib.createdAt || shell.createdAt;
    shell.status = 'detecting';
    shell.nextDetectAt = 0;
    shell.anchorSource = 'auto';
    if (w.pairAddress) shell.poolAddress = w.pairAddress;
    w.fib = shell;
    w.rev = (w.rev || 0) + 1;
    return true;
  });
}

function queueIntegratedAuto(key, loc, now) {
  updateFibWatch((fw) => {
    const cur = fw[key] || {
      chain: loc.entry.chain,
      address: loc.entry.address,
      symbol: loc.entry.symbol,
    };
    cur.recalcAt = now;
    delete cur.manualOverride;
    delete cur.manualAt;
    cur.rev = (cur.rev || 0) + 1;
    fw[key] = cur;
  });
}

async function saveManual(auth, body) {
  const tf = VALID_TF.has(body.timeframe) ? body.timeframe : null;
  if (!tf) return { status: 400, body: { error: 'bad_timeframe' } };
  const lowT = Number(body.lowT);
  const highT = Number(body.highT);
  if (!Number.isFinite(lowT) || !Number.isFinite(highT) || lowT >= highT) {
    return { status: 400, body: { error: 'bad_anchors' } };
  }

  const db = ensureDBSchema(loadDB());
  const loc = locate(db, auth.key);
  if (!loc) return { status: 404, body: { error: 'fib_not_found' } };
  if (Number(loc.fib.cycleId) !== auth.cycle) {
    return { status: 409, body: { error: 'cycle_changed', currentCycle: loc.fib.cycleId } };
  }

  const got = await candlesFor(auth.key, loc, tf, { fresh: true, limit: 1000 });
  const lowC = got.candles.find((c) => Number(c.t) === lowT);
  const highC = got.candles.find((c) => Number(c.t) === highT);
  if (!lowC || !highC) return { status: 409, body: { error: 'anchor_candle_not_found' } };

  const low = { t: lowC.t, v: Number(lowC.l) };
  const high = { t: highC.t, v: Number(highC.h) };
  if (!(low.v > 0) || !(high.v > low.v)) return { status: 400, body: { error: 'invalid_swing' } };

  const range = high.v - low.v;
  const tp1 = low.v + range * 1.618;
  let takeProfitValue = Number(body.takeProfitValue);
  if (!Number.isFinite(takeProfitValue)) takeProfitValue = tp1;
  takeProfitValue = Math.max(high.v, Math.min(tp1, takeProfitValue));

  const now = Date.now();
  const override = {
    low,
    high,
    timeframe: tf,
    takeProfitValue,
    at: now,
    reason: 'manual web editor',
  };

  if (loc.where === 'watch') {
    if (!applyWatchOverride(auth.key, override)) {
      return { status: 409, body: { error: 'save_conflict' } };
    }
    return { status: 200, body: { ok: true, applied: true, anchorSource: 'manual' } };
  }

  queueIntegratedOverride(auth.key, loc, override);
  return {
    status: 202,
    body: { ok: true, applied: false, queued: true, note: 'Applies on the next bot poll.' },
  };
}

async function revertAuto(auth) {
  const db = ensureDBSchema(loadDB());
  const loc = locate(db, auth.key);
  if (!loc) return { status: 404, body: { error: 'fib_not_found' } };
  if (Number(loc.fib.cycleId) !== auth.cycle) {
    return { status: 409, body: { error: 'cycle_changed', currentCycle: loc.fib.cycleId } };
  }
  const now = Date.now();
  if (loc.where === 'watch') {
    if (!revertWatchToAuto(auth.key)) return { status: 409, body: { error: 'save_conflict' } };
    return { status: 200, body: { ok: true, applied: true, anchorSource: 'auto' } };
  }
  queueIntegratedAuto(auth.key, loc, now);
  return { status: 202, body: { ok: true, queued: true, note: 'Fresh auto detection queued.' } };
}

export async function handleFibEditorRequest(req, res) {
  const u = new URL(req.url || '/', 'http://fib.local');
  const path = u.pathname;

  if (req.method === 'GET' && path === '/fib-editor') {
    const hasSignedParams =
      u.searchParams.has('key') ||
      u.searchParams.has('cycle') ||
      u.searchParams.has('exp') ||
      u.searchParams.has('sig');

    // Bare /fib-editor is a public, non-writing demo. Signed links from Discord
    // still open the live cycle and keep all save/revert actions authenticated.
    if (!hasSignedParams) return html(res, 200, editorPage());
    const auth = authQuery(req.url);
    if (!auth.ok) return html(res, 403, errorPage(auth.error));
    return html(res, 200, editorPage());
  }

  if (req.method === 'GET' && path === '/api/fib-editor/state') {
    const auth = authQuery(req.url);
    if (!auth.ok) return json(res, 403, { error: auth.error });
    try {
      const out = await stateResponse(auth, u.searchParams.get('tf'));
      return json(res, out.status, out.body);
    } catch (e) {
      console.error('[fib/editor] state:', e.message);
      return json(res, 502, { error: e.message });
    }
  }

  if (req.method === 'POST' && path === '/api/fib-editor/save') {
    const auth = authQuery(req.url);
    if (!auth.ok) return json(res, 403, { error: auth.error });
    try {
      const out = await saveManual(auth, await readJson(req));
      return json(res, out.status, out.body);
    } catch (e) {
      console.error('[fib/editor] save:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && path === '/api/fib-editor/auto') {
    const auth = authQuery(req.url);
    if (!auth.ok) return json(res, 403, { error: auth.error });
    try {
      const out = await revertAuto(auth);
      return json(res, out.status, out.body);
    } catch (e) {
      console.error('[fib/editor] auto:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  json(res, 404, { error: 'not_found' });
}

function errorPage(reason) {
  const msg = reason === 'link_expired'
    ? 'This editor link expired. Open a newer Fib card in Discord for a fresh link.'
    : 'This Fib editor link is invalid or no longer available.';
  return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fib Editor</title>' +
    '<body style="margin:0;background:#05090d;color:#eaf2f8;font:16px system-ui;display:grid;place-items:center;min-height:100vh">' +
    '<div style="max-width:560px;padding:32px"><h1>Golden Pocket · Fib Editor</h1><p style="color:#9fb0bf">' + msg + '</p></div></body>';
}

function editorPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Golden Pocket · Fib Editor</title>
<style>
:root{color-scheme:dark;--bg:#06090d;--panel:#0b1118;--panel2:#0f1720;--border:#1d2a35;--text:#eef4f8;--muted:#8293a3;--green:#19c79a;--lime:#b8ff00;--gold:#f2c84b;--red:#f04f62;--blue:#83bfff;--cyan:#52d7ff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 40% -20%,#0f1a20 0,#05090d 45%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Arial,sans-serif}
button{font:inherit}.topbar{height:72px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;padding:0 24px;background:rgba(5,9,13,.94)}
.logo{width:40px;height:40px;border:1px solid #6d5511;border-radius:12px;display:grid;place-items:center;position:relative;overflow:hidden;background:radial-gradient(circle at 50% 52%,#ffe875 0 12%,#8a6b17 13% 18%,transparent 19% 30%,#e7b62c 31% 35%,transparent 36%),linear-gradient(145deg,#171204,#070904);box-shadow:inset 0 0 18px #d9aa221f,0 0 18px #d9aa2214}.logo:before{content:"";position:absolute;width:28px;height:17px;border:1.5px solid #e9bf46;border-radius:50%;transform:rotate(-15deg);opacity:.95}.logo:after{content:"";position:absolute;left:7px;right:7px;bottom:6px;height:8px;border:1px solid #d59f23;border-top:0;border-radius:0 0 9px 9px;background:linear-gradient(180deg,#d3a21a22,#f7d75b55)}.logo i{width:8px;height:8px;border-radius:50%;background:#fff1a6;box-shadow:0 0 9px #ffd95f;z-index:2}
.brand{font-weight:800;letter-spacing:.08em}.sub{color:#8ba1b6;border-left:1px solid #33404a;padding-left:14px}.demoBadge{display:none;font-size:11px;font-weight:900;letter-spacing:.08em;color:#08130b;background:#b8ff00;border-radius:999px;padding:5px 9px}.demoBadge.show{display:inline-flex}.grow{flex:1}
.toplink{color:#a7d1ff;text-decoration:none;font-weight:650;margin-left:12px}.toplink[hidden]{display:none}.shell{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;padding:16px;max-width:1680px;margin:auto}
.main{min-width:0}.asset{display:flex;align-items:center;gap:12px;margin:3px 4px 14px}.tokenmark{width:46px;height:46px;border:1px solid #8795a0;border-radius:50%;display:grid;place-items:center;font-weight:800}.asset h1{font-size:28px;margin:0}.meta{color:#8eb3d5;font-size:14px;margin-top:2px}.tfs{margin-left:auto;display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}.tf{min-width:54px;padding:10px 12px;border:0;border-right:1px solid var(--border);background:#0b1118;color:#9eb0bf;cursor:pointer;transition:.14s ease}.tf:last-child{border-right:0}.tf:hover{background:#111a23;color:#d5e1e9}.tf.active{color:#fff0a6;background:#211b0d;box-shadow:inset 0 0 0 1px #9e791d}.tf:disabled{opacity:.55;cursor:wait}.chartbox{position:relative;background:#03070a;border:1px solid var(--border);border-radius:10px;overflow:hidden}.charthead{position:absolute;z-index:3;left:15px;top:12px;pointer-events:none}.charttitle{font-weight:750}.ohlc{font-size:12px;color:#94a6b4;margin-top:4px}.ohlc strong{color:var(--green)}canvas{display:block;width:100%;height:620px;touch-action:none}.hint{display:flex;gap:8px;align-items:center;color:#91a2b0;padding:10px 13px;border:1px solid var(--border);border-top:0;border-radius:0 0 10px 10px;background:#080e13;font-size:13px}.hint b{color:#e4edf3}
.side{display:flex;flex-direction:column;gap:12px}.card{background:linear-gradient(180deg,#0d141c,#0a1016);border:1px solid var(--border);border-radius:10px;padding:16px}.card h2{font-size:16px;margin:0 0 14px}.mode{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.pill{font-size:12px;font-weight:900;padding:5px 12px;border-radius:999px;background:var(--green);color:#061108}.pill.manual{background:var(--gold);color:#181500}.row{display:grid;grid-template-columns:1fr auto;gap:12px;padding:9px 0;border-top:1px solid #15212b}.row:first-of-type{border-top:0}.lab{color:#9eafbd}.val{font-weight:750;text-align:right}.small{font-size:12px;color:#708394}.levels .row:nth-child(2) .val{color:var(--green)}.levels .gold .lab,.levels .gold .val{color:var(--gold)}.levels .entry .lab,.levels .entry .val{color:var(--red)}.levels .alert .lab,.levels .alert .val{color:var(--cyan);font-weight:800}
.alertbox{padding:12px;border:1px solid #1e4654;border-radius:8px;background:#08151a;margin-top:12px}.alertbox strong{color:var(--cyan)}.alertbox p{margin:5px 0 0;color:#8ca7b1;font-size:12px;line-height:1.4}
.actions{display:grid;gap:9px}.btn{border:1px solid #283744;background:#111a22;color:#dbe6ed;border-radius:8px;padding:12px 14px;font-weight:750;cursor:pointer}.btn:hover{background:#16222d}.btn.primary{border-color:#1d6e3e;background:#173d27;color:#dffff0}.btn.danger{border-color:#5c3333;background:#241415}.btn:disabled{opacity:.42;cursor:not-allowed}.dirty{font-size:12px;color:#f2dc74;margin:8px 0 0;min-height:16px}.toast{position:fixed;right:20px;bottom:20px;max-width:360px;padding:12px 14px;border:1px solid #31536a;border-radius:9px;background:#0b1821;color:#d9eefb;box-shadow:0 12px 40px #0008;display:none;z-index:10}.toast.show{display:block}
.footergrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.mini{background:#080e13;border:1px solid var(--border);border-radius:9px;padding:14px}.mini h3{font-size:14px;margin:0 0 10px}.stats{display:flex;gap:30px;flex-wrap:wrap}.stat span{display:block;color:#7e90a0;font-size:11px}.stat b{font-size:13px}.links a{color:#9bcfff;text-decoration:none;margin-right:18px;font-size:13px}
@media(max-width:980px){.shell{grid-template-columns:1fr}.side{display:grid;grid-template-columns:1fr 1fr}.tfs{margin-left:0;flex-wrap:wrap}.asset{flex-wrap:wrap}.footergrid{grid-template-columns:1fr}}
@media(max-width:620px){.topbar{padding:0 14px}.brand{font-size:14px}.sub,.toplink{display:none}.shell{padding:10px}.asset h1{font-size:23px}.side{grid-template-columns:1fr}canvas{height:520px}.tf{min-width:45px;padding:9px 8px}.footergrid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header class="topbar"><div class="logo"><i></i></div><div class="brand">GOLDEN POCKET</div><div class="sub">Fib Editor</div><span class="demoBadge" id="demoBadge">PUBLIC DEMO</span><div class="grow"></div><a id="dexTop" class="toplink" target="_blank" rel="noreferrer" hidden>View on DexScreener ↗</a></header>
<main class="shell">
<section class="main">
  <div class="asset"><div class="tokenmark" id="mark">TP</div><div><h1 id="symbol">Loading…</h1><div class="meta" id="meta">Fetching cycle</div></div>
    <div class="tfs" id="tfs"><button class="tf" data-tf="1m">1m</button><button class="tf" data-tf="5m">5m</button><button class="tf" data-tf="15m">15m</button><button class="tf" data-tf="1h">1h</button><button class="tf" data-tf="4h">4h</button></div>
  </div>
  <div class="chartbox"><div class="charthead"><div class="charttitle" id="chartTitle">Fib chart</div><div class="ohlc" id="ohlc"></div></div><canvas id="chart"></canvas></div>
  <div class="hint">↕ <b>Drag the gold low/high handles</b> to snap the Fib pull to candle wicks. Drag the <b style="color:var(--cyan)">TAKE PROFIT ALERT</b> line down from 1.618 to choose when Discord should notify you.</div>
  <div class="footergrid">
    <div class="mini"><h3>Cycle Info</h3><div class="stats"><div class="stat"><span>Impulse</span><b id="impulse">—</b></div><div class="stat"><span>Timeframe</span><b id="tfStat">—</b></div><div class="stat"><span>Source</span><b id="sourceStat">—</b></div><div class="stat"><span>Revision</span><b id="revStat">—</b></div></div></div>
    <div class="mini links"><h3>Token Links</h3><a id="dexBottom" target="_blank" rel="noreferrer">DexScreener ↗</a></div>
  </div>
</section>
<aside class="side">
  <div class="card">
    <div class="mode"><h2 style="margin:0">Anchor Mode</h2><span class="pill" id="modePill">AUTO</span><span class="small" id="cycle">Cycle #—</span></div>
    <div class="row"><div class="lab">Low (start of swing)</div><div><div class="val" id="lowVal">—</div><div class="small" id="lowTime"></div></div></div>
    <div class="row"><div class="lab">High (end of swing)</div><div><div class="val" id="highVal">—</div><div class="small" id="highTime"></div></div></div>
  </div>
  <div class="card levels"><h2>Fibonacci Levels <span class="small" id="metricLabel"></span></h2>
    <div class="row"><div class="lab">1.618 <span class="small">(reference)</span></div><div class="val" id="tp1Val">—</div></div>
    <div class="row alert"><div class="lab">TAKE PROFIT ALERT</div><div class="val" id="alertVal">—</div></div>
    <div class="row"><div class="lab">1.0 <span class="small">(High)</span></div><div class="val" id="oneVal">—</div></div>
    <div class="row gold"><div class="lab" id="goldLab">0.382 (Golden)</div><div class="val" id="goldVal">—</div></div>
    <div class="row entry"><div class="lab" id="entryLab">0.236 (Entry)</div><div class="val" id="entryVal">—</div></div>
    <div class="row"><div class="lab">0.0 <span class="small">(Low)</span></div><div class="val" id="zeroVal">—</div></div>
    <div class="alertbox"><strong>Discord notification trigger</strong><p id="alertHelp">The alert line starts at the 1.618 extension. Pull it down to notify earlier. The real 1.618 line always stays on the chart.</p></div>
  </div>
  <div class="card"><h2>Quick Actions</h2><div class="actions">
    <button class="btn primary" id="saveBtn" disabled>✓ Save Pull + Alert</button>
    <button class="btn" id="undoBtn" disabled>↶ Undo Changes</button>
    <button class="btn" id="redoBtn" disabled>↷ Redo Changes</button>
    <button class="btn danger" id="autoBtn" disabled>↻ Revert to Auto</button>
  </div><div class="dirty" id="dirty"></div></div>
</aside>
</main>
<div class="toast" id="toast"></div>
<script>
(() => {
  const root = document;
  const canvas = root.getElementById('chart');
  const ctx = canvas.getContext('2d');
  const els = Object.fromEntries(['symbol','meta','mark','chartTitle','ohlc','modePill','cycle','lowVal','lowTime','highVal','highTime','tp1Val','alertVal','oneVal','goldVal','entryVal','zeroVal','goldLab','entryLab','metricLabel','impulse','tfStat','sourceStat','revStat','saveBtn','undoBtn','redoBtn','autoBtn','dirty','toast','dexTop','dexBottom','demoBadge'].map(id => [id, root.getElementById(id)]));
  const qs = new URLSearchParams(location.search);
  const isDemo = !qs.get('key');
  let data = null, candles = [], low = null, high = null, alertValue = null, dirty = false, dragging = null, history = [], future = [], activeTf = null;
  let plot = null;

  const fmt = n => {
    n = Number(n); if (!Number.isFinite(n)) return '—';
    const a=Math.abs(n); if(a>=1e9)return '$'+(n/1e9).toFixed(2)+'B'; if(a>=1e6)return '$'+(n/1e6).toFixed(2)+'M'; if(a>=1e3)return '$'+(n/1e3).toFixed(1)+'K'; if(a>=1)return '$'+n.toFixed(2); return '$'+n.toPrecision(3);
  };
  const ftime = t => new Date(Number(t)).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const levels = () => {
    if(!low||!high) return null; const r=high.v-low.v, gr=data.ratios.goldenUpper, er=data.ratios.entry;
    const tp1=low.v+r*1.618; return {zero:low.v,entry:low.v+r*er,gold:low.v+r*gr,one:high.v,tp1};
  };
  function snapshot(){return {low:{...low},high:{...high},alertValue};}
  function pushHistory(){if(low&&high){history.push(snapshot()); if(history.length>50)history.shift(); future=[];}}
  function restore(s){low={...s.low};high={...s.high};alertValue=s.alertValue;dirty=true;sync();draw();}
  function setDirty(v=true){dirty=v;els.dirty.textContent=v?(data?.demo?'Demo changes only — nothing will be saved':'Unsaved manual changes'):'';els.saveBtn.disabled=!data||!v||!!data?.demo;els.undoBtn.disabled=!history.length;els.redoBtn.disabled=!future.length;}
  function toast(msg){els.toast.textContent=msg;els.toast.classList.add('show');setTimeout(()=>els.toast.classList.remove('show'),3200);}
  function api(path, extra=''){const p=new URLSearchParams(qs); if(extra){const e=new URLSearchParams(extra); for(const [k,v] of e)p.set(k,v);} return path+'?'+p.toString();}

  function demoState(tf='5m'){
    const steps={ '1m':60_000,'5m':300_000,'15m':900_000,'1h':3_600_000,'4h':14_400_000 };
    const step=steps[tf]||steps['5m'];
    const count=156;
    const end=Math.floor((Date.now()-step)/step)*step;
    const start=end-step*(count-1);
    const candles=[];
    const swingLow=108000;
    const swingHigh=548000;
    const redTag=swingLow+(swingHigh-swingLow)*0.236; // exact 0.236 touch

    const path=i=>{
      if(i<18) return 142000-(i*1650);                            // quiet pre-launch
      if(i<=48) return 112000+(i-18)*(436000/30);                // impulse to high
      if(i<=61) return 548000-(i-48)*(76000/13);                 // first pullback
      if(i<=70) return 472000+(i-61)*(52000/9);                  // lower-high bounce
      if(i<=91) return 524000-(i-70)*((524000-redTag)/21);       // deep retrace to 0.236
      if(i<=113) return redTag+(i-91)*((442000-redTag)/22);      // reaction off red line
      if(i<=130) return 442000+(i-113)*(98000/17);               // continuation
      if(i<=144) return 540000-(i-130)*(126000/14);              // cool-off
      return 414000+(i-144)*(26000/11);                          // current recovery
    };

    let prev=139000;
    for(let i=0;i<count;i++){
      const base=path(i);
      const micro=(Math.sin(i*1.37)*4300)+(Math.sin(i*.43)*2700);
      let close=base+micro;
      let open=i===0?base-1800:prev;
      // Keep bodies modest so the chart reads like exchange candles, not bars.
      const maxBody=Math.max(4500,base*.026);
      if(Math.abs(close-open)>maxBody) close=open+Math.sign(close-open)*maxBody;
      const wickBase=2800+Math.abs(Math.sin(i*.77))*6200;
      let high=Math.max(open,close)+wickBase*(.72+Math.abs(Math.sin(i*.31))*.45);
      let low=Math.max(1000,Math.min(open,close)-wickBase*(.65+Math.abs(Math.cos(i*.29))*.38));

      if(i===18){low=swingLow; open=Math.max(open,swingLow+5000); close=Math.max(close,swingLow+9000);}
      if(i===48){high=swingHigh; close=Math.min(close,swingHigh-6500);}
      if(i===91){
        low=redTag;
        open=redTag+18500;
        close=redTag+11800;
        high=Math.max(high,open+7200);
      }

      // Never let non-anchor noise steal the selected swing extremes.
      if(i!==18&&i<48) low=Math.max(low,swingLow+2500);
      if(i!==48) high=Math.min(high,swingHigh-1800);
      if(i>48&&i!==91) low=Math.max(low,redTag+2600);

      const volume=
        15000+
        Math.abs(Math.sin(i*.39))*26000+
        (i>=18&&i<=52?46000:0)+
        (i>=86&&i<=95?27000:0)+
        (i>=112&&i<=132?18000:0);
      candles.push({t:start+i*step,o:open,h:high,l:low,c:close,v:volume});
      prev=close;
    }

    const lowC=candles[18], highC=candles[48], last=candles[candles.length-1];
    return {
      demo:true,
      key:'demo',
      symbol:'ORBIT',
      name:'Golden Pocket Demo',
      chain:'robinhood',
      address:'0xDEMO00000000000000000000000000000000FIB',
      dexUrl:null,
      cycleId:2,
      status:'armed',
      mode:'standard',
      timeframe:tf,
      fibTimeframe:tf,
      metric:'marketCap',
      anchorSource:'auto',
      anchorRevision:1,
      anchors:{low:{t:lowC.t,v:swingLow},high:{t:highC.t,v:swingHigh}},
      levels:null,
      targets:null,
      takeProfitAlert:null,
      lastValue:last.c,
      ratios:{goldenUpper:0.382,goldenLower:0.236,entry:0.236},
      candles
    };
  }

  function setTimeframeBusy(busy){
    root.querySelectorAll('.tf').forEach(b=>{ b.disabled=busy; });
  }

  async function load(tf){
    els.saveBtn.disabled=true;
    setTimeframeBusy(true);
    activeTf=tf||activeTf||qs.get('tf')||(isDemo?'5m':null);
    let j;
    if(isDemo){
      j=demoState(activeTf||'5m');
    }else{
      const extra=activeTf?'tf='+encodeURIComponent(activeTf):'';
      const res=await fetch(api('/api/fib-editor/state',extra),{cache:'no-store'});
      j=await res.json(); if(!res.ok) throw new Error(j.error||'load_failed');
    }
    data=j; candles=j.candles||[]; activeTf=j.timeframe;
    low={...j.anchors.low}; high={...j.anchors.high};
    const lv=levels(); alertValue=Number(j.takeProfitAlert?.value); if(!Number.isFinite(alertValue))alertValue=lv.tp1;
    history=[];future=[];setDirty(false);renderMeta();sync();resize();draw();
    root.querySelectorAll('.tf').forEach(b=>{
      const on=b.dataset.tf===activeTf;
      b.classList.toggle('active',on);
      b.setAttribute('aria-pressed',on?'true':'false');
    });
    setTimeframeBusy(false);
    els.autoBtn.disabled=!!j.demo;
    if(j.demo){
      els.saveBtn.textContent='Open from Discord to Save';
      els.demoBadge.classList.add('show');
    }
  }

  function renderMeta(){
    els.symbol.textContent=data.symbol; els.mark.textContent=(data.symbol||'TP').slice(0,2).toUpperCase();
    els.meta.textContent=data.demo?'PUBLIC DEMO · drag the Fib anchors and Take Profit alert':(data.chain||'').toUpperCase()+' · '+String(data.address||'').slice(0,12)+'…'+String(data.address||'').slice(-6);
    els.chartTitle.textContent=data.symbol+' · '+activeTf+' ('+(data.metric==='price'?'Price':'Market Cap')+')';
    const manual=(data.anchorSource||'auto')==='manual'; els.modePill.textContent=data.demo?'DEMO':(manual?'MANUAL':'AUTO'); els.modePill.classList.toggle('manual',manual||data.demo);
    els.cycle.textContent='Cycle #'+data.cycleId; els.metricLabel.textContent='('+(data.metric==='price'?'Price':'Market Cap')+')';
    els.tfStat.textContent=activeTf; els.sourceStat.textContent=data.demo?'DEMO / AUTO':(manual?'MANUAL':'AUTO (ATR)'); els.revStat.textContent=String(data.anchorRevision||1);
    if(data.dexUrl){els.dexTop.href=data.dexUrl;els.dexTop.hidden=false;els.dexBottom.href=data.dexUrl}else{els.dexBottom.style.display='none'}
  }
  function sync(){
    const lv=levels(); if(!lv)return;
    alertValue=Math.max(high.v,Math.min(lv.tp1,Number(alertValue)||lv.tp1));
    els.lowVal.textContent=fmt(low.v);els.lowTime.textContent=ftime(low.t);els.highVal.textContent=fmt(high.v);els.highTime.textContent=ftime(high.t);
    els.tp1Val.textContent=fmt(lv.tp1);els.alertVal.textContent=fmt(alertValue);els.oneVal.textContent=fmt(high.v);els.goldVal.textContent=fmt(lv.gold);els.entryVal.textContent=fmt(lv.entry);els.zeroVal.textContent=fmt(low.v);
    els.goldLab.textContent=String(data.ratios.goldenUpper)+' (Golden)';els.entryLab.textContent=String(data.ratios.entry)+' (Entry)';
    els.impulse.textContent=fmt(low.v)+' → '+fmt(high.v)+' ('+(high.v/low.v).toFixed(2)+'x)';
    setDirty(dirty);
  }

  function resize(){
    const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(r.width*d);canvas.height=Math.round(r.height*d);ctx.setTransform(d,0,0,d,0,0);
  }
  function idxForTime(t){let best=0,dist=Infinity;candles.forEach((c,i)=>{const d=Math.abs(c.t-t);if(d<dist){dist=d;best=i}});return best}
  function draw(){
    const W=canvas.clientWidth,H=canvas.clientHeight;if(!W||!H||!candles.length||!low||!high)return;
    ctx.clearRect(0,0,W,H);ctx.fillStyle='#03070a';ctx.fillRect(0,0,W,H);
    const left=22,right=90,top=56,volH=76,bottom=28,gap=10,ph=H-top-volH-bottom-gap,pw=W-left-right;
    const lv=levels(); let ymin=Math.min(...candles.map(c=>c.l),low.v),ymax=Math.max(...candles.map(c=>c.h),lv.tp1);
    let pad=(ymax-ymin)*.07||1;ymin=Math.max(0,ymin-pad);ymax+=pad;
    const X=i=>left+(i+.5)*pw/candles.length,Y=v=>top+ph-(v-ymin)/(ymax-ymin)*ph, V=y=>ymin+(top+ph-y)/ph*(ymax-ymin);
    plot={left,right,top,volH,bottom,gap,ph,pw,X,Y,V,ymin,ymax};
    ctx.strokeStyle='#10202a';ctx.lineWidth=1;ctx.font='11px system-ui';ctx.fillStyle='#718392';
    for(let g=0;g<=5;g++){const y=top+ph*g/5;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(left+pw,y);ctx.stroke();const v=ymax-(ymax-ymin)*g/5;ctx.fillText(fmt(v),left+pw+8,y+4)}
    for(let g=0;g<=7;g++){const x=left+pw*g/7;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+ph);ctx.stroke()}
    const maxV=Math.max(...candles.map(c=>c.v||0),1);
    const slot=pw/candles.length;
    const cw=Math.max(1.8,Math.min(7.2,slot*.58));
    candles.forEach((c,i)=>{
      const x=X(i),up=c.c>=c.o;
      const col=up?'#17c89a':'#ef5365';
      const yo=Y(c.o),yc=Y(c.c),yh=Y(c.h),yl=Y(c.l);
      ctx.save();
      ctx.strokeStyle=col;ctx.fillStyle=col;ctx.lineWidth=Math.max(1,Math.min(1.35,slot*.13));
      ctx.beginPath();ctx.moveTo(Math.round(x)+.5,yh);ctx.lineTo(Math.round(x)+.5,yl);ctx.stroke();
      const bodyTop=Math.min(yo,yc),bodyH=Math.max(1.4,Math.abs(yo-yc));
      ctx.fillRect(Math.round(x-cw/2),bodyTop,Math.max(1,Math.round(cw)),bodyH);
      const vh=Math.sqrt((c.v||0)/maxV)*volH;
      ctx.globalAlpha=.32;
      ctx.fillRect(Math.round(x-cw/2),top+ph+gap+volH-vh,Math.max(1,Math.round(cw)),vh);
      ctx.restore();
    });
    const line=(v,col,label,w=1.3,dash=[])=>{const y=Y(v);ctx.save();ctx.strokeStyle=col;ctx.lineWidth=w;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(left+pw,y);ctx.stroke();ctx.setLineDash([]);ctx.font='700 12px system-ui';const text=label+'  '+fmt(v),tw=ctx.measureText(text).width+14;ctx.fillStyle='#071015';ctx.strokeStyle=col;ctx.lineWidth=1;roundRect(left+pw-tw-7,y-12,tw,23,5);ctx.fill();ctx.stroke();ctx.fillStyle=col;ctx.fillText(text,left+pw-tw,y+4);ctx.restore()};
    // Fib reaction zones: red below 0.236, gold between 0.236 and 0.382.
    ctx.fillStyle='rgba(240,79,98,.055)';ctx.fillRect(left,Math.min(Y(lv.entry),Y(low.v)),pw,Math.abs(Y(lv.entry)-Y(low.v)));
    ctx.fillStyle='rgba(242,200,75,.085)';ctx.fillRect(left,Math.min(Y(lv.gold),Y(lv.entry)),pw,Math.abs(Y(lv.gold)-Y(lv.entry)));
    line(low.v,'#758693','0.0');line(lv.entry,'#f04f62',String(data.ratios.entry),1.6);line(lv.gold,'#f2c84b',String(data.ratios.goldenUpper),1.6);line(high.v,'#dbe5eb','1.0',1.4);
    // Movable notification trigger is separate from the Fib extension. Draw it first
    // so the fixed 1.618 remains visually dominant when both start at the same price.
    line(alertValue,'#52d7ff','TAKE PROFIT ALERT',2,[7,5]);
    line(lv.tp1,'#4cff78','1.618',2.8);

    // When the notification starts exactly on 1.618, keep the green Fib line dominant
    // but expose a cyan grab-tab beneath it so the user can pull the alert downward.
    const ay=Y(alertValue),ty=Y(lv.tp1),overlap=Math.abs(ay-ty)<9;
    plot.alertHandle=null;
    if(overlap){
      const label='DRAG TP ALERT ↓';
      ctx.save();ctx.font='800 11px system-ui';
      const hw=ctx.measureText(label).width+20,hh=26,hx0=left+pw-hw-10,hy0=Math.min(top+ph-30,ay+9);
      ctx.strokeStyle='#52d7ff';ctx.fillStyle='#07151b';ctx.lineWidth=1.4;
      roundRect(hx0,hy0,hw,hh,6);ctx.fill();ctx.stroke();
      ctx.beginPath();ctx.moveTo(hx0+hw/2,ay+1);ctx.lineTo(hx0+hw/2,hy0);ctx.stroke();
      ctx.fillStyle='#52d7ff';ctx.fillText(label,hx0+10,hy0+17);ctx.restore();
      plot.alertHandle={x:hx0,y:hy0,w:hw,h:hh};
    }
    const li=idxForTime(low.t),hi=idxForTime(high.t),lx=X(li),ly=Y(low.v),hx=X(hi),hy=Y(high.v);
    ctx.save();ctx.strokeStyle='#9aa8b3';ctx.setLineDash([6,6]);ctx.beginPath();ctx.moveTo(lx,ly);ctx.lineTo(hx,hy);ctx.stroke();ctx.setLineDash([]);[[lx,ly],[hx,hy]].forEach(([x,y])=>{ctx.fillStyle='#071015';ctx.strokeStyle='#f2c84b';ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.fill();ctx.stroke()});ctx.restore();
    // Current value
    if(Number.isFinite(Number(data.lastValue))){const v=Number(data.lastValue);ctx.strokeStyle='#b8ff00';ctx.setLineDash([2,4]);ctx.beginPath();ctx.moveTo(left,Y(v));ctx.lineTo(left+pw,Y(v));ctx.stroke();ctx.setLineDash([])}
    // x labels
    ctx.fillStyle='#6e8190';ctx.font='11px system-ui';ctx.textAlign='center';for(let k=0;k<=5;k++){const i=Math.round(k*(candles.length-1)/5);ctx.fillText(new Date(candles[i].t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),X(i),H-9)}ctx.textAlign='left';
    const last=candles[candles.length-1];els.ohlc.innerHTML='O '+fmt(last.o)+' &nbsp; H <strong>'+fmt(last.h)+'</strong> &nbsp; L '+fmt(last.l)+' &nbsp; C <strong>'+fmt(last.c)+'</strong>';
    function roundRect(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath()}
  }

  function pointerPos(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
  canvas.addEventListener('pointerdown',e=>{if(!plot||!data)return;const p=pointerPos(e),li=idxForTime(low.t),hi=idxForTime(high.t),d=(x,y)=>Math.hypot(p.x-x,p.y-y),h=plot.alertHandle;const onAlertHandle=h&&p.x>=h.x-8&&p.x<=h.x+h.w+8&&p.y>=h.y-8&&p.y<=h.y+h.h+8;if(d(plot.X(li),plot.Y(low.v))<18)dragging='low';else if(d(plot.X(hi),plot.Y(high.v))<18)dragging='high';else if(onAlertHandle||Math.abs(p.y-plot.Y(alertValue))<14)dragging='alert';else return;pushHistory();canvas.setPointerCapture(e.pointerId);e.preventDefault()});
  canvas.addEventListener('pointermove',e=>{if(!dragging||!plot)return;const p=pointerPos(e);if(dragging==='alert'){const lv=levels();alertValue=Math.max(high.v,Math.min(lv.tp1,plot.V(p.y)))}else{let i=Math.round((p.x-plot.left)/plot.pw*candles.length-.5);i=Math.max(0,Math.min(candles.length-1,i));const c=candles[i];if(dragging==='low'&&c.t<high.t)low={t:c.t,v:c.l};if(dragging==='high'&&c.t>low.t&&c.h>low.v)high={t:c.t,v:c.h};const lv=levels();alertValue=Math.max(high.v,Math.min(lv.tp1,alertValue))}dirty=true;sync();draw();e.preventDefault()});
  canvas.addEventListener('pointerup',e=>{dragging=null;try{canvas.releasePointerCapture(e.pointerId)}catch{}});
  canvas.addEventListener('pointercancel',()=>dragging=null);

  root.getElementById('tfs').addEventListener('click',e=>{
    const b=e.target.closest('.tf');
    if(!b||b.disabled||b.dataset.tf===activeTf)return;
    load(b.dataset.tf).catch(err=>{setTimeframeBusy(false);toast('Could not load timeframe: '+err.message)});
  });
  els.undoBtn.addEventListener('click',()=>{if(!history.length)return;future.push(snapshot());restore(history.pop())});
  els.redoBtn.addEventListener('click',()=>{if(!future.length)return;history.push(snapshot());restore(future.pop())});
  els.saveBtn.addEventListener('click',async()=>{if(data?.demo){toast('Demo mode does not change the bot. Use Adjust Fib from a Discord card to save.');return;}els.saveBtn.disabled=true;els.saveBtn.textContent='Saving…';try{const res=await fetch(api('/api/fib-editor/save'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({timeframe:activeTf,lowT:low.t,highT:high.t,takeProfitValue:alertValue})});const j=await res.json();if(!res.ok)throw new Error(j.error||'save_failed');data.anchorSource='manual';data.anchorRevision=(data.anchorRevision||1)+1;renderMeta();setDirty(false);toast(j.queued?'Saved — bot will apply it on the next poll.':'Manual pull + Take Profit alert saved.')}catch(err){toast('Save failed: '+err.message);setDirty(true)}finally{els.saveBtn.textContent='✓ Save Pull + Alert';els.saveBtn.disabled=!dirty}});
  els.autoBtn.addEventListener('click',async()=>{if(data?.demo){toast('Demo mode only. Live Revert to Auto is available from a signed Discord link.');return;}if(!confirm('Revert this cycle to fresh automatic Fib detection?'))return;els.autoBtn.disabled=true;try{const res=await fetch(api('/api/fib-editor/auto'),{method:'POST'});const j=await res.json();if(!res.ok)throw new Error(j.error||'auto_failed');toast(j.queued?'Auto re-detection queued.':'Reverted to auto detection.');setTimeout(()=>location.reload(),1200)}catch(err){toast('Could not revert: '+err.message);els.autoBtn.disabled=false}});
  addEventListener('resize',()=>{resize();draw()});
  load(qs.get('tf')||null).catch(err=>{setTimeframeBusy(false);toast('Editor could not load: '+err.message);els.symbol.textContent='Fib editor unavailable';els.meta.textContent=err.message});
})();
</script>
</body></html>`;
}
