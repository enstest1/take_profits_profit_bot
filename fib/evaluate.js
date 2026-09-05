/**
 * fib/evaluate.js — drives one token's fib state through the machine each tick and
 * dispatches alerts. Two thin wrappers share one core:
 *
 *   evaluateFib(client, db, key, entry, live)   → integrated mode, called from
 *       poller.processTokenWithLive right after the other signals. State lives at
 *       entry.fib and is persisted by mutate + saveDB(db), exactly like signals/retest.js.
 *
 *   evaluateFibWatch(client, key, watch, live)  → independent watchlist, called from
 *       fib/watchLoop.js. State lives at db.fibWatch[key].fib and is persisted through
 *       store.updateFibWatch (synchronous load-mutate-save — see fib/store.js).
 *
 * Status flow:
 *   waiting_mcap → detecting → armed → target_mode → completed
 *                       ↑          ↘ invalidated ↗ (re-detects after DETECT_RETRY_MS)
 */

import { FIB, timeframeSpec } from './config.js';
import * as engine from './engine.js';
import * as bars from './minuteBars.js';
import { detectImpulse } from './swingDetector.js';
import { fetchCandles, resolveTopPool } from './geckoTerminal.js';
import { pairFromDexUrl, updateFibWatch } from './store.js';
import { buildFibEmbed, chartFileName } from './embeds.js';
import { renderFibChart } from './chartRender.js';
import { sendTokenAlert, sendChannelAlert } from '../channelAlert.js';
import { isCaMutedChannel } from '../caMuteChannels.js';
import { saveDB } from '../dbStore.js';

const inFlightDetect = new Set();

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function liveValueFor(state, mc, px) {
  if (state.metric === 'marketCap') {
    if (mc != null) return mc;
    if (px != null && state.supplyFactor) return px * state.supplyFactor;
    return null;
  }
  return px;
}

function detectorOpts(state) {
  const fast = state.mode === 'fast';
  return {
    minImpulsePct: FIB.MIN_IMPULSE_PCT,
    minCandles: fast ? FIB.MIN_CANDLES_FAST : FIB.MIN_CANDLES,
    pivotStrength: FIB.PIVOT_STRENGTH,
    reversalPct: FIB.REVERSAL_PCT,
    atrMult: FIB.ATR_MULT,
    goldenUpper: FIB.HIGH_CONFIRM_RATIO,
    anchorOrigin: FIB.ANCHOR_ORIGIN,
    launchFallback: fast,
  };
}

/** Fetch price candles for this token's pool and convert to the tracker's metric. */
async function metricCandles(ctx, state, { fresh = false } = {}) {
  if (!state.poolAddress) {
    const fromUrl = pairFromDexUrl(ctx.dexUrl);
    if (fromUrl) {
      state.poolAddress = fromUrl;
    } else {
      const r = await resolveTopPool(ctx.chainId, ctx.address);
      if (r.error) return { error: 'pool: ' + r.error };
      state.poolAddress = r.poolAddress;
    }
  }
  const r = await fetchCandles(ctx.chainId, state.poolAddress, state.timeframe, { fresh });
  if (r.error) {
    // A dexUrl-derived pool can be wrong (multi-pool tokens) — one retry via GT lookup.
    if (!state.poolResolvedViaGt) {
      const alt = await resolveTopPool(ctx.chainId, ctx.address);
      if (!alt.error && alt.poolAddress && alt.poolAddress !== state.poolAddress) {
        state.poolAddress = alt.poolAddress;
        state.poolResolvedViaGt = true;
        const r2 = await fetchCandles(ctx.chainId, state.poolAddress, state.timeframe, { fresh });
        if (!r2.error) return convert(r2.candles, state);
        return { error: 'candles: ' + r2.error };
      }
      state.poolResolvedViaGt = true;
    }
    return { error: 'candles: ' + r.error };
  }
  return convert(r.candles, state);

  function convert(candles, st) {
    if (st.metric !== 'marketCap' || !st.supplyFactor) return { candles };
    const f = st.supplyFactor;
    return {
      candles: candles.map((c) => ({ t: c.t, o: c.o * f, h: c.h * f, l: c.l * f, c: c.c * f, v: c.v })),
    };
  }
}

async function runDetection(ctx, state, mc, px, now) {
  // Metric decided once per cycle: market cap when we can derive it, else raw price.
  if (mc != null && px != null) {
    state.metric = 'marketCap';
    state.supplyFactor = mc / px;
  } else {
    state.metric = 'price';
    state.supplyFactor = null;
  }

  const got = await metricCandles(ctx, state);
  if (got.error) {
    state.detectFails = (state.detectFails || 0) + 1;
    state.lastError = got.error;
    state.nextDetectAt = now + FIB.DETECT_RETRY_MS;
    console.log('[fib] ' + ctx.symbol + ' detect: ' + got.error + ' (retry in ' + Math.round(FIB.DETECT_RETRY_MS / 60000) + 'm)');
    return [];
  }

  const det = detectImpulse(got.candles, detectorOpts(state));
  if (!det.ok) {
    state.detectFails = (state.detectFails || 0) + 1;
    state.lastError = det.error + ': ' + det.reason;
    state.nextDetectAt = now + FIB.DETECT_RETRY_MS;
    console.log('[fib] ' + ctx.symbol + ' detect: ' + det.reason);
    return [];
  }
  if (!det.highConfirmed) {
    state.lastError = 'awaiting high confirmation — ' + det.reason;
    const tfMs = timeframeSpec(state.timeframe).ms;
    state.nextDetectAt = now + Math.min(FIB.DETECT_RETRY_MS, tfMs);
    console.log('[fib] ' + ctx.symbol + ' detect: high not confirmed yet');
    return [];
  }

  const currentValue = liveValueFor(state, mc, px);
  const events = engine.armCycle(state, det, currentValue, now);
  bars.reset(ctx.key);
  console.log(
    '[fib] ' + ctx.symbol + ' armed cycle #' + state.cycleId + ' — low ' + det.low.v.toPrecision(4) +
    ' high ' + det.high.v.toPrecision(4) + ' | ' + det.reason,
  );
  return events;
}

/** Shared per-tick core. ctx: { key, chainId, address, symbol, name, dexUrl, send(embed, kind, files) } */
async function runFibTick(ctx, state, live, now = Date.now()) {
  if (!FIB.ENABLED || !state || state.enabled === false || state.status === 'paused') return false;

  const mc = num(live?.marketCap);
  const px = num(live?.price);
  let events = [];

  if (state.status === 'waiting_mcap') {
    if (mc != null && mc >= FIB.MIN_MCAP) {
      state.status = 'detecting';
      state.nextDetectAt = 0;
      state.updatedAt = now;
      console.log('[fib] ' + ctx.symbol + ' crossed ' + FIB.MIN_MCAP + ' mcap — detection scheduled');
    }
    return false;
  }

  const detectEligible = state.status === 'detecting' || state.status === 'invalidated' || state.status === 'completed';
  if (detectEligible) {
    if (now >= (state.nextDetectAt || 0) && !inFlightDetect.has(ctx.key)) {
      inFlightDetect.add(ctx.key);
      try {
        events = await runDetection(ctx, state, mc, px, now);
      } finally {
        inFlightDetect.delete(ctx.key);
      }
    }
  } else if (state.status === 'armed' || state.status === 'target_mode') {
    const value = liveValueFor(state, mc, px);
    if (value != null) {
      const prev = state.lastValue;
      events = engine.liveTick(state, prev, value, now);

      const closed = bars.update(ctx.key, value, now);
      if (closed) events = events.concat(engine.barClose(state, closed.c, now));

      const newCycle = events.find((e) => e.kind === 'new_cycle');
      if (newCycle) {
        events = events.filter((e) => e.kind !== 'new_cycle');
        state.status = 'detecting';
        state.nextDetectAt = now; // materially higher high → re-anchor a fresh cycle immediately
        console.log('[fib] ' + ctx.symbol + ' broke high by >' + FIB.REANCHOR_THRESHOLD * 100 + '% after alerts — new cycle');
      }
      if (state.status === 'invalidated' || state.status === 'completed') {
        state.nextDetectAt = now + FIB.DETECT_RETRY_MS;
      }
    }
  }

  if (!events.length) return false;

  let sentAny = false;
  for (const ev of events) {
    let files = null;
    if (ev.kind === 'entry_touch' && FIB.CHART_ENABLED) {
      try {
        const got = await metricCandles(ctx, state);
        if (!got.error) {
          const png = await renderFibChart({
            candles: got.candles,
            state,
            symbol: ctx.symbol,
            currentValue: ev.value,
          });
          if (png) files = [{ attachment: png, name: chartFileName(ctx.symbol) }];
        }
      } catch (e) {
        console.error('[fib/chart] ' + ctx.symbol + ':', e.message);
      }
    }
    const embed = buildFibEmbed(ev, state, ctx, !!files);
    const ok = await ctx.send(embed, 'fib_' + ev.kind, files);
    if (ok) {
      sentAny = true;
      console.log('[fib] ' + ctx.symbol + ' alert: ' + ev.kind + ' @ ' + (ev.value?.toPrecision?.(4) ?? ev.value));
    }
  }
  return sentAny;
}

/** Integrated mode — mirrors the signals/retest.js contract. */
export async function evaluateFib(client, db, storageKey, entry, live) {
  if (!FIB.ENABLED) return false;

  // Control flags written by /fibtrack (commands never touch db.tokens — see fibCommands.js).
  const ctl = db.fibWatch ? db.fibWatch[storageKey] : null;
  if (ctl?.suppress) return false;

  if (!entry.fib && FIB.AUTO) {
    entry.fib = engine.initStateShell('standard', FIB.DEFAULT_TIMEFRAME);
  }
  if (!entry.fib) return false;

  if (ctl?.recalcAt && ctl.recalcAt > (entry.fib.lastRecalcAt || 0)) {
    const mode = ctl.mode || entry.fib.mode;
    const tf = ctl.timeframe || entry.fib.timeframe;
    const shell = engine.initStateShell(mode, tf);
    shell.cycleId = entry.fib.cycleId || 0;
    shell.createdAt = entry.fib.createdAt || shell.createdAt;
    shell.status = 'detecting';
    shell.nextDetectAt = 0;
    shell.lastRecalcAt = ctl.recalcAt;
    entry.fib = shell;
    console.log('[fib] ' + (entry.symbol || storageKey) + ' recalculate applied (' + mode + '/' + tf + ')');
  }

  const ctx = {
    key: storageKey,
    chainId: (entry.chain || 'solana').toLowerCase(),
    address: entry.address || storageKey,
    symbol: entry.symbol || storageKey.slice(0, 8),
    name: entry.name || entry.symbol || 'Unknown',
    dexUrl: entry.dexUrl || live?.dexUrl || null,
    send: (embed, kind, files) => sendTokenAlert(client, db, storageKey, embed, kind, 'fib', files),
  };

  const before = JSON.stringify(entry.fib.fired) + entry.fib.status + entry.fib.cycleId + (entry.fib.nextDetectAt || 0);
  const sent = await runFibTick(ctx, entry.fib, live);
  const after = JSON.stringify(entry.fib.fired) + entry.fib.status + entry.fib.cycleId + (entry.fib.nextDetectAt || 0);
  if (sent || before !== after) saveDB(db);
  return sent;
}

/** Independent watchlist mode — state persisted via the synchronous fibWatch writer. */
export async function evaluateFibWatch(client, key, watch, live) {
  if (!FIB.ENABLED || !watch?.fib) return false;

  const ctx = {
    key,
    chainId: (watch.chain || 'solana').toLowerCase(),
    address: watch.address,
    symbol: watch.symbol || key.slice(0, 8),
    name: watch.name || watch.symbol || 'Unknown',
    dexUrl: watch.dexUrl || live?.dexUrl || null,
    send: (embed, kind, files) => {
      if (isCaMutedChannel(watch.alertChannelId)) {
        console.log('[ca-mute] skipped fib watch in ' + watch.alertChannelId);
        return false;
      }
      return sendChannelAlert(client, watch.alertChannelId, embed, 'fib', files);
    },
  };

  const snapshotRev = watch.rev || 0;
  const sent = await runFibTick(ctx, watch.fib, live);

  // Persist the evolved state (sync load-mutate-save; see store.js for why).
  // Optimistic lock: if a command bumped rev while this tick ran, its write wins.
  updateFibWatch((fw) => {
    if (fw[key] && (fw[key].rev || 0) === snapshotRev) fw[key].fib = watch.fib;
  });
  return sent;
}
