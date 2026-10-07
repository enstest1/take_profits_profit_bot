/**
 * fib/engine.js — pure cycle state machine. No I/O, no Discord, no timers.
 *
 * Convention (matches the BasedBot/Photon chart the server uses):
 *   ratios are LOW-ANCHORED — 0 at swing low, 1 at swing high.
 *   fibValue(r) = low + (high − low) × r
 *
 * Alert flow (one cycle):
 *   DOWN:  golden-zone entry (≤ GOLDEN_UPPER, default 0.382) → mid levels (if any) → ENTRY
 *          (lowest ALERT_RATIOS, default 0.236 — instant wick + chart) → entry-held
 *          (CONFIRM_CLOSES consecutive 1m closes back above entry).
 *   UP  :  reclaim (back at swing high) → TP1 (low + 1.618 × range) → TP2 (high + 1.236 × (high − entry)).
 *   ANY :  1m close below swing low ⇒ invalidated.
 *
 * Idempotency: every alert fires at most once per cycleId; timestamps live in state.fired.
 * Trigger basis: standard mode confirms downward crossings with CONFIRM_CLOSES consecutive
 * 1m closes; fast mode fires on the live sample. Entry touch and all upward alerts are
 * instant in both modes. Gap-throughs sweep-fire skipped levels in order.
 */

import { FIB, fibValue } from './config.js';

const rkey = (r) => String(r);

export function initStateShell(mode = 'standard', timeframe = null, now = Date.now()) {
  return {
    enabled: true,
    mode,
    timeframe: timeframe || (mode === 'fast' ? FIB.FAST_TIMEFRAME : FIB.DEFAULT_TIMEFRAME),
    status: 'waiting_mcap',
    metric: null,
    supplyFactor: null,
    cycleId: 0,
    cycleStartedAt: null,
    anchors: null,
    anchorsReason: null,
    anchorSource: 'auto',
    anchorRevision: 0,
    levels: null,
    entryRatio: null,
    entryValue: null,
    targets: null,
    takeProfitAlert: null,
    lastManualAt: 0,
    // Telegram-only Golden Pocket mode. evaluate.js enables this only for
    // /goldenpocket-attached Telegram tokens; Discord leaves it false.
    telegramGoldenPocket: false,
    pocketConfirmCount: 0,
    pocketBypassedAt: null,
    fired: null,
    pending: null,
    heldCount: 0,
    lastValue: null,
    lastValueAt: null,
    nextDetectAt: 0,
    detectFails: 0,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
}

export function recomputeDerived(state) {
  const { low, high } = state.anchors;
  const levels = {
    goldenUpper: fibValue(low.v, high.v, FIB.GOLDEN_UPPER),
    goldenLower: fibValue(low.v, high.v, FIB.GOLDEN_LOWER),
    alerts: {},
  };
  for (const r of FIB.ALERT_RATIOS) levels.alerts[rkey(r)] = fibValue(low.v, high.v, r);
  const entryRatio = Math.min(...FIB.ALERT_RATIOS);
  const entryValue = levels.alerts[rkey(entryRatio)];
  state.levels = levels;
  state.entryRatio = entryRatio;
  state.entryValue = entryValue;
  state.targets = FIB.TARGETS_ENABLED
    ? {
        tp1: low.v + (high.v - low.v) * 1.618,
        tp2: high.v + 1.236 * (high.v - entryValue),
      }
    : null;

  // The visible 1.618 extension is always preserved. By default it is also the
  // notification trigger; the web editor may move only the notification line.
  if (state.targets && state.takeProfitAlert?.customized !== true) {
    state.takeProfitAlert = {
      value: state.targets.tp1,
      customized: false,
      armedAt: state.takeProfitAlert?.armedAt || null,
      firedAt: state.takeProfitAlert?.firedAt || null,
    };
  }
}

function freshFired() {
  const fired = { golden: null, alerts: {}, entryHeld: null, reclaim: null, takeProfit: null, tp1: null, tp2: null, invalidated: null };
  for (const r of FIB.ALERT_RATIOS) fired.alerts[rkey(r)] = null;
  return fired;
}

function anyDownFired(state) {
  if (!state.fired) return false;
  if (state.fired.golden) return true;
  for (const k of Object.keys(state.fired.alerts || {})) if (state.fired.alerts[k]) return true;
  return false;
}

/** Ordered downward checkpoints, highest value first: golden zone entry, then each alert ratio. */
function downLevels(state) {
  const out = [{ key: 'golden', value: state.levels.goldenUpper, ratio: FIB.GOLDEN_UPPER }];
  const ratios = Object.keys(state.levels.alerts)
    .map(Number)
    .sort((a, b) => b - a);
  for (const r of ratios) out.push({ key: rkey(r), value: state.levels.alerts[rkey(r)], ratio: r });
  return out;
}

function isFired(state, key) {
  return key === 'golden' ? !!state.fired.golden : !!state.fired.alerts[key];
}

function markFired(state, key, now) {
  if (key === 'golden') state.fired.golden = now;
  else state.fired.alerts[key] = now;
}

function eventFor(state, lvl, value, now) {
  if (lvl.key === 'golden') {
    return { kind: 'golden', value, level: state.levels.goldenUpper, lower: state.levels.goldenLower, at: now };
  }
  if (lvl.ratio === state.entryRatio) {
    return { kind: 'entry_touch', ratio: lvl.ratio, value, level: lvl.value, at: now };
  }
  return { kind: 'level', ratio: lvl.ratio, value, level: lvl.value, at: now };
}

/**
 * Fire `lvl` plus every unfired level ABOVE it (gap sweep), in top-down order.
 * Used for instant fires (fast mode, entry touch, arm-time deepest).
 */
function sweepFireDownTo(state, lvl, value, now, events) {
  for (const L of downLevels(state)) {
    if (L.value < lvl.value) break;
    // Telegram's 0.382 pre-buy is confirmation-based. A fast move straight to
    // 0.236 must NOT synthesize a pre-buy alert on the way through.
    if (state.telegramGoldenPocket && L.key === 'golden') {
      if (state.pending) delete state.pending.golden;
      continue;
    }
    if (isFired(state, L.key)) continue;
    markFired(state, L.key, now);
    if (state.pending) delete state.pending[L.key];
    events.push(eventFor(state, L, value, now));
    if (L.ratio === state.entryRatio) {
      state.status = 'target_mode';
      state.heldCount = 0;
      state.pocketConfirmCount = 0;
      if (state.telegramGoldenPocket && !state.fired.golden) state.pocketBypassedAt = now;
    }
  }
}

/** Arm a new cycle from detector output. Returns arm-time events per FIB.ALERT_ON_ARM. */
export function armCycle(state, det, currentValue, now = Date.now()) {
  state.anchors = { low: { v: det.low.v, t: det.low.t }, high: { v: det.high.v, t: det.high.t } };
  state.anchorsReason = det.reason;
  state.anchorSource = 'auto';
  state.anchorRevision = 1;
  state.takeProfitAlert = null;
  state.cycleId = (state.cycleId || 0) + 1;
  state.cycleStartedAt = now;
  state.fired = freshFired();
  state.pending = {};
  state.heldCount = 0;
  state.pocketConfirmCount = 0;
  state.pocketBypassedAt = null;
  state.status = 'armed';
  state.detectFails = 0;
  state.lastError = null;
  state.updatedAt = now;
  recomputeDerived(state);

  const events = [];
  if (currentValue == null || !Number.isFinite(currentValue)) return events;

  // Telegram Golden Pocket never announces 0.382 at arm time. It must earn the
  // pre-buy card via two completed 5m closes. If the cycle arms already through
  // 0.236, emit only the main entry signal.
  if (state.telegramGoldenPocket) {
    if (currentValue <= state.entryValue) {
      const entry = downLevels(state).find((L) => L.ratio === state.entryRatio);
      if (entry) sweepFireDownTo(state, entry, currentValue, now, events);
    }
    return events;
  }

  // Silently mark levels the price has ALREADY passed, then optionally announce the deepest zone.
  if (FIB.ALERT_ON_ARM === 'deepest') {
    let deepest = null;
    for (const L of downLevels(state)) {
      if (currentValue <= L.value) deepest = L;
    }
    if (deepest) {
      // golden counts as "in the zone" only while above goldenLower; below that it was just passed.
      if (deepest.key === 'golden' && currentValue < state.levels.goldenLower) {
        markFired(state, 'golden', now); // passed through silently
      } else {
        // mark everything above deepest silently, announce deepest (entry sweep announces all)
        if (deepest.ratio === state.entryRatio) {
          sweepFireDownTo(state, deepest, currentValue, now, events);
        } else {
          for (const L of downLevels(state)) {
            if (L.value <= deepest.value) break;
            markFired(state, L.key, now);
          }
          markFired(state, deepest.key, now);
          events.push(eventFor(state, deepest, currentValue, now));
        }
      }
    }
  } else {
    for (const L of downLevels(state)) {
      if (currentValue <= L.value) markFired(state, L.key, now);
    }
    if (currentValue <= state.entryValue) {
      state.status = 'target_mode';
      state.heldCount = 0;
    }
  }
  return events;
}

/**
 * Replace the detector's anchors with an explicit manual pull from the web editor.
 * The cycle id is preserved; anchorRevision increments. Existing entry context is
 * carried forward so a correction after entry does not pretend the trade never armed.
 */
export function applyManualAnchors(state, override, currentValue, now = Date.now()) {
  if (!state || !override?.low || !override?.high) return state;
  const lowV = Number(override.low.v);
  const highV = Number(override.high.v);
  const lowT = Number(override.low.t);
  const highT = Number(override.high.t);
  if (!(lowV > 0) || !(highV > lowV) || !Number.isFinite(lowT) || !Number.isFinite(highT) || lowT >= highT) {
    throw new Error('invalid manual anchors');
  }

  const hadEntry =
    state.status === 'target_mode' ||
    !!state.fired?.alerts?.[rkey(state.entryRatio)];

  state.anchors = {
    low: { v: lowV, t: lowT },
    high: { v: highV, t: highT },
  };
  state.anchorsReason = override.reason || 'manual web editor';
  state.anchorSource = 'manual';
  state.anchorRevision = (state.anchorRevision || 1) + 1;
  state.lastManualAt = Number(override.at) || now;
  if (override.timeframe) state.timeframe = override.timeframe;
  state.fired = freshFired();
  state.pending = {};
  state.heldCount = 0;
  state.pocketConfirmCount = 0;
  state.pocketBypassedAt = null;
  state.status = 'armed';
  state.takeProfitAlert = null;
  state.updatedAt = now;
  recomputeDerived(state);

  if (state.targets) {
    const range = highV - lowV;
    const requested = Number(override.takeProfitValue);
    const chosen = Number.isFinite(requested)
      ? Math.max(highV, Math.min(state.targets.tp1, requested))
      : state.targets.tp1;
    const tolerance = Math.max(range * 0.001, state.targets.tp1 * 0.000001);
    state.takeProfitAlert = {
      value: chosen,
      customized: Math.abs(chosen - state.targets.tp1) > tolerance,
      armedAt: now,
      firedAt: null,
      // If the user drags the alert below the live price, send the Take Profit
      // card on the next poll instead of waiting for price to dip and re-cross.
      forceOnNextTick:
        currentValue != null &&
        Number.isFinite(currentValue) &&
        currentValue >= chosen,
    };
  }

  if (hadEntry) {
    for (const L of downLevels(state)) {
      if (state.telegramGoldenPocket && L.key === 'golden') continue;
      markFired(state, L.key, now);
    }
    state.status = 'target_mode';
    state.pocketBypassedAt = now;
  } else if (currentValue != null && Number.isFinite(currentValue)) {
    for (const L of downLevels(state)) {
      if (state.telegramGoldenPocket && L.key === 'golden') continue;
      if (currentValue <= L.value) {
        markFired(state, L.key, now);
        if (L.ratio === state.entryRatio) {
          state.status = 'target_mode';
          state.pocketBypassedAt = now;
        }
      }
    }
  }

  if (state.status === 'target_mode' && currentValue != null && Number.isFinite(currentValue)) {
    if (currentValue >= state.anchors.high.v) state.fired.reclaim = now;
    if (state.targets && currentValue >= state.targets.tp1) state.fired.tp1 = now;
    if (state.targets && currentValue >= state.targets.tp2) {
      state.fired.tp2 = now;
      state.status = 'completed';
    }
  }

  return state;
}

/**
 * Live sample tick (every poll, ~15s). Mutates state, returns events.
 * prevValue = the lastValue persisted BEFORE this sample (caller passes it in).
 */
export function liveTick(state, prevValue, value, now = Date.now()) {
  const events = [];
  if (!state || value == null || !Number.isFinite(value)) return events;
  state.lastValue = value;
  state.lastValueAt = now;
  state.updatedAt = now;
  if (state.status !== 'armed' && state.status !== 'target_mode') return events;

  const high = state.anchors.high;

  // ---- upward: re-anchoring / new cycle (ARMED only — once the entry is touched the
  // trade plan is frozen: target_mode owns the upside via reclaim/TP1/TP2 below) ----
  if (state.anchorSource !== 'manual' && state.status === 'armed' && value > high.v) {
    const fired = anyDownFired(state);
    if (!fired) {
      // Impulse still forming — slide the top pin, keep the cycle.
      high.v = value;
      high.t = now;
      recomputeDerived(state);
      state.anchorsReason = (state.anchorsReason || '') + ' | high extended to live ' + value.toExponential(3);
    } else if (value > high.v * (1 + FIB.REANCHOR_THRESHOLD)) {
      events.push({ kind: 'new_cycle', value, at: now });
      return events; // caller flips status → detecting
    } else {
      high.v = value;
      high.t = now;
      recomputeDerived(state); // levels/targets track the new high; fired flags untouched
    }
  }

  // ---- upward: reclaim / take-profit targets (armed by entry touch) ----
  const entryFired = !!state.fired.alerts[rkey(state.entryRatio)];
  if (entryFired) {
    if (!state.fired.reclaim && value >= state.anchors.high.v) {
      state.fired.reclaim = now;
      events.push({ kind: 'reclaim', value, level: state.anchors.high.v, at: now });
    }
    if (state.targets) {
      const customTp =
        state.takeProfitAlert?.customized === true &&
        Number.isFinite(Number(state.takeProfitAlert.value))
          ? Number(state.takeProfitAlert.value)
          : null;

      if (
        customTp != null &&
        !state.fired.takeProfit &&
        value >= customTp &&
        (
          state.takeProfitAlert?.forceOnNextTick === true ||
          prevValue == null ||
          prevValue < customTp
        )
      ) {
        state.fired.takeProfit = now;
        state.takeProfitAlert.firedAt = now;
        state.takeProfitAlert.forceOnNextTick = false;
        events.push({
          kind: 'take_profit',
          value,
          level: customTp,
          fibTarget: state.targets.tp1,
          at: now,
        });
      }

      if (!state.fired.tp1 && value >= state.targets.tp1) {
        state.fired.tp1 = now;
        // If the editor moved the notification trigger, 1.618 remains a tracked
        // reference level but does not send a second take-profit card.
        if (customTp == null) {
          events.push({ kind: 'tp1', value, level: state.targets.tp1, at: now });
        }
      }
      if (!state.fired.tp2 && value >= state.targets.tp2) {
        state.fired.tp2 = now;
        events.push({ kind: 'tp2', value, level: state.targets.tp2, at: now });
        state.status = 'completed';
      }
    }
  }

  // ---- downward: crossings ----
  for (const lvl of downLevels(state)) {
    // Telegram's golden alert is handled only by telegramGoldenPocketClose()
    // on completed 5m sampled bars.
    if (state.telegramGoldenPocket && lvl.key === 'golden') continue;
    if (isFired(state, lvl.key)) continue;
    const nowBelow = value <= lvl.value;
    if (!nowBelow) continue;
    const freshCross = prevValue == null || prevValue > lvl.value;
    if (!freshCross) continue;

    if (lvl.ratio === state.entryRatio) {
      // ENTRY: instant on wick touch, both modes; sweep-fires any skipped levels above it first.
      sweepFireDownTo(state, lvl, value, now, events);
    } else if (state.mode === 'fast') {
      markFired(state, lvl.key, now);
      events.push(eventFor(state, lvl, value, now));
    } else if (state.pending[lvl.key] == null) {
      // standard: a fresh live cross arms bar-close confirmation
      state.pending[lvl.key] = 0;
    }
  }

  return events;
}

/**
 * Telegram Golden Pocket pre-buy confirmation.
 * Requires consecutive completed 5m closes inside 0.382 → 0.236.
 * If 0.236 has already been touched, the pre-buy stage is permanently bypassed.
 */
export function telegramGoldenPocketClose(state, closeValue, now = Date.now()) {
  const events = [];
  if (!state?.telegramGoldenPocket || closeValue == null || !Number.isFinite(closeValue)) return events;
  if (state.status !== 'armed' && state.status !== 'target_mode') return events;

  const entryFired = !!state.fired?.alerts?.[rkey(state.entryRatio)];
  if (entryFired || state.status === 'target_mode') {
    state.pocketConfirmCount = 0;
    if (!state.fired?.golden && !state.pocketBypassedAt) state.pocketBypassedAt = now;
    return events;
  }
  if (state.fired?.golden) return events;

  const upper = state.levels.goldenUpper;
  const lower = state.entryValue;
  const insidePocket = closeValue <= upper && closeValue > lower;

  if (!insidePocket) {
    state.pocketConfirmCount = 0;
    if (closeValue <= lower) state.pocketBypassedAt = now;
    state.updatedAt = now;
    return events;
  }

  state.pocketConfirmCount = (state.pocketConfirmCount || 0) + 1;
  state.updatedAt = now;
  if (state.pocketConfirmCount >= FIB.TG_PREBUY_CONFIRM_CLOSES) {
    state.fired.golden = now;
    state.pocketConfirmCount = 0;
    events.push({
      kind: 'golden_prebuy',
      value: closeValue,
      level: upper,
      lower,
      confirmCloses: FIB.TG_PREBUY_CONFIRM_CLOSES,
      confirmTimeframe: FIB.TG_PREBUY_TIMEFRAME,
      at: now,
    });
  }
  return events;
}

/**
 * Completed 1-minute bar tick. Handles: standard-mode confirmations, entry-held, invalidation.
 */
export function barClose(state, closeValue, now = Date.now()) {
  const events = [];
  if (!state || closeValue == null || !Number.isFinite(closeValue)) return events;
  if (state.status !== 'armed' && state.status !== 'target_mode') return events;

  // ---- invalidation: full round trip below the swing low ----
  if (closeValue < state.anchors.low.v) {
    state.fired.invalidated = now;
    state.status = 'invalidated';
    state.pending = {};
    state.updatedAt = now;
    events.push({ kind: 'invalidated', value: closeValue, level: state.anchors.low.v, at: now });
    return events;
  }

  // ---- standard-mode confirmations ----
  if (state.mode !== 'fast' && state.pending) {
    for (const lvl of downLevels(state)) {
      if (state.pending[lvl.key] == null || isFired(state, lvl.key)) continue;
      if (closeValue <= lvl.value) {
        state.pending[lvl.key] += 1;
        if (state.pending[lvl.key] >= FIB.CONFIRM_CLOSES) {
          delete state.pending[lvl.key];
          markFired(state, lvl.key, now);
          events.push(eventFor(state, lvl, closeValue, now));
        }
      } else {
        delete state.pending[lvl.key]; // recovered above the level — wick filtered out
      }
    }
  }

  // ---- entry-held: CONFIRM_CLOSES consecutive closes back ABOVE the entry level ----
  const entryFired = !!state.fired.alerts[rkey(state.entryRatio)];
  if (entryFired && !state.fired.entryHeld && state.status !== 'completed') {
    if (closeValue > state.entryValue) {
      state.heldCount = (state.heldCount || 0) + 1;
      if (state.heldCount >= FIB.CONFIRM_CLOSES) {
        state.fired.entryHeld = now;
        events.push({ kind: 'entry_held', value: closeValue, level: state.entryValue, at: now });
      }
    } else {
      state.heldCount = 0;
    }
  }

  state.updatedAt = now;
  return events;
}
