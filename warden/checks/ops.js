import {
  HEARTBEAT_FAIL_MS,
  POLL_STALE_MULT,
  DEPLOY_WINDOW_MS,
} from '../config.js';

export function createOpsState() {
  return {
    statusFailSince: null,
    wasDown: false,
    perfFailStreak: 0,
    scheduledSolHistory: [],
    scheduledRhHistory: [],
    alertsBaseline: [],
    deploySha: null,
    deployWindowUntil: 0,
    criticalsToday: 0,
  };
}

function pushRolling(arr, val, max = 24 * 60) {
  arr.push(val);
  while (arr.length > max) arr.shift();
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function inDeployWindow(state) {
  return Date.now() < state.deployWindowUntil;
}

export function noteDeploy(state, gitSha) {
  if (!gitSha || gitSha === state.deploySha) return;
  state.deploySha = gitSha;
  state.deployWindowUntil = Date.now() + DEPLOY_WINDOW_MS;
}

export function checkHeartbeat(status, state, raise) {
  const now = Date.now();
  if (!status) {
    if (!state.statusFailSince) state.statusFailSince = now;
    if (now - state.statusFailSince >= HEARTBEAT_FAIL_MS) {
      raise('C9', 'CRITICAL', 'global', 'Bot /warden/status unreachable for 3+ minutes');
      state.wasDown = true;
    }
    return;
  }
  state.statusFailSince = null;

  if (state.wasDown && status.lastCycleAt) {
    state.wasDown = false;
    return { recovered: true };
  }

  const pollMs = status.pollIntervalMs || 180_000;
  if (status.lastCycleAt && now - status.lastCycleAt > pollMs * POLL_STALE_MULT) {
    raise('C9', 'CRITICAL', 'global', 'lastCycleAt stale — bot down or poll loop stuck', {
      lastCycleAt: status.lastCycleAt,
      ageSec: Math.round((now - status.lastCycleAt) / 1000),
    });
  }
  return {};
}

export function checkPerformance(status, state, raise) {
  if (!status) return;
  let fail = false;

  if (status.lastCycleMs > 120_000) fail = true;

  if (status.rate429Streak > 3) {
    raise('C10', 'WARN', 'global', 'rate429Streak elevated: ' + status.rate429Streak);
  }

  pushRolling(state.scheduledSolHistory, status.scheduledSol || 0);
  pushRolling(state.scheduledRhHistory, status.scheduledRh || 0);
  const medSol = median(state.scheduledSolHistory);
  const medRh = median(state.scheduledRhHistory);
  if (medSol > 5 && Math.abs((status.scheduledSol || 0) - medSol) / medSol > 0.3) fail = true;
  if (medRh > 5 && Math.abs((status.scheduledRh || 0) - medRh) / medRh > 0.3) fail = true;

  if (fail) {
    state.perfFailStreak += 1;
    const sev = state.perfFailStreak >= 3 ? 'CRITICAL' : 'WARN';
    raise('C10', sev, 'global', 'Performance regression (cycle slow or scheduled count anomaly)', {
      lastCycleMs: status.lastCycleMs,
      scheduledSol: status.scheduledSol,
      scheduledRh: status.scheduledRh,
      streak: state.perfFailStreak,
    });
  } else {
    state.perfFailStreak = 0;
  }
}

export function checkAlertVolume(status, state, raise) {
  if (!status) return;
  const today = new Date().toISOString().slice(0, 10);
  const hour = new Date().getUTCHours();
  pushRolling(state.alertsBaseline, status.alertsSentToday || 0, 7 * 24);

  const baseline = median(state.alertsBaseline.filter((v) => v > 0)) || 10;
  const vol = status.alertsSentToday || 0;
  const deployNote = inDeployWindow(state)
    ? 'spike within deploy window of `' + state.deploySha + '` — verify COMEBACK_SILENCE_CYCLES'
    : null;

  if (hour >= 20 && vol === 0 && baseline > 3) {
    raise('C11', 'WARN', 'global', 'Zero alerts by 20:00 UTC on a normal day — pipeline may be dead', {}, {
      deployNote,
    });
  }

  if (vol > baseline * 4 && baseline > 0) {
    const sev = inDeployWindow(state) ? 'WARN' : 'WARN';
    raise(
      'C11',
      sev,
      'global',
      inDeployWindow(state)
        ? 'Alert volume spike in deploy window (' + vol + ' vs baseline ~' + Math.round(baseline) + ')'
        : 'Alert volume >4× baseline (' + vol + ' vs ~' + Math.round(baseline) + ')',
      { volume: vol, baseline },
      { deployNote },
    );
  }
}

export function noteCritical(state) {
  state.criticalsToday += 1;
}
